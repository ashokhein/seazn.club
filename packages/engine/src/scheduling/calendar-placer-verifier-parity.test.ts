// #463 — THE test this wave exists for. A test that asserts only the placer's
// behaviour cannot catch a fork; this one feeds the placer's OWN OUTPUT back to
// `validateAssignments` per rule family, so any family the placer stops
// honouring fails here rather than shipping as "Auto proposes a board the apply
// gate warns about, and re-running Auto proposes the same board again".
//
// Every typed-rule breach reports `reason: "instruction"` (rule code H8) — there
// is no per-family field on `Conflict` — and each case below puts exactly one
// family in force, so an `instruction` row can only have come from it.
//
// Each config is sized so the rule BITES: without the placer honouring it the
// board really does breach, which is what a parity assertion needs to be worth
// running. Proven by reverting calendar.ts to the pre-#463 placer, where every
// case here fails.
import { describe, expect, it } from "vitest";
import {
  slotFixtures,
  validateAssignments,
  type RuleFixture,
  type SchedulableFixture,
} from "./calendar.ts";
import { SchedulingConstraints, type HardConstraint } from "./constraints.ts";

const TZ = "America/Los_Angeles";
const SAT_1000_LOCAL = Date.UTC(2026, 6, 11, 17, 0);
const SAT_0600_LOCAL = Date.UTC(2026, 6, 11, 13, 0);

const D1 = { kind: "division", divisionId: "d1" } as const;
const TERMINAL = { kind: "terminal" } as const;

// One shared entrant, so the cards serialise on the board and the rule under
// test is the only thing that can move them off it.
const cards = (n: number): SchedulableFixture[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `f${i + 1}`,
    home: "e1",
    away: `e${i + 10}`,
    divisionId: "d1",
  }));

// `winnerTo: null` for all of them: nothing feeds on, so `terminal` names the
// whole set and a selector-driven rule is exercised rather than skipped.
const ruleFixturesFor = (n: number): RuleFixture[] =>
  cards(n).map((f) => ({ id: f.id, extKey: f.id, divisionId: "d1", winnerTo: null }));

const configFor = (rule: HardConstraint, n: number, startAt: number) => ({
  startAt,
  matchMinutes: 30,
  gapMinutes: 0,
  perEntrantMinRest: 0,
  courts: ["C1", "C2"],
  blackouts: [],
  sessionWindows: [],
  tz: TZ,
  horizonMinutes: 60 * 24 * 21,
  ruleFixtures: ruleFixturesFor(n),
  constraints: SchedulingConstraints.parse({ hard: [rule] }),
});

const FAMILIES: ReadonlyArray<readonly [string, HardConstraint, number, number]> = [
  // Six cards capped at two a day: the placer must spread them over three days.
  [
    "max_fixtures_per_day",
    { type: "max_fixtures_per_day", count: 2, scope: { kind: "entrant", entrantId: "e1" } },
    6,
    SAT_1000_LOCAL,
  ],
  // First slot is 06:00 local, three hours inside the bound.
  ["not_before", { type: "not_before", time: "09:00", scope: D1 }, 3, SAT_0600_LOCAL],
  // Twelve cards from 10:00 local run to 15:30 — seven of them past the bound.
  ["not_after", { type: "not_after", time: "12:00", scope: D1 }, 12, SAT_1000_LOCAL],
  // The first slot is a Saturday.
  ["fixture_on_weekday", { type: "fixture_on_weekday", selector: TERMINAL, weekday: "WED", scope: D1 }, 3, SAT_1000_LOCAL],
  ["fixture_on_date", { type: "fixture_on_date", selector: TERMINAL, date: "2026-07-15", scope: D1 }, 3, SAT_1000_LOCAL],
];

describe("the placer's own output satisfies the verifier (#463)", () => {
  it.each(FAMILIES)("emits no %s violation it could have avoided", (_family, rule, n, startAt) => {
    const config = configFor(rule, n, startAt);
    const { assignments, conflicts } = slotFixtures({ fixtures: cards(n), config });

    // A card the placer REFUSED to place is honest; a card it placed into a
    // violation is the fork. These configs are all satisfiable inside the
    // horizon, so refusing one would mean the placer over-constrained — and
    // without this line "place nothing" would satisfy the assertion below.
    expect(assignments).toHaveLength(n);
    expect(conflicts.filter((c) => c.reason === "no_slot")).toEqual([]);

    // No cast: the placer's config IS a VerifyConfig now that `SlotConfig`
    // carries `tz` and `ruleFixtures`, which is the point — one object, one
    // clock, one rule list, handed to both sides.
    const verdict = validateAssignments(assignments, config);
    // Mapped to `detail` so a failure names the day or the time that broke,
    // rather than printing five identical conflict objects.
    expect(verdict.filter((c) => c.reason === "instruction").map((c) => c.detail)).toEqual([]);
  });
});
