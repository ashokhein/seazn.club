// PROMPT-18 acceptance (doc 13): role × capability authz matrix, scoped
// assignment resolution, the invite→score→finalize scorer journey, seat
// quotas (members.max / scorers.max / orgs.max_owned) and the doc 10 §2.4
// member freeze. Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { PaymentRequiredError, HttpError } from "@/lib/errors";
import { createOrgForUser } from "@/lib/auth";
import { grantInvite, loadInvite } from "@/lib/invites";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { OrgRole } from "@/lib/types";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";
import { scoreEvent, finalizeFixture } from "../scoring";
import { putLineup } from "../fixtures";
import {
  requireScorable,
  scorerCovers,
  fixtureScope,
  createAssignment,
  listAssignedFixtures,
  isScorerOnly,
} from "../scorers";
import {
  frozenMemberIds,
  assertMemberNotFrozen,
} from "../entitlement-freeze";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name})
    returning id`;
  return id;
}

async function seedOrg(): Promise<{ orgId: string; ownerId: string; slug: string }> {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = await makeUser("owner");
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Org " + suffix}, ${"org-" + suffix}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  // Role tests rig several competitions per org; the v3 free cap (1 active)
  // is not under test here — lift it via override.
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${orgId}, 'competitions.max_active', 10, 'test probe')`;
  return { orgId, ownerId, slug: "org-" + suffix };
}

const asRole = (orgId: string, userId: string | null, role: OrgRole | null): AuthCtx => ({
  orgId,
  via: "session",
  userId,
  role,
  keyId: null,
});

/** Division rig: 4 entrants, generated + started league; returns 2 fixtures. */
async function rig(owner: AuthCtx) {
  const competition = await createCompetition(owner, {
    name: "Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open", sport_key: "generic", variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false }, eligibility: [],
  });
  await createEntrants(owner, division.id, ["A", "B", "C", "D"].map((n, i) => ({
    kind: "individual" as const, display_name: n, seed: i + 1, members: [],
  })));
  const [stage] = await createStages(owner, division.id, {
    seq: 1, kind: "league", name: "L", config: {},
  });
  const { fixtures } = await generateStageFixtures(owner, stage.id);
  await startDivision(owner, division.id);
  return { competition, division, stage, fixtures };
}

async function addMember(orgId: string, role: OrgRole): Promise<string> {
  const userId = await makeUser(role);
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, ${role})`;
  return userId;
}

async function makeInvite(
  orgId: string,
  role: OrgRole,
  defaultScope: { type: "competition" | "division" | "fixture"; id: string } | null = null,
): Promise<string> {
  const token = randomUUID();
  await sql`
    insert into org_invites (org_id, role, default_scope, token, max_uses)
    values (${orgId}, ${role}, ${defaultScope ? sql.json(defaultScope) : null}, ${token}, 1)`;
  return token;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("scorer role (doc 13, PROMPT-18)", () => {
  it("authz matrix: role × capability (doc 13 §2, table-driven)", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asRole(orgId, ownerId, "owner");
    const { division, fixtures } = await rig(owner);
    const adminId = await addMember(orgId, "admin");
    const viewerId = await addMember(orgId, "viewer");
    const scorerId = await addMember(orgId, "scorer");
    const strangerScorerId = await addMember(orgId, "scorer");
    await createAssignment(orgId, scorerId, { type: "division", id: division.id }, ownerId);

    // The gate itself: who may act on this fixture at all (doc 13 §2/§3).
    const gate: { role: OrgRole; userId: string; pass: boolean }[] = [
      { role: "owner", userId: ownerId, pass: true },
      { role: "admin", userId: adminId, pass: true },
      { role: "viewer", userId: viewerId, pass: false },
      { role: "scorer", userId: scorerId, pass: true }, // covering assignment
      { role: "scorer", userId: strangerScorerId, pass: false }, // no assignment
    ];
    for (const probe of gate) {
      const attempt = requireScorable(asRole(orgId, probe.userId, probe.role), fixtures[0].id);
      if (probe.pass) {
        await expect(attempt, `${probe.role} gate`).resolves.toBeTruthy();
      } else {
        await expect(attempt, `${probe.role} gate`).rejects.toMatchObject({ status: 403 });
      }
    }

    // Capabilities on a fixture the scorer covers (defaults: finalize +
    // lineups allowed; void pre-finalize only).
    const scorer = asRole(orgId, scorerId, "scorer");
    const fx = fixtures[0].id;
    await scoreEvent(scorer, fx, { expected_seq: 0, type: "core.start", payload: {} });
    const note = await scoreEvent(scorer, fx, {
      expected_seq: 1, type: "core.note", payload: { text: "oops" },
    });
    const [noteRow] = await sql<{ id: string }[]>`
      select id from score_events where fixture_id = ${fx} and seq = ${note.seq}`;
    const voided = await scoreEvent(scorer, fx, {
      expected_seq: note.seq, type: "core.void", payload: { event_id: noteRow.id },
    });
    const decided = await scoreEvent(scorer, fx, {
      expected_seq: voided.seq, type: "generic.result", payload: { p1Score: 2, p2Score: 1 },
    });
    expect(decided.status).toBe("decided");
    const finalized = await finalizeFixture(scorer, fx, decided.seq);
    expect(finalized.status).toBe("finalized");

    // Post-finalize void is an editor's power, not a scorer's (doc 13 §2).
    const [starter] = await sql<{ id: string }[]>`
      select id from score_events where fixture_id = ${fx} and seq = 1`;
    await expect(
      scoreEvent(scorer, fx, {
        expected_seq: finalized.seq, type: "core.void", payload: { event_id: starter.id },
      }),
    ).rejects.toMatchObject({ status: 403 });

    // Lineups: allowed by default on a still-scheduled fixture…
    const fx2 = fixtures[1];
    const entrantId = (fx2.home_entrant_id ?? fx2.away_entrant_id) as string;
    await expect(putLineup(scorer, fx2.id, entrantId, { slots: [] })).resolves.toBeTruthy();
    // …and config-gated off per division (scorerCanEnterLineups=false).
    await sql`update divisions set scorer_can_enter_lineups = false where id = ${division.id}`;
    await expect(putLineup(scorer, fx2.id, entrantId, { slots: [] })).rejects.toMatchObject({
      status: 403,
    });
    // Editors are unaffected by the scorer config gates.
    await expect(putLineup(owner, fx2.id, entrantId, { slots: [] })).resolves.toBeTruthy();

    // Finalize config gate (scorerCanFinalize=false → 403 for the scorer).
    await sql`update divisions set scorer_can_finalize = false where id = ${division.id}`;
    await scoreEvent(scorer, fx2.id, { expected_seq: 0, type: "core.start", payload: {} });
    const d2 = await scoreEvent(scorer, fx2.id, {
      expected_seq: 1, type: "generic.result", payload: { p1Score: 1, p2Score: 0 },
    });
    await expect(finalizeFixture(scorer, fx2.id, d2.seq)).rejects.toMatchObject({ status: 403 });
    await expect(finalizeFixture(owner, fx2.id, d2.seq)).resolves.toBeTruthy();
  });

  it("assignment resolution: fixture ⊂ division ⊂ competition (doc 13 §3)", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asRole(orgId, ownerId, "owner");
    const { competition, division, fixtures } = await rig(owner);
    const other = await rig(owner); // second division, never assigned

    const scope = (await fixtureScope(fixtures[0].id))!;
    for (const s of [
      { type: "fixture" as const, id: fixtures[0].id },
      { type: "division" as const, id: division.id },
      { type: "competition" as const, id: competition.id },
    ]) {
      const userId = await addMember(orgId, "scorer");
      await createAssignment(orgId, userId, s, ownerId);
      expect(await scorerCovers(orgId, userId, scope), s.type).toBe(true);
      // Same user never covers the unrelated division's fixture…
      const otherScope = (await fixtureScope(other.fixtures[0].id))!;
      const covered = await scorerCovers(orgId, userId, otherScope);
      // …except via competition scope on a shared competition (each rig makes
      // its own competition, so this must be false for all three).
      expect(covered, `${s.type} must not leak`).toBe(false);
    }

    // A fixture-scoped assignment covers exactly that fixture.
    const fxScorer = await addMember(orgId, "scorer");
    await createAssignment(orgId, fxScorer, { type: "fixture", id: fixtures[0].id }, ownerId);
    const sibling = (await fixtureScope(fixtures[1].id))!;
    expect(await scorerCovers(orgId, fxScorer, sibling)).toBe(false);
  });

  it("E2E: scorer invite with division scope → my matches → score; other scopes 403", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asRole(orgId, ownerId, "owner");
    const { division, fixtures } = await rig(owner);
    const other = await rig(owner);

    // Owner mints a division-scoped scorer invite; a fresh user accepts.
    const token = await makeInvite(orgId, "scorer", { type: "division", id: division.id });
    const invite = (await loadInvite(token))!;
    expect(invite.default_scope).toEqual({ type: "division", id: division.id });
    const scorerId = await makeUser("volunteer");
    await grantInvite(invite, scorerId);

    const [membership] = await sql<{ role: string }[]>`
      select role from org_members where org_id = ${orgId} and user_id = ${scorerId}`;
    expect(membership.role).toBe("scorer");
    expect(await isScorerOnly(scorerId)).toBe(true);

    // My matches: the assigned division's fixtures, nothing else.
    const mine = await listAssignedFixtures(scorerId);
    expect(mine.length).toBe(fixtures.length);
    expect(new Set(mine.map((f) => f.division_id))).toEqual(new Set([division.id]));
    expect(mine[0].sport_key).toBe("generic");

    // Scores a fixture (winner), voids a mistake — the full courtside loop.
    const scorer = asRole(orgId, scorerId, "scorer");
    const fx = mine[0].id;
    await scoreEvent(scorer, fx, { expected_seq: 0, type: "core.start", payload: {} });
    const mistake = await scoreEvent(scorer, fx, {
      expected_seq: 1, type: "core.note", payload: { text: "wrong court" },
    });
    const [mistakeRow] = await sql<{ id: string; recorded_by: string | null }[]>`
      select id, recorded_by from score_events where fixture_id = ${fx} and seq = ${mistake.seq}`;
    expect(mistakeRow.recorded_by).toBe(scorerId); // audit trail stays real (doc 13 §4)
    await scoreEvent(scorer, fx, {
      expected_seq: mistake.seq, type: "core.void", payload: { event_id: mistakeRow.id },
    });
    const done = await scoreEvent(scorer, fx, {
      expected_seq: mistake.seq + 1, type: "generic.result", payload: { p1Score: 3, p2Score: 2 },
    });
    expect(done.status).toBe("decided");
    await finalizeFixture(scorer, fx, done.seq); // scorerCanFinalize default true

    // Everything outside the assigned scope is 403 (acceptance): the door
    // (requireFixtureActor → requireScorable) rejects the other division.
    await expect(requireScorable(scorer, other.fixtures[0].id)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("quotas: 4th member and 2nd scorer → 402 with the feature key (doc 13 §5)", async () => {
    const { orgId } = await seedOrg(); // community: members.max 3, scorers.max 1

    // Members pool: owner occupies 1 seat; two more accepts fit; the 4th is 402.
    for (let i = 0; i < 2; i++) {
      const t = await makeInvite(orgId, "viewer");
      await grantInvite((await loadInvite(t))!, await makeUser(`v${i}`));
    }
    const fourth = await makeInvite(orgId, "viewer");
    await expect(
      grantInvite((await loadInvite(fourth))!, await makeUser("v3")),
    ).rejects.toMatchObject({ featureKey: "members.max" });

    // Scorer pool is separate: one scorer still fits at 3/3 members…
    const s1 = await makeInvite(orgId, "scorer");
    await grantInvite((await loadInvite(s1))!, await makeUser("s1"));
    // …the second scorer seat is 402.
    const s2 = await makeInvite(orgId, "scorer");
    await expect(
      grantInvite((await loadInvite(s2))!, await makeUser("s2")),
    ).rejects.toMatchObject({ featureKey: "scorers.max" });
  });

  it("orgs.max_owned (decision a): 2nd community org blocked at creation", async () => {
    const userId = await makeUser("founder");
    const first = await createOrgForUser(userId, "First club");
    expect(first.id).toBeTruthy();
    await expect(createOrgForUser(userId, "Second club")).rejects.toMatchObject({
      featureKey: "orgs.max_owned",
    });
    await expect(createOrgForUser(userId, "Second club")).rejects.toBeInstanceOf(
      PaymentRequiredError,
    );
  });

  it("downgrade freeze (doc 10 §2.4): over-quota member seats go read-only, owner exempt", async () => {
    const { orgId, ownerId } = await seedOrg();
    // Force an over-quota state (as a pro→community downgrade would): 3 admins
    // + owner = 4 non-scorer seats against members.max 3. Explicit created_at
    // offsets — the freeze selector keeps the most recently joined.
    const admins: string[] = [];
    for (let i = 0; i < 3; i++) {
      const userId = await makeUser("admin");
      await sql`
        insert into org_members (org_id, user_id, role, created_at)
        values (${orgId}, ${userId}, 'admin', now() - make_interval(hours => ${3 - i}))`;
      admins.push(userId);
    }

    const frozen = await frozenMemberIds(orgId);
    expect(frozen.size).toBe(1);
    const [oldest] = admins; // insertion order = created_at order
    expect(frozen.has(oldest)).toBe(true);
    expect(frozen.has(ownerId)).toBe(false);

    await expect(assertMemberNotFrozen(orgId, oldest)).rejects.toMatchObject({
      featureKey: "members.max",
    });
    await expect(assertMemberNotFrozen(orgId, admins[2])).resolves.toBeUndefined();
    await expect(assertMemberNotFrozen(orgId, ownerId)).resolves.toBeUndefined();
  });

  it("viewer role never scores; HttpError carries 403 not 401", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asRole(orgId, ownerId, "owner");
    const { fixtures } = await rig(owner);
    const viewerId = await addMember(orgId, "viewer");
    try {
      await requireScorable(asRole(orgId, viewerId, "viewer"), fixtures[0].id);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(403);
    }
  });
});
