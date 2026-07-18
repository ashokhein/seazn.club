// Badminton — set-based preset (spec 04 §4 + engine/sports/badminton.md).
// {3,21,21,2,30}: rally to 21, win by 2, hard cap 30 (29-29 → golden point,
// 30-29 wins) — the cap is the differentiator vs volleyball's uncapped endgame.
// Disciplines (MS/WS/MD/WD/XD) are entrant-kind + eligibility combinations, NOT
// module variants — one module serves all five, so there are no positions.
import type { PositionCatalog } from "../../sport/catalog.ts";
import { makeSetBasedModule } from "./kernel.ts";

// badminton.md §7 — no positions; singles vs doubles is the entrant kind
// (doc 02 §2), which the module never inspects (scoring reads only wonBy). One
// nominated unit per side.
const positions: PositionCatalog = {
  groups: [],
  lineup: { size: 1, benchMax: 1 },
};

export const badminton = makeSetBasedModule({
  key: "badminton",
  version: "1.0.0",
  // spec 04 §4 — game to 21, deciding game also to 21, hard cap 30.
  defaults: {
    bestOf: 3,
    setTo: 21,
    finalSetTo: 21,
    winBy: 2,
    cap: 30,
    // Typical league: flat win points (2/0); configurable per competition.
    pointsMap: { "*": [2, 0] },
  },
  variants: {
    bwf: {},
    // Junior/social short format: to 11, cap 15 (badminton.md §2).
    short: { setTo: 11, finalSetTo: 11, cap: 15 },
  },
  positions,
  unitLabel: { one: "Game", many: "Games" },
  // spec 04 §4 — points → matches → game ratio → point ratio → h2h. game_ratio
  // is the set_ratio key (games are the kernel's sets).
  defaultTiebreakers: ["points", "wins", "set_ratio", "point_ratio", "h2h_points"],
  officialLabel: { scorer: "Umpire" }, // doc 13 §1
  coarseEventType: "game.summary",
  rallyEntitlement: "scoring.rally_by_rally", // doc 10 / badminton.md §3
  entrantModel: { kinds: ["individual", "pair"], defaultKind: "individual" },
});
