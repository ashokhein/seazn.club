// Table tennis — set-based preset (spec 04 §5 + engine/sports/table-tennis.md).
// {5|7,11,11,2,null}: games to 11, win by 2, no cap (deuce runs 12-10, 15-13…),
// matches best of 5 (groups) or 7 (KO/finals).
//
// NOTE — team ties (Swaythling / modern ITTF club format: a "match" = 4–5
// individual matches, first to 3) are a *stage-level* feature: the competition
// engine aggregates child fixtures via Fixture.parent_fixture_id (schema
// reserves the column). That is NOT this module's concern — this module scores a
// single singles/doubles fixture only (table-tennis.md §4).
import type { PositionCatalog } from "../../sport/catalog.ts";
import { makeSetBasedModule } from "./kernel.ts";

// table-tennis.md §6 — no positions; singles/doubles/mixed = entrant kind (same
// as badminton). One nominated unit per side.
const positions: PositionCatalog = {
  groups: [],
  lineup: { size: 1, benchMax: 1 },
};

export const tabletennis = makeSetBasedModule({
  key: "tabletennis",
  version: "1.0.0",
  // spec 04 §5 — ITTF: games to 11, win by 2, no cap; best of 5 by default.
  defaults: {
    bestOf: 5,
    setTo: 11,
    finalSetTo: 11,
    winBy: 2,
    cap: null,
    pointsMap: { "*": [2, 0] }, // league convention 2/0; configurable
  },
  variants: {
    bo5: {},
    bo7: { bestOf: 7 }, // KO / finals
    "hardbat-21": { setTo: 21, finalSetTo: 21 }, // legacy/social — kernel unchanged
  },
  positions,
  unitLabel: { one: "Game", many: "Games" },
  // spec 04 §5 / table-tennis.md §5 — matches → h2h → game ratio → point ratio.
  defaultTiebreakers: ["points", "wins", "set_ratio", "point_ratio", "h2h_points"],
  officialLabel: { scorer: "Umpire" }, // doc 13 §1
  coarseEventType: "game.summary",
  rallyEntitlement: "scoring.rally_by_rally", // doc 10 / table-tennis.md §3
  entrantModel: { kinds: ["individual", "pair"], defaultKind: "individual" },
});
