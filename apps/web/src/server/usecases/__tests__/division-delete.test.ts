// Division delete / archive / restore — v3/09 §4 (PROMPT-38). Graduated
// destructiveness: setup divisions hard-delete (entities that outlive the
// division survive), started/resulted divisions 409 with the archive hint,
// archive hides + frees quota + restores, purge honours the 30-day cool-off,
// and open registration blocks the destructive paths.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import {
  archiveDivision,
  createDivision,
  deleteDivision,
  listDivisions,
  restoreDivision,
} from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { scoreEvent } from "@/server/usecases/scoring";

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(plan: "community" | "pro" = "pro"): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Del " + suffix}, ${"del-" + suffix})
    returning id`;
  if (plan !== "community") {
    await sql`
      insert into subscriptions (org_id, plan_key, status)
      values (${orgId}, ${plan}, 'active')
      on conflict (org_id) do update set plan_key = ${plan}`;
  }
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  return { auth: { orgId, via: "session", userId: null, role: "owner", keyId: null } };
}

async function seedDivision(auth: AuthCtx, name = "Open") {
  const comp = await createCompetition(auth, {
    name: `Cup ${randomUUID().slice(0, 6)}`,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name,
    slug: `${name.toLowerCase()}-${randomUUID().slice(0, 6)}`,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  return { comp, division };
}

// A division with one DECIDED fixture (started → has results).
async function seedDecidedDivision(auth: AuthCtx) {
  const { comp, division } = await seedDivision(auth);
  const entrants = await createEntrants(auth, division.id, [
    { kind: "individual" as const, display_name: "A", seed: 1, members: [] },
    { kind: "individual" as const, display_name: "B", seed: 2, members: [] },
  ]);
  const list = Array.isArray(entrants) ? entrants : [entrants];
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, seq, kind, name) values (${division.id}, 1, 'league', 'League')
    returning id`;
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id)
    values (${stageId}, ${division.id}, 1, 1, ${list[0]!.id}, ${list[1]!.id})
    returning id`;
  await sql`update divisions set status = 'active' where id = ${division.id}`;
  await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
  await scoreEvent(auth, fixtureId, {
    expected_seq: 1,
    type: "generic.result",
    payload: { p1Score: 2, p2Score: 1 },
  });
  return { comp, division, fixtureId };
}

async function auditTypes(competitionId: string): Promise<string[]> {
  const rows = await sql<{ type: string }[]>`
    select type from competition_events where competition_id = ${competitionId} order by created_at`;
  return rows.map((r) => r.type);
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("division delete (v3/09 §4)", () => {
  it("hard-deletes a setup division; org-level entities survive; audit lands on the competition ledger", async () => {
    const { auth } = await seedOrg();
    const { comp, division } = await seedDivision(auth);
    // A person attached via an entrant member must outlive the division.
    const [{ id: personId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${auth.orgId}, 'Keeper') returning id`;
    const created = await createEntrants(auth, division.id, [
      {
        kind: "individual" as const,
        display_name: "Keeper",
        seed: 1,
        members: [{ person_id: personId, is_captain: false, roles: [] }],
      },
    ]);
    expect(created).toBeTruthy();

    await deleteDivision(auth, division.id);

    const [gone] = await sql`select 1 from divisions where id = ${division.id}`;
    expect(gone).toBeUndefined();
    const [person] = await sql`select 1 from persons where id = ${personId}`;
    expect(person).toBeTruthy();
    expect(await auditTypes(comp.id)).toContain("division_deleted");
  });

  it("409 DIVISION_HAS_RESULTS with the archive hint once results exist", async () => {
    const { auth } = await seedOrg();
    const { division } = await seedDecidedDivision(auth);
    try {
      await deleteDivision(auth, division.id);
      expect.unreachable("expected 409");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(409);
      expect((err as HttpError).code).toBe("DIVISION_HAS_RESULTS");
      expect((err as HttpError).extra).toEqual({ archive: true });
    }
    const [still] = await sql`select 1 from divisions where id = ${division.id}`;
    expect(still).toBeTruthy();
  });

  it("open registration blocks delete AND archive — the error says close first", async () => {
    const { auth } = await seedOrg();
    const { division } = await seedDivision(auth);
    await sql`
      insert into registration_settings (division_id, enabled)
      values (${division.id}, true)`;
    for (const action of [() => deleteDivision(auth, division.id), () => archiveDivision(auth, division.id)]) {
      try {
        await action();
        expect.unreachable("expected 409 REGISTRATION_OPEN");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).status).toBe(409);
        expect((err as HttpError).code).toBe("REGISTRATION_OPEN");
        expect((err as HttpError).message).toContain("close registration");
      }
    }
  });
});

describe.skipIf(!HAS_DB)("division archive / restore (v3/09 §4)", () => {
  it("archive hides from the console list, the public view, and frees the plan slot", async () => {
    // Pin the division quota at 1 via override — the test exercises the
    // freeing/restore arithmetic, not the (v3: 2) community number.
    const { auth } = await seedOrg("community");
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
      values (${auth.orgId}, 'divisions.per_competition.max', 1, 'test probe')`;
    const comp = await createCompetition(auth, {
      name: `Arch ${randomUUID().slice(0, 6)}`,
      visibility: "public",
      branding: {},
    });
    const division = await createDivision(auth, comp.id, {
      name: "First",
      slug: "first",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      eligibility: [],
    });

    // The community quota (1) is used up — a second division is 402-gated.
    await expect(
      createDivision(auth, comp.id, {
        name: "Second",
        slug: "second",
        sport_key: "generic",
        variant_key: "score",
        config: GENERIC_CONFIG,
        eligibility: [],
      }),
    ).rejects.toBeInstanceOf(PaymentRequiredError);

    const archived = await archiveDivision(auth, division.id);
    expect(archived.archived_at).not.toBeNull();

    // Console default list hides it; includeArchived shows it.
    expect(await listDivisions(auth, comp.id)).toHaveLength(0);
    expect(await listDivisions(auth, comp.id, { includeArchived: true })).toHaveLength(1);

    // Public view: archived divisions vanish (404 upstream).
    const pub = await sql`select 1 from public_divisions_v where id = ${division.id}`;
    expect(pub).toHaveLength(0);

    // Archiving freed the slot — the gate lifts (the honest behaviour).
    const second = await createDivision(auth, comp.id, {
      name: "Second",
      slug: "second",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      eligibility: [],
    });
    expect(second.id).toBeTruthy();

    // Restore would now exceed the quota again → 402, not a silent overflow.
    await expect(restoreDivision(auth, division.id)).rejects.toBeInstanceOf(PaymentRequiredError);

    // Free the slot and the restore round-trips.
    await deleteDivision(auth, second.id);
    const restored = await restoreDivision(auth, division.id);
    expect(restored.archived_at).toBeNull();
    expect(await auditTypes(comp.id)).toEqual(
      expect.arrayContaining(["division_archived", "division_deleted", "division_restored"]),
    );
  });

  it("a resulted division archives and restores with results intact", async () => {
    const { auth } = await seedOrg();
    const { comp, division, fixtureId } = await seedDecidedDivision(auth);
    await archiveDivision(auth, division.id);
    const restored = await restoreDivision(auth, division.id);
    expect(restored.archived_at).toBeNull();
    const [fixture] = await sql<{ status: string }[]>`
      select status from fixtures where id = ${fixtureId}`;
    expect(fixture.status).toBe("decided");
    expect(await auditTypes(comp.id)).toEqual(
      expect.arrayContaining(["division_archived", "division_restored"]),
    );
  });

  it("purge honours the 30-day cool-off, then hard-deletes with an audit event", async () => {
    const { auth } = await seedOrg();
    const { comp, division } = await seedDecidedDivision(auth);
    await archiveDivision(auth, division.id);

    // Too fresh: 409 ARCHIVE_COOL_OFF.
    try {
      await deleteDivision(auth, division.id);
      expect.unreachable("expected 409 cool-off");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).code).toBe("ARCHIVE_COOL_OFF");
    }

    // Backdate the archive 31 days → purge proceeds.
    await sql`
      update divisions set archived_at = now() - interval '31 days' where id = ${division.id}`;
    await deleteDivision(auth, division.id);
    const [gone] = await sql`select 1 from divisions where id = ${division.id}`;
    expect(gone).toBeUndefined();
    expect(await auditTypes(comp.id)).toContain("division_purged");
  });
});
