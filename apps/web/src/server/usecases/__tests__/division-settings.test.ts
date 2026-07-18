// v8 (spec 2026-07-13): division settings tab server contracts — logo
// columns round-trip through patch/get (V274), and the format becomes
// immutable once any stage owns fixtures (409 FORMAT_LOCKED), while
// non-format fields keep patching. Real Postgres; skipped without
// DATABASE_URL (same convention as registrations.test.ts).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision, getDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures, replaceStages } from "../stages";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOwner(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`v8-${suffix}@test.local`}, 'V8 Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"V8 Org " + suffix}, ${"v8-org-" + suffix}, ${userId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  await sql`insert into subscriptions (org_id, plan_key, status)
            values (${orgId}, 'pro', 'active')
            on conflict (org_id) do update set plan_key = 'pro', status = 'active'`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  for (const variant of ["score", "sets"]) {
    await sql`
      insert into sport_variants (sport_key, key, name, config, is_system)
      values ('generic', ${variant}, ${variant},
              ${sql.json({ resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false })},
              true)
      on conflict do nothing`;
  }
  return { orgId, via: "session", userId, role: "owner", keyId: null } as AuthCtx;
}

async function rig(owner: AuthCtx) {
  const competition = await createCompetition(owner, {
    name: "V8 Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
    starts_on: "2026-10-01",
    ends_on: "2026-10-02",
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    eligibility: [],
  });
  return { competition, division };
}

describe.skipIf(!HAS_DB)("division logo columns (V274)", () => {
  it("patch round-trips logo_storage_path and getDivision returns it", async () => {
    const owner = await seedOwner();
    const { division } = await rig(owner);

    const patched = await patchDivision(owner, division.id, {
      logo_storage_path: "division-logos/" + division.id + ".png",
    });
    expect(patched.logo_storage_path).toBe("division-logos/" + division.id + ".png");

    const fetched = await getDivision(owner, division.id);
    expect(fetched.logo_storage_path).toBe("division-logos/" + division.id + ".png");
    expect(fetched.logo_url).toBeNull();

    const cleared = await patchDivision(owner, division.id, { logo_storage_path: null });
    expect(cleared.logo_storage_path).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("format lock (v8)", () => {
  it("variant/config edits work until fixtures exist, then 409 FORMAT_LOCKED", async () => {
    const owner = await seedOwner();
    const { division } = await rig(owner);

    // Pre-fixtures: variant + config change lands (re-validated like create).
    const changed = await patchDivision(owner, division.id, {
      variant_key: "sets",
      config: { points: { w: 2, d: 1, l: 0 } },
    });
    expect(changed.variant_key).toBe("sets");
    expect((changed.config as { points: { w: number } }).points.w).toBe(2);

    // Generate a league schedule → the format is history.
    await createEntrants(owner, division.id, [
      { kind: "individual", display_name: "A", seed: 1, members: [] },
      { kind: "individual", display_name: "B", seed: 2, members: [] },
    ]);
    const [stage] = await createStages(owner, division.id, {
      seq: 1, kind: "league", name: "L", config: {},
    });
    await generateStageFixtures(owner, stage!.id);

    await expect(
      patchDivision(owner, division.id, { variant_key: "score" }),
    ).rejects.toMatchObject({ status: 409, code: "FORMAT_LOCKED" });

    // Non-format fields still patch while locked.
    const renamed = await patchDivision(owner, division.id, { name: "Open Renamed" });
    expect(renamed.name).toBe("Open Renamed");
  });

  it("rejects an unknown variant with 422 (create-time validation reused)", async () => {
    const owner = await seedOwner();
    const { division } = await rig(owner);
    await expect(
      patchDivision(owner, division.id, { variant_key: "nope" }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe.skipIf(!HAS_DB)("replaceStages — format structure swap (v8)", () => {
  it("swaps league → groups+knockout until fixtures exist, then 409 FORMAT_LOCKED", async () => {
    const owner = await seedOwner();
    const { division } = await rig(owner);
    await createStages(owner, division.id, { seq: 1, kind: "league", name: "L", config: {} });

    // Pre-fixtures: the whole structure swaps in one call.
    const swapped = await replaceStages(owner, division.id, [
      { seq: 1, kind: "group", name: "Group stage", config: { legs: 1, pools: { count: 2 } }, qualification: null },
      {
        seq: 2, kind: "knockout", name: "Knockout", config: {},
        qualification: { take: [{ pool: "A", rank: 1 }, { pool: "B", rank: 1 }] },
      },
    ]);
    expect(swapped.map((s) => s.kind)).toEqual(["group", "knockout"]);

    // Generate fixtures on the new structure → structure is history too.
    await createEntrants(owner, division.id, [
      { kind: "individual", display_name: "A", seed: 1, members: [] },
      { kind: "individual", display_name: "B", seed: 2, members: [] },
      { kind: "individual", display_name: "C", seed: 3, members: [] },
      { kind: "individual", display_name: "D", seed: 4, members: [] },
    ]);
    await generateStageFixtures(owner, swapped[0]!.id);

    await expect(
      replaceStages(owner, division.id, [
        { seq: 1, kind: "league", name: "L", config: {}, qualification: null },
      ]),
    ).rejects.toMatchObject({ status: 409, code: "FORMAT_LOCKED" });
  });
});

describe.skipIf(!HAS_DB)("entrant-kind guard (spec 2026-07-18)", () => {
  it("blocks narrowing kinds that would orphan an active entrant, allows it once withdrawn", async () => {
    const owner = await seedOwner();
    const { division } = await rig(owner);

    // Generic sport declares no entrant model → every kind is accepted, so a
    // team entrant lands. Narrowing to individual-only would strand it.
    const [team] = await createEntrants(owner, division.id, [
      { kind: "team", display_name: "Team A", seed: 1, members: [] },
    ]);

    // The settings UI sends the FULL stored config plus the override (the
    // sport schema alone may not parse a bare preset) — mirror that here.
    const storedConfig = (await getDivision(owner, division.id)).config as Record<string, unknown>;
    const narrowed = {
      ...storedConfig,
      entrants: { kinds: ["individual"], defaultKind: "individual" },
    };

    await expect(
      patchDivision(owner, division.id, { config: narrowed }),
    ).rejects.toMatchObject({ status: 422, code: "ENTRANT_KIND_IN_USE" });

    // Withdraw the team → the same narrowing now lands, and the override sticks.
    await sql`update entrants set status = 'withdrawn' where id = ${team!.id}`;
    const patched = await patchDivision(owner, division.id, { config: narrowed });
    expect((patched.config as { entrants?: { kinds: string[] } }).entrants?.kinds).toEqual([
      "individual",
    ]);
  });
});

describe.skipIf(!HAS_DB)("entrants-only config PATCH bypasses the format lock (spec 2026-07-18)", () => {
  it("allows an entrants-only change while locked, but 409s if a real config field also changes", async () => {
    const owner = await seedOwner();
    const { division } = await rig(owner);

    // Lock the format the same way the format-lock suite does: entrants + a
    // league stage + generated fixtures.
    await createEntrants(owner, division.id, [
      { kind: "individual", display_name: "A", seed: 1, members: [] },
      { kind: "individual", display_name: "B", seed: 2, members: [] },
    ]);
    const [stage] = await createStages(owner, division.id, {
      seq: 1, kind: "league", name: "L", config: {},
    });
    await generateStageFixtures(owner, stage!.id);

    // The settings UI sends the FULL stored config plus the override, so mirror
    // that: base off the stored snapshot and set only `entrants`.
    const storedConfig = (await getDivision(owner, division.id)).config as Record<string, unknown>;

    // (a) Entrants-only change lands even though the format is locked.
    const patched = await patchDivision(owner, division.id, {
      config: {
        ...storedConfig,
        entrants: {
          kinds: ["individual", "team"],
          defaultKind: "individual",
          squadNumbers: true,
          captain: true,
        },
      },
    });
    const savedEntrants = (patched.config as {
      entrants?: { kinds: string[]; captain?: boolean };
    }).entrants;
    expect(savedEntrants?.kinds).toEqual(["individual", "team"]);
    expect(savedEntrants?.captain).toBe(true);

    // (b) Entrants change PLUS a real config field (points) → still locked.
    await expect(
      patchDivision(owner, division.id, {
        config: {
          ...storedConfig,
          points: { w: 5, d: 5, l: 5 },
          entrants: { kinds: ["individual", "team"], defaultKind: "individual" },
        },
      }),
    ).rejects.toMatchObject({ status: 409, code: "FORMAT_LOCKED" });
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end();
});
