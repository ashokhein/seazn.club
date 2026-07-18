// Volleyball — set-based preset (spec 04 §3 + engine/sports/volleyball.md).
// Indoor {5,25,15,2,null} + beach {3,21,15,2,null}; FIVB match-points convention
// (3-0/3-1 → 3:0, 3-2 → 2:1) via pointsMap; S/OH/MB/OPP/L catalog with a libero
// role (validation only — positions never touch scoring). The kernel owns all
// set logic; this file is configuration.
import type { PositionCatalog } from "../../sport/catalog.ts";
import { makeSetBasedModule, type SetBasedParams } from "./kernel.ts";

// spec 04 §3.4 — FIVB league convention. "*" (clean 3-0/3-1) → 3:0; the 3-2
// split is the only exception → 2:1. Total is 3 either way (declaredPointsSets).
const FIVB_POINTS: SetBasedParams["pointsMap"] = { "3-2": [2, 1], "*": [3, 0] };

// engine/sports/volleyball.md §5 — S (setter) / OH (outside) / MB (middle) /
// OPP (opposite) / L (libero); 6 on court, libero as a role tracked for lineups
// only (rotation is Pro-stat metadata, referees enforce it, not us).
const positions: PositionCatalog = {
  groups: [
    { key: "S", name: "Setter" },
    { key: "OH", name: "Outside hitter" },
    { key: "MB", name: "Middle blocker" },
    { key: "OPP", name: "Opposite" },
    { key: "L", name: "Libero" },
  ],
  roles: [{ key: "libero", name: "Libero" }], // up to 2 per team → not unique
  lineup: { size: 6, benchMax: 8 },
};

export const volleyball = makeSetBasedModule({
  key: "volleyball",
  version: "1.0.0",
  // Default = indoor (spec 04 §3.1).
  defaults: {
    bestOf: 5,
    setTo: 25,
    finalSetTo: 15,
    winBy: 2,
    cap: null,
    pointsMap: FIVB_POINTS,
  },
  variants: {
    indoor: {},
    // Beach: pairs, best-of-3 to 21, deciding set to 15; simple 2-0 win points.
    beach: { bestOf: 3, setTo: 21, finalSetTo: 15, pointsMap: { "*": [2, 0] } },
  },
  positions,
  unitLabel: { one: "Set", many: "Sets" },
  // spec 04 §3.4 — points → matches won → set ratio → point ratio → h2h.
  defaultTiebreakers: ["points", "wins", "set_ratio", "point_ratio", "h2h_points"],
  officialLabel: { scorer: "Referee" }, // doc 13 §1
  coarseEventType: "set.summary",
  rallyEntitlement: "scoring.rally_by_rally", // doc 10 / volleyball.md §3
  entrantModel: { kinds: ["team"], defaultKind: "team", team: { squadNumbers: true, captain: true } },
});

// Jul3/06 §3 — the 12-Jun scoresheet: point-by-point columns per set,
// signature lines, final result, two matches per A4 (columnsHint: 2).
import type { ScoresheetInput } from "../../sport/module.ts";
import type { DocSection } from "../../exports/types.ts";

function pointTally(to: number): string {
  return Array.from({ length: to }, (_, i) => String(i + 1)).join(" ");
}

volleyball.exportTemplates = {
  scoresheet(input: ScoresheetInput, cfg): DocSection[] {
    const c = cfg as { bestOf?: number; setTo?: number; finalSetTo?: number };
    const bestOf = c.bestOf ?? 5;
    const setTo = c.setTo ?? 25;
    const finalTo = c.finalSetTo ?? 15;
    const rows: (string | number)[][] = [];
    for (let set = 1; set <= bestOf; set++) {
      const to = set === bestOf ? finalTo : setTo;
      rows.push([`Set ${set}`, input.home, pointTally(to)]);
      rows.push(["", input.away, pointTally(to)]);
    }
    return [
      {
        heading: `${input.home} vs ${input.away}`,
        subheading: [input.at, input.court, input.stageName]
          .filter((x): x is string => x !== undefined)
          .join(" · "),
        ...(input.homeColor !== undefined || input.awayColor !== undefined
          ? {
              swatches: [
                ...(input.homeColor !== undefined
                  ? [{ label: input.home, color: input.homeColor }]
                  : []),
                ...(input.awayColor !== undefined
                  ? [{ label: input.away, color: input.awayColor }]
                  : []),
              ],
            }
          : {}),
        table: { columns: ["Set", "Team", "Points"], rows },
        formLines: ["Final result: ________________", "Winner: ________________"],
        signatures: ["1st referee", "Scorer", `Captain — ${input.home}`, `Captain — ${input.away}`],
        columnsHint: 2,
      },
    ];
  },
};
