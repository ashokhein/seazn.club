// Field hockey — period-kernel preset (v6/00 §3/§4 + v6/01 §3, FIH Rules of
// Hockey 2026 + General Tournament Regulations App 12). Key `hockey` (matches
// the existing match-length/venue placeholders — v6/00 §6.3). 4×15 quarters,
// draws first-class (3/1/0), goal kinds FG / penalty corner / stroke, cards
// green 2' / yellow 5' / red permanent — the team plays short on ALL of them
// — and the App 12 shoot-out (5 one-on-ones, 8 s, sudden death) where a
// competition demands a winner.
import type { PositionCatalog } from "../../sport/catalog.ts";
import type { PlayerStatsModel } from "../../stats/stats.ts";
import { makePeriodModule } from "../period/kernel.ts";
import { HOCKEY_SUSPENSIONS } from "../period/suspensions.ts";

const positions: PositionCatalog = {
  groups: [
    { key: "GK", name: "Goalkeeper", min: 1, max: 1 },
    { key: "DF", name: "Defender" },
    { key: "MF", name: "Midfielder" },
    { key: "FW", name: "Forward" },
  ],
  roles: [{ key: "captain", name: "Captain", unique: true }],
  lineup: { size: 11, benchMax: 7 },
};

const playerStats: PlayerStatsModel = {
  metrics: [
    {
      key: "goals", label: "Goals", from: "hockey.goal", field: "person", agg: "count",
      when: (p) => p.kind !== "og",
    },
    {
      key: "green_cards", label: "Green cards", from: "hockey.suspension.start",
      field: "person", agg: "count", when: (p) => p.class === "green",
    },
    {
      key: "yellow_cards", label: "Yellow cards", from: "hockey.suspension.start",
      field: "person", agg: "count", when: (p) => p.class === "yellow",
    },
    {
      key: "red_cards", label: "Red cards", from: "hockey.suspension.start",
      field: "person", agg: "count", when: (p) => p.class === "red",
    },
  ],
  awards: [{ key: "potm", label: "Player of the Match" }],
};

export const hockey = makePeriodModule({
  key: "hockey",
  version: "1.0.0",
  // Default = FIH outdoor league: 4×15, draws stand, 3/1/0.
  defaults: {
    periods: { count: 4, minutes: 15 },
    overtime: null,
    shootout: null,
    points: { win: 3, draw: 1, loss: 0 },
    suspensions: { classes: HOCKEY_SUSPENSIONS },
    strength: { base: 11, min: 7 }, // players on the pitch; cards reduce
    goalKinds: ["fg", "pc", "stroke", "og"],
    assists: false,
    awardScore: { goals: 3 },
    abandonPolicy: "replay",
  },
  variants: {
    "fih-outdoor": {},
    // Pro-League style: a shoot-out settles drawn matches, SO win worth a
    // bonus point (App 12: 5 attempts, 8 s each, then sudden death).
    "fih-shootout": {
      shootout: { attempts: 5, suddenDeath: true, clockSeconds: 8 },
      points: { win: 3, draw: 1, loss: 0, shootoutWin: 2, shootoutLoss: 1 },
    },
    youth: { periods: { count: 4, minutes: 10 } },
  },
  positions,
  entrantModel: { kinds: ["team"], defaultKind: "team", team: { squadNumbers: true, captain: true } },
  metrics: [
    { key: "gf", label: "GF", direction: "desc" },
    { key: "ga", label: "GA", direction: "asc" },
    { key: "gd", label: "GD", direction: "desc" },
    { key: "goals_pc", label: "PC goals", direction: "desc", display: false },
    { key: "goals_stroke", label: "Stroke goals", direction: "desc", display: false },
    { key: "cards_green", label: "Green cards", direction: "asc", display: false },
    { key: "cards_yellow", label: "Yellow cards", direction: "asc", display: false },
    { key: "cards_red", label: "Red cards", direction: "asc", display: false },
  ],
  // FIH standard: points → GD → GF → H2H (v6/00 §4).
  defaultTiebreakers: ["points", "diff", "for", "h2h_points", "seed"],
  officialLabel: { scorer: "Umpire" },
  shootoutLabel: "SO",
  timelineEntitlement: "scoring.match_timeline",
  playerStats,
});
