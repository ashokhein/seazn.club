// Task 12 / ruling R20 — POLISH anchors to the ORGANISER'S board, not to one
// greedy invented during the run.
//
// The engine half landed first: `BuildInput.current` is the caller's own board,
// `moved` is measured against it when it is supplied, `lost` counts baseline
// rows the run could not place (R21), and a `frozen` id with no `locked` anchor
// is pinned to its `current` slot rather than to greedy's re-placement. All of
// that is inert until a caller supplies the field, and `autoSchedule` is the
// only caller there is — so without these specs the whole ruling ships as dead
// code that passes its own package's tests.
//
// WHAT MAKES THE FIXTURE HERE THE TEST. Every assertion below is on a board the
// organiser MOVED away from the solver's own answer (a uniform +3h shift after
// an apply). On a board that happens to be greedy's board, `movedFrom(current)`
// and `movedFrom(greedy seed)` return the same number and the specs would pass
// against either baseline while measuring the wrong one. The measured pair is
// recorded on each spec.
//
// Real Postgres required; skipped without DATABASE_URL.
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
import { ScheduleSolverInfo } from "@/server/api-v1/schemas";

const HAS_DB = !!process.env.DATABASE_URL;

const T0 = "2026-08-01T09:00:00.000Z";
const MIN = 60_000;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(): Promise<AuthCtx> {
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
  for (const feature of [
    "scheduling.constraints",
    "scheduling.board",
    "scheduling.multi_division",
  ]) {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value)
      values (${orgId}, ${feature}, true)
      on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

/** A league division with `entrants` players and NO end date — the ordinary
 *  organiser config, and the one whose `applyWindow` is half-infinite. */
async function seedStage(
  auth: AuthCtx,
  entrants: number,
): Promise<{ stageId: string; created: number }> {
  const competition = await createCompetition(auth, {
    // #376: an end date is mandatory — a competition with no end can never
    // cross the pass line, so the schema requires one.
    ends_on: "2030-12-31",
    name: "Polish " + randomUUID().slice(0, 6),
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
    Array.from({ length: entrants }, (_, i) => ({
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
  const generated = await generateStageFixtures(auth, stage.id);
  return { stageId: stage.id, created: generated.created };
}

type Row = { id: string; scheduled_at: Date; court_label: string };
const boardOf = (stageId: string) =>
  sql<Row[]>`select id, scheduled_at, court_label from fixtures
             where stage_id = ${stageId} and scheduled_at is not null
             order by scheduled_at, court_label, id`;

const slot = (isoOrDate: string | Date, court: string | null) =>
  `${typeof isoOrDate === "string" ? isoOrDate : isoOrDate.toISOString()}|${court}`;

/**
 * Build a board, apply it, then SHIFT every card `minutes` later.
 *
 * The shift is what makes the organiser's board distinguishable from greedy's.
 * Uniform, so the board stays legal — every rest gap and every court assignment
 * is preserved, only the absolute times differ — which matters because a board
 * that arrived carrying blocking conflicts would change what the run does for
 * reasons that have nothing to do with `current`.
 */
async function publishedBoardShifted(
  auth: AuthCtx,
  stageId: string,
  minutes: number,
): Promise<Row[]> {
  const built = await autoSchedule(auth, stageId, {
    only_unlocked: false,
    mode: "build",
  });
  await applySchedule(auth, stageId, {
    assignments: built.assignments.map((a) => ({
      fixture_id: a.fixture_id,
      scheduled_at: a.scheduled_at,
      court_label: a.court_label,
    })),
    source: "auto",
  });
  for (const a of built.assignments) {
    await patchFixture(auth, a.fixture_id, {
      scheduled_at: new Date(
        Date.parse(a.scheduled_at) + minutes * MIN,
      ).toISOString(),
    });
  }
  return boardOf(stageId);
}

describe.skipIf(!HAS_DB)(
  "POLISH measures itself against the organiser's board (R20)",
  () => {
    /**
     * MEASURED, both numbers, on this exact fixture: with `current` supplied the
     * run reports `moved: 6` — every card left the +3h slot the organiser had it
     * in. Without it the baseline is greedy's own re-placement, which is the board
     * the tier solver hands back, so it reports `moved: 0`: "nothing moved" about
     * a run that moved all six. The shift is what separates the two; on the
     * unshifted board both baselines answer 0 and this spec would pass blind.
     */
    it("counts moves from where the organiser had the cards, not from greedy's seed", async () => {
      const auth = await seedOrg();
      const { stageId, created } = await seedStage(auth, 4);
      const before = await publishedBoardShifted(auth, stageId, 180);
      expect(before).toHaveLength(created);

      const out = await autoSchedule(auth, stageId, {
        only_unlocked: true,
        mode: "polish",
      });

      // What the run actually did to the organiser's board, computed here rather
      // than taken from the payload — this is the number `moved` is a claim about.
      const was = new Map(
        before.map((r) => [r.id, slot(r.scheduled_at, r.court_label)]),
      );
      const relocated = out.assignments.filter(
        (a) => was.get(a.fixture_id) !== slot(a.scheduled_at, a.court_label),
      ).length;
      // The premise of the fixture: the answer is nowhere near the +3h board.
      expect(relocated).toBe(created);
      expect(out.solver.moved).toBe(relocated);
    }, 180_000);

    /** `lost` is baseline rows this run could not place (R21). Nothing is dropped
     *  here — the assertion that bites is that the field is PRESENT and a number:
     *  a mapping that never wrote it is indistinguishable from `lost: 0` on the
     *  value alone, and `undefined` is what the whole ruling looks like when the
     *  usecase forgets to forward it. */
    it("puts a lost count on the wire, distinct from the unplaced count", async () => {
      const auth = await seedOrg();
      const { stageId, created } = await seedStage(auth, 4);
      await publishedBoardShifted(auth, stageId, 180);

      const out = await autoSchedule(auth, stageId, {
        only_unlocked: true,
        mode: "polish",
      });

      expect(out.solver.lost).toBe(0);
      expect(out.metrics.placed).toBe(created);
      expect(ScheduleSolverInfo.parse(out.solver)).toEqual(out.solver);
    }, 180_000);

    /**
     * The strip cannot tell a reflow timeout from a build that expired before its
     * first tier without this: both arrive `engine: "greedy"`, `budget_expired:
     * true`, `tiers_completed: 0`, `tiers_total: 4`. Asserted for all three modes
     * because a mapping that hard-coded one value would pass a single-mode spec.
     */
    it("echoes the mode the run was asked for", async () => {
      const auth = await seedOrg();
      const { stageId } = await seedStage(auth, 4);

      for (const mode of ["build", "reflow", "polish"] as const) {
        const out = await autoSchedule(auth, stageId, {
          only_unlocked: true,
          mode,
        });
        expect(out.solver.mode).toBe(mode);
      }
    }, 180_000);

    /**
     * BUILD must NOT receive `current`, and this is the spec that says so.
     *
     * A fresh full pass is not a rearrangement of anything. Anchored to the board
     * it was asked to replace it would report every card as moved by definition —
     * "12 matches moved" on the first run of the day, which says nothing and is
     * exactly the shape the R20 note warns about for an empty `current`.
     *
     * MEASURED, both numbers, on this fixture: the run relocates all 6 cards away
     * from the +3h board (asserted below, so the fixture cannot go quiet), and
     * reports `moved: 0` because its baseline is greedy's own seed, which is the
     * board it returns. Hand BUILD the same `current` POLISH gets and it reports
     * 6 instead — that is the mutant this kills.
     */
    it("does not anchor a BUILD to the board it was asked to replace", async () => {
      const auth = await seedOrg();
      const { stageId, created } = await seedStage(auth, 4);
      const before = await publishedBoardShifted(auth, stageId, 180);

      const out = await autoSchedule(auth, stageId, {
        only_unlocked: false,
        mode: "build",
      });

      const was = new Map(
        before.map((r) => [r.id, slot(r.scheduled_at, r.court_label)]),
      );
      const relocated = out.assignments.filter(
        (a) => was.get(a.fixture_id) !== slot(a.scheduled_at, a.court_label),
      ).length;
      // The fixture's premise, restated here so this spec cannot pass on a board
      // where the two baselines happen to agree.
      expect(relocated).toBe(created);
      expect(out.solver.moved).toBe(0);
      // Nothing to lose from, so nothing lost — 0 by definition, not by luck.
      expect(out.solver.lost).toBe(0);
    }, 180_000);
  },
);
