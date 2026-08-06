// #450 — a person-scoped rule is collapsed by the SAME resolver as the rosters.
//
// `buildSchedulePack` runs every entrant roster through the scheduling-only
// same-name guard (`personKeyResolver`), so a movable fixture's `people` are
// `name:<normalised>` keys wherever two `persons` rows share a display name.
// Nothing mapped `hard[].scope.personKey`, and `scopeCoversFixture` compares it
// RAW against `Assignment.people` — so an organiser's person-scoped rule, stored
// against a real person UUID, stopped binding the moment the guard collapsed
// that person. It did not warn, it did not throw: it silently matched nothing.
//
// WHY BOTH BOARDS BELOW ARE NEEDED. Mapping every `personKey` to one bucket
// would satisfy the collapse assertion perfectly, so the first board alone
// cannot tell "the rule now binds the right person" from "the rule now binds
// everyone". The UNIQUE-name board is the falsifier: there the key must come
// back untouched and the rule must cover the two fixtures that person is in and
// NOT the third.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import {
  validateAssignments,
  type Conflict,
  type HardConstraint,
} from "@seazn/engine/scheduling";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages } from "../stages";
import {
  buildSchedulePack,
  toEngineAssignments,
  verifyConfig,
  type SchedulePack,
} from "../schedule-ai";
import type { AiSchedulePlan } from "../schedule-ai-prompt";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const TZ = "Europe/London";
/** Injected clock — the pack reads no wall clock, so the board is reproducible. */
const NOW = Date.parse("2026-08-06T23:30:00Z");
const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

/** One calendar day in the ORG zone, three well-separated slots on it. A
 *  `max_fixtures_per_day` cap is a statement about a DAY, so every fixture in a
 *  board here must land on the same one — and far enough apart that no rest or
 *  person-overlap rule can be mistaken for the cap firing. */
const DAY = "2026-08-10";
const SLOT = [
  Date.parse(`${DAY}T09:00:00.000Z`),
  Date.parse(`${DAY}T13:00:00.000Z`),
  Date.parse(`${DAY}T17:00:00.000Z`),
];

function settingsConfig(hard: HardConstraint[]) {
  return {
    startAt: `${DAY}T08:00:00.000Z`,
    matchMinutes: 30,
    gapMinutes: 0,
    courts: ["Court 1", "Court 2", "Court 3"],
    perEntrantMinRest: 20,
    blackouts: [],
    sessionWindows: [],
    constraints: {
      restMin: 20,
      noBackToBack: false,
      startWindows: [],
      fieldFairness: "off",
      parallelism: "mixed",
      crossPersonClash: "warn",
      hard,
    },
  };
}

async function makeDivision(
  auth: AuthCtx,
  competitionId: string,
  slug: string,
  entrantNames: string[],
  hard: HardConstraint[],
): Promise<{ id: string; entrantByName: Map<string, string>; stageId: string }> {
  const division = await createDivision(auth, competitionId, {
    name: `Div ${slug}`,
    slug,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (${division.id}, ${sql.json(settingsConfig(hard))}, ${TZ}, now())
    on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
  await createEntrants(
    auth,
    division.id,
    entrantNames.map((n, i) => ({
      kind: "individual" as const,
      display_name: n,
      seed: i + 1,
      members: [],
    })),
  );
  const rows = await sql<{ id: string; display_name: string }[]>`
    select id, display_name from entrants where division_id = ${division.id}`;
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "RR",
    config: {},
  });
  return {
    id: division.id,
    entrantByName: new Map(rows.map((r) => [r.display_name, r.id])),
    stageId: stage!.id,
  };
}

async function addPerson(orgId: string, fullName: string, entrantIds: string[]): Promise<string> {
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name) values (${orgId}, ${fullName}) returning id`;
  for (const e of entrantIds) {
    await sql`insert into entrant_members (entrant_id, person_id, org_id)
              values (${e}, ${p!.id}, ${orgId})`;
  }
  return p!.id;
}

async function addFixture(
  auth: AuthCtx,
  d: { id: string; stageId: string; entrantByName: Map<string, string> },
  seq: number,
  extKey: string,
  home: string,
  away: string,
): Promise<string> {
  const [f] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status,
                          home_entrant_id, away_entrant_id)
    values (${d.stageId}, ${d.id}, ${auth.orgId}, 1, ${seq}, ${extKey}, 'scheduled',
            ${d.entrantByName.get(home)!}, ${d.entrantByName.get(away)!})
    returning id`;
  return f!.id;
}

/** A plan that puts the given fixtures on ONE day, one per court, hours apart. */
function planFor(ids: readonly string[]): AiSchedulePlan {
  return {
    assignments: ids.map((id, i) => ({
      fixture_id: id,
      scheduled_at: new Date(SLOT[i]!).toISOString(),
      court_label: `Court ${i + 1}`,
    })),
    unschedulable: [],
    explanations: [],
    summary: "",
  };
}

/** The referee's verdict on that plan, assembled exactly as the runner does. */
function refereeConflicts(pack: SchedulePack, ids: readonly string[]): Conflict[] {
  const plan = planFor(ids);
  return validateAssignments(toEngineAssignments(plan, pack), verifyConfig(pack));
}

const dayCapConflicts = (cs: readonly Conflict[]): Conflict[] =>
  cs.filter((c) => c.reason === "instruction" && (c.detail ?? "").includes("/day cap"));

/** BOARD 1 — two `persons` rows share a display name, so the pack collapses
 *  them to `name:tam okoro`. The stored rule names ONE of those uuids. */
async function seedCollapsedBoard(): Promise<{
  auth: AuthCtx;
  divisionId: string;
  tamId: string;
  f1: string;
  f2: string;
}> {
  const { auth } = await seedOrg("pro");
  const tag = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Person Scope Collapse ${tag}`,
    visibility: "public",
    branding: {},
  });
  // The rule has to name a person id that does not exist until the rows do, so
  // the division is created with no durable rule and the settings row is
  // rewritten below once the person exists.
  const div = await makeDivision(auth, comp.id, `collapse-${tag}`, ["C-1", "C-2", "C-3", "C-4"], []);

  // ONE human, two `persons` rows, in two DIFFERENT entrants of this division.
  const tam = await addPerson(auth.orgId, "Tam Okoro", [div.entrantByName.get("C-1")!]);
  await addPerson(auth.orgId, "tam  okoro", [div.entrantByName.get("C-3")!]);
  await addPerson(auth.orgId, "Solo C-2", [div.entrantByName.get("C-2")!]);
  await addPerson(auth.orgId, "Solo C-4", [div.entrantByName.get("C-4")!]);

  // "Tam plays at most one match a day" — authored against a real person UUID,
  // which is the only person identifier the console has.
  await sql`
    update schedule_settings
    set config = ${sql.json(
      settingsConfig([
        { type: "max_fixtures_per_day", count: 1, scope: { kind: "person", personKey: tam } },
      ]),
    )}
    where division_id = ${div.id}`;

  const f1 = await addFixture(auth, div, 0, "c-f1", "C-1", "C-2");
  const f2 = await addFixture(auth, div, 1, "c-f2", "C-3", "C-4");
  return { auth, divisionId: div.id, tamId: tam, f1, f2 };
}

/** BOARD 2 — every name is unique, so the pack collapses NOTHING. The same rule
 *  shape must come back with the uuid untouched and must cover exactly the two
 *  fixtures that person is in. */
async function seedUniqueBoard(): Promise<{
  auth: AuthCtx;
  divisionId: string;
  umaId: string;
  withUma: [string, string];
  withoutUma: string;
}> {
  const { auth } = await seedOrg("pro");
  const tag = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Person Scope Unique ${tag}`,
    visibility: "public",
    branding: {},
  });
  const div = await makeDivision(auth, comp.id, `unique-${tag}`, ["U-1", "U-2", "U-3", "U-4"], []);

  const uma = await addPerson(auth.orgId, "Uma Vane", [div.entrantByName.get("U-1")!]);
  await addPerson(auth.orgId, "Solo U-2", [div.entrantByName.get("U-2")!]);
  await addPerson(auth.orgId, "Solo U-3", [div.entrantByName.get("U-3")!]);
  await addPerson(auth.orgId, "Solo U-4", [div.entrantByName.get("U-4")!]);

  await sql`
    update schedule_settings
    set config = ${sql.json(
      settingsConfig([
        { type: "max_fixtures_per_day", count: 1, scope: { kind: "person", personKey: uma } },
      ]),
    )}
    where division_id = ${div.id}`;

  // Uma is in the first and the third; the second is two other people entirely.
  const a = await addFixture(auth, div, 0, "u-f1", "U-1", "U-2");
  const b = await addFixture(auth, div, 1, "u-f2", "U-3", "U-4");
  const c = await addFixture(auth, div, 2, "u-f3", "U-1", "U-3");
  return { auth, divisionId: div.id, umaId: uma, withUma: [a, c], withoutUma: b };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("person-scoped rules collapse with the rosters (#450)", () => {
  it("a rule naming a COLLAPSED person's uuid still binds", async () => {
    const { auth, divisionId, tamId, f1, f2 } = await seedCollapsedBoard();
    const { pack } = await buildSchedulePack(auth, divisionId, {
      now: NOW,
      mode: "generate",
      instruction: "One round.",
    });

    // Guards the guard: the collapse really happened, and it reached BOTH
    // fixtures — so a rule that still names the raw uuid matches neither.
    expect(pack.participants[f1]).toContain("name:tam okoro");
    expect(pack.participants[f2]).toContain("name:tam okoro");
    expect(pack.participants[f1]).not.toContain(tamId);
    expect(pack.assumptions.some((a) => a.includes("no records were merged"))).toBe(true);

    // THE ASSERTION. Two fixtures on one day against a 1/day person cap: both
    // are movable, so both are reported. Before the fix this is an empty list —
    // the rule compiled, displayed as enforced, and bound nothing.
    const capped = dayCapConflicts(refereeConflicts(pack, [f1, f2]));
    expect(capped).toHaveLength(2);
    expect(capped.map((c) => c.fixtureId).sort()).toEqual([f1, f2].sort());
    expect(capped[0]!.detail).toContain(`2 fixtures on ${DAY}`);

    // The mechanism, asserted where it is made, so a regression fails with a
    // readable message and not only through a verdict two functions away: the
    // rule the referee is handed is in the same namespace as the rows it is
    // compared against.
    const hard = pack.settings.constraints?.hard ?? [];
    expect(hard).toHaveLength(1);
    expect(hard[0]!.scope).toEqual({ kind: "person", personKey: "name:tam okoro" });
  }, 120_000);

  it("with UNIQUE names the same rule keeps its uuid and binds to that person ONLY", async () => {
    const { auth, divisionId, umaId, withUma, withoutUma } = await seedUniqueBoard();
    const { pack } = await buildSchedulePack(auth, divisionId, {
      now: NOW,
      mode: "generate",
      instruction: "One round.",
    });

    // Nothing collapsed here, so the resolver is the identity and the stored
    // uuid must survive verbatim. A mapping that rewrote every key — which is
    // what would make the first test pass for the wrong reason — fails here.
    expect(pack.assumptions.some((a) => a.includes("no records were merged"))).toBe(false);
    expect(pack.settings.constraints?.hard?.[0]!.scope).toEqual({
      kind: "person",
      personKey: umaId,
    });
    expect(pack.participants[withUma[0]!]).toContain(umaId);
    expect(pack.participants[withoutUma]).not.toContain(umaId);

    // Three fixtures on one day; the cap is scoped to Uma, who is in two of
    // them. So the count is 2 (not 3) and the third card is untouched.
    const capped = dayCapConflicts(refereeConflicts(pack, [withUma[0]!, withoutUma, withUma[1]!]));
    expect(capped).toHaveLength(2);
    expect(capped.map((c) => c.fixtureId).sort()).toEqual([...withUma].sort());
    expect(capped.map((c) => c.fixtureId)).not.toContain(withoutUma);
    expect(capped[0]!.detail).toContain(`2 fixtures on ${DAY}`);
  }, 120_000);
});
