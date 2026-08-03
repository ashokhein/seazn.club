// Tennis — nested-kernel preset (v6/00 §2/§4 + v6/01 §1, ITF Rules of Tennis
// 2026). The kernel owns every line of point/game/set logic; this file is
// configuration: the four shipped variants, the (empty) position catalog and
// the league conventions. Singles vs doubles is the entrant kind (like
// badminton) — the module never inspects it.
import type { PositionCatalog } from "../../sport/catalog.ts";
import { makeNestedModule } from "../nested/kernel.ts";

// No positions; one nominated unit (player or pair) per side.
const positions: PositionCatalog = {
  groups: [],
  lineup: { size: 1, benchMax: 1 },
};

export const tennis = makeNestedModule({
  key: "tennis",
  version: "1.0.0",
  // Default = tour play (ITF Rules 5–7): best of 3 tie-break sets, TB7 at 6–6.
  defaults: {
    bestOf: 3,
    set: { gamesTo: 6, winBy: 2, tiebreakAt: 6, tiebreakTo: 7 },
    finalSet: "same",
    game: { noAd: false },
    tiebreak: { winBy: 2 },
    points: { win: 2, loss: 0 }, // common tennis-league convention
  },
  variants: {
    tour: {},
    // Slam rule (v6/00 §2 as amended): bo5, deciding set plays its tie-break
    // to 10 at 6–6 (finalSet.tiebreakTo — the games-level form, matching the
    // real rule rather than an App VI match tie-break replacing the set).
    "grand-slam": { bestOf: 5, finalSet: { tiebreakTo: 10 } },
    // ITF App VI short sets: to 4 games, TB at 3–3 to 5, no-ad games.
    fast4: {
      set: { gamesTo: 4, winBy: 2, tiebreakAt: 3, tiebreakTo: 5 },
      game: { noAd: true },
    },
    // The ITF doubles norm: no-ad games + a 10-point match tie-break as the
    // deciding set (App VI — MTB replaces the set at one set all).
    "doubles-noad-mtb10": {
      game: { noAd: true },
      finalSet: { matchTiebreakTo: 10 },
    },
  },
  positions,
  entrantModel: { kinds: ["individual", "pair"], defaultKind: "individual" },
  // v6/00 §4 — points → set ratio → game ratio → h2h → seed.
  defaultTiebreakers: ["points", "set_ratio", "game_ratio", "h2h_points", "seed"],
  officialLabel: { scorer: "Chair Umpire" }, // ITF App VII
  rallyEntitlement: "scoring.rally_by_rally",
  // Jul3/07 §3 — unlocked by W4's optional `server`/`winner` on the point.
  // Aces and double faults are SERVING statistics, so both credit the server:
  // a double fault is a point for the receiver but a fault by the server, which
  // is exactly how the chair's card scores it.
  playerStats: {
    metrics: [
      { key: "points", label: "Points won", from: "tennis.point", field: "winner", agg: "count" },
      {
        key: "service_points",
        label: "Service points",
        from: "tennis.point",
        field: "server",
        agg: "count",
      },
      {
        key: "aces",
        label: "Aces",
        from: "tennis.point",
        field: "server",
        agg: "count",
        when: (p) => (p.meta as { kind?: string } | undefined)?.kind === "ace",
      },
      {
        key: "double_faults",
        label: "Double faults",
        from: "tennis.point",
        field: "server",
        agg: "count",
        when: (p) => (p.meta as { kind?: string } | undefined)?.kind === "double_fault",
      },
      {
        key: "violations",
        label: "Code violations",
        from: "tennis.sanction",
        field: "person",
        agg: "count",
      },
    ],
  },
});
