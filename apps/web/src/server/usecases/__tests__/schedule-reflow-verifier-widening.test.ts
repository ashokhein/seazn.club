// What the auto pass now TELLS the organiser, pinned row for row.
//
// Before the solver wave this pass reported only what the placer could not fit —
// `no_slot`, `start_window`, a pinned collision — plus the typed-rule referee.
// It now also carries the FULL verifier's rows, because `buildSchedule` and
// `reflowExisting` each run `validateAssignments` over the board they produce.
// Rest and overlap rows the auto pass has never emitted can therefore appear.
//
// The widening is WANTED: a board that breaches a rule should say so on the
// surface the organiser builds it from. But it has a sharp edge that is worth a
// test of its own. REFLOW is the DEFAULT mode, and when the repair solver cannot
// improve on the incumbent it hands the organiser's ORIGINAL board back and
// verifies THAT — so a board they have been living with quite happily can
// suddenly come back carrying rows they have never been shown.
//
// This file pins the exact set on exactly that shape, so a later change to the
// verifier cannot quietly alter what organisers see. It asserts identity and
// blocking-ness, not merely a count: "two conflicts" would survive the two rows
// changing into completely different rules.
//
// The board is built so the outcome needs no search and cannot flake: both
// offending cards are PINNED, so the repair solver may not move either, the
// proposal comes back untouched, and `settle` verifies the whole thing.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { applySchedule, autoSchedule, putScheduleSettings } from "../schedule";
import { patchFixture } from "../fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const T0 = "2026-08-01T09:00:00.000Z";
const MIN = 60_000;
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * MIN).toISOString();

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

/** 4 entrants -> 6 league fixtures, 2 courts, 30-minute matches, 30 minutes'
 *  rest owed between an entrant's matches (so a pair needs 60 minutes apart). */
async function seed(): Promise<{ auth: AuthCtx; stageId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Org " + suffix}, ${"org-" + suffix})
    returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  for (const feature of ["scheduling.constraints", "scheduling.board"]) {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value)
      values (${orgId}, ${feature}, true)
      on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const competition = await createCompetition(auth, {
    name: "Widen " + suffix,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    eligibility: [],
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: 4 }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "L",
    config: {},
  });
  await putScheduleSettings(auth, division.id, {
    config: {
      startAt: T0,
      matchMinutes: 30,
      gapMinutes: 0,
      courts: ["C1", "C2"],
      perEntrantMinRest: 30,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  await generateStageFixtures(auth, stage.id);
  return { auth, stageId: stage.id };
}

describe.skipIf(!HAS_DB)("reflow reports the FULL verifier's rows over the board it returns", () => {
  it("names exactly the rest breach on a pinned, unrepairable board", async () => {
    const { auth, stageId } = await seed();

    const rows = await sql<
      { id: string; home_entrant_id: string; away_entrant_id: string }[]
    >`select id, home_entrant_id, away_entrant_id
      from fixtures where stage_id = ${stageId} order by id`;
    expect(rows).toHaveLength(6);

    // Two cards that share an entrant, 30 minutes apart under a 30-minute rest
    // rule: they need 60. Rest is warn-only at the write gate, which is the only
    // reason a board can reach this state at all.
    const first = rows[0]!;
    const clashing = rows.find(
      (r) =>
        r.id !== first.id &&
        [r.home_entrant_id, r.away_entrant_id].some((e) =>
          [first.home_entrant_id, first.away_entrant_id].includes(e),
        ),
    )!;
    // Everything else is parked two hours apart on one court, so the ONLY thing
    // wrong with this board is the pair above and the expected set is exact.
    const others = rows.filter((r) => r.id !== first.id && r.id !== clashing.id);
    await applySchedule(auth, stageId, {
      assignments: [
        { fixture_id: first.id, scheduled_at: at(0), court_label: "C1" },
        { fixture_id: clashing.id, scheduled_at: at(30), court_label: "C2" },
        ...others.map((r, i) => ({
          fixture_id: r.id,
          scheduled_at: at(300 + i * 120),
          court_label: "C1",
        })),
      ],
      source: "manual",
    });

    // Pinned, so the repair solver may not move either and the incumbent board
    // is what comes back — no search, no flake.
    for (const f of [first, clashing]) await patchFixture(auth, f.id, { schedule_locked: true });

    const out = await autoSchedule(auth, stageId, { only_unlocked: true, mode: "reflow" });

    // The board is returned unchanged...
    expect(out.assignments).toHaveLength(6);
    expect(out.assignments.find((a) => a.fixture_id === first.id)?.scheduled_at).toBe(at(0));
    expect(out.assignments.find((a) => a.fixture_id === clashing.id)?.scheduled_at).toBe(at(30));

    // ...and this is the EXACT set of rows the organiser is now shown, WHOLE
    // objects rather than a count or a subset of fields. A count would survive
    // these two turning into two entirely different rules; dropping `rule` would
    // survive the token an organiser's repair prompt cites changing underneath
    // it. Both are the drift this file exists to catch.
    //
    // These are `warn.rest` rows, and the pass they came from NEVER EMITTED
    // THEM before this wave — that is the widening, stated as a value.
    const shared = [first.home_entrant_id, first.away_entrant_id].find((e) =>
      [clashing.home_entrant_id, clashing.away_entrant_id].includes(e),
    )!;
    const byId = (a: { fixture_id: string }, b: { fixture_id: string }) =>
      a.fixture_id.localeCompare(b.fixture_id);
    const expected = [first.id, clashing.id]
      .map((id) => ({
        fixture_id: id,
        code: "warn.rest",
        rule: "H4",
        blocking: false,
        detail: `entrant ${shared} below rest`,
      }))
      .sort(byId);
    expect([...out.conflicts].sort(byId)).toEqual(expected);
  }, 120_000);
});
