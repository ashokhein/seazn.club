// Ice hockey — period-kernel preset (v6/00 §3/§4 + v6/01 §2, IIHF Rule Book
// 2025/26 + 2026 Event Code). 3×20 stop-clock periods; preliminary-round
// sudden-death OT (5', 3 skaters + goalkeeper) then GWS (5 shooters + sudden-
// death pairs); the full penalty ladder with power-play strength and PIM;
// Event Code §219 points (3 · 2 · 1 · 0) and the §220 H2H-first tie-break.
import type { PositionCatalog } from "../../sport/catalog.ts";
import type { PlayerStatsModel } from "../../stats/stats.ts";
import { makePeriodModule } from "../period/kernel.ts";
import { ICEHOCKEY_SUSPENSIONS } from "../period/suspensions.ts";

// G/D/F with the classic bench: 6 on the ice, rolling changes (no sub events
// — line changes are not scoring facts; person checks stay loose).
const positions: PositionCatalog = {
  groups: [
    { key: "G", name: "Goaltender", min: 1, max: 1 },
    { key: "D", name: "Defence" },
    { key: "F", name: "Forward" },
  ],
  roles: [{ key: "captain", name: "Captain", unique: true }],
  lineup: { size: 6, benchMax: 17 },
};

// Jul3/07 §3 pattern — G/A/P plus PIM derived from per-class counts (the
// suspension.start payload carries the class, not a number, so PIM per player
// is a derived stat over counted classes).
const playerStats: PlayerStatsModel = {
  metrics: [
    {
      key: "goals", label: "Goals", from: "icehockey.goal", field: "person", agg: "count",
      when: (p) => p.kind !== "og",
    },
    { key: "assists", label: "Assists", from: "icehockey.goal", field: "assists", agg: "count" },
    {
      key: "pen_minor", label: "Minors", from: "icehockey.suspension.start", field: "person",
      agg: "count", when: (p) => p.class === "minor" || p.class === "bench_minor",
    },
    {
      key: "pen_double", label: "Double minors", from: "icehockey.suspension.start",
      field: "person", agg: "count", when: (p) => p.class === "double_minor",
    },
    {
      key: "pen_major", label: "Majors", from: "icehockey.suspension.start", field: "person",
      agg: "count", when: (p) => p.class === "major",
    },
    {
      key: "pen_misc", label: "Misconducts", from: "icehockey.suspension.start", field: "person",
      agg: "count", when: (p) => p.class === "misconduct",
    },
    {
      key: "pen_gm", label: "Game misconducts", from: "icehockey.suspension.start",
      field: "person", agg: "count", when: (p) => p.class === "game_misconduct",
    },
    {
      key: "pen_match", label: "Match penalties", from: "icehockey.suspension.start",
      field: "person", agg: "count", when: (p) => p.class === "match",
    },
  ],
  derived: [
    { key: "points", label: "Points", derive: (s) => (s.goals ?? 0) + (s.assists ?? 0) },
    {
      key: "pim",
      label: "PIM",
      // IIHF recorded minutes: minor/bench 2, double 4, major 5, misconduct
      // 10, game misconduct 20, match 25 (v6/01 §2).
      derive: (s) =>
        2 * (s.pen_minor ?? 0) +
        4 * (s.pen_double ?? 0) +
        5 * (s.pen_major ?? 0) +
        10 * (s.pen_misc ?? 0) +
        20 * (s.pen_gm ?? 0) +
        25 * (s.pen_match ?? 0),
    },
  ],
  awards: [{ key: "mvp", label: "MVP" }],
};

export const icehockey = makePeriodModule({
  key: "icehockey",
  version: "1.0.0",
  // Default = IIHF preliminary-round rules.
  defaults: {
    periods: { count: 3, minutes: 20 },
    overtime: { kind: "sudden_death", minutes: 5, skaters: 3 },
    shootout: { attempts: 5, suddenDeath: true },
    // Event Code §219: regulation win 3, OT/GWS win 2, OT/GWS loss 1, loss 0.
    points: { win: 3, draw: 1, loss: 0, otWin: 2, otLoss: 1 },
    suspensions: { classes: ICEHOCKEY_SUSPENSIONS },
    strength: { base: 5, min: 3 }, // skaters; penalties beyond 5v3 stack, don't reduce
    goalKinds: ["fg", "pp", "sh", "ps", "og"],
    assists: true,
    awardScore: { goals: 5 },
    abandonPolicy: "replay",
  },
  variants: {
    iihf: {},
    // Rec leagues: no OT, draws stand, 2/1/0.
    recreational: {
      overtime: null,
      shootout: null,
      points: { win: 2, draw: 1, loss: 0 },
    },
  },
  positions,
  entrantModel: { kinds: ["team"], defaultKind: "team", team: { squadNumbers: true, captain: true } },
  metrics: [
    { key: "gf", label: "GF", direction: "desc" },
    { key: "ga", label: "GA", direction: "asc" },
    { key: "gd", label: "GD", direction: "desc" },
    { key: "pim", label: "PIM", direction: "asc", display: false },
    { key: "goals_pp", label: "PP goals", direction: "desc", display: false },
    { key: "goals_sh", label: "SH goals", direction: "desc", display: false },
  ],
  // Event Code §220 — H2H sub-group first, then overall (maps directly onto
  // the existing comparator registry, v6/00 §1).
  defaultTiebreakers: ["points", "h2h_points", "h2h_diff", "h2h_for", "diff", "for", "seed"],
  officialLabel: { scorer: "Scorekeeper" },
  shootoutLabel: "GWS",
  timelineEntitlement: "scoring.match_timeline",
  playerStats,
});
