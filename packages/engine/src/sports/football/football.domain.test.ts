// W4 domain audit — the scorebook facts football.ts gained in this wave.
// Companion to football.test.ts (which pins the pre-W4 machine) and to
// DOMAIN.md (which is the audit itself). Every test here must fail without
// the matching fold change.
import { describe, expect, it } from "vitest";
import { foldMatch, type CoreEv, type EventEnvelope } from "../../core/events.ts";
import type { Lineup, LineupPair } from "../../core/types.ts";
import { lineupFromCatalog, makeEnvelope } from "../../testkit/index.ts";
import { football, type FootballCfg, type FootballEv } from "./football.ts";

const asFootball = (event: EventEnvelope) => event as EventEnvelope<FootballEv | CoreEv>;

// Catalog-valid XI plus a six-man bench — enough to exhaust a substitution cap.
function lineupWithBench(entrantId: string, benchSize = 6): Lineup {
  const base = lineupFromCatalog(football.positions, entrantId);
  return {
    ...base,
    slots: [
      ...base.slots,
      ...Array.from({ length: benchSize }, (_, i) => ({
        personId: `${entrantId}-b${i + 1}`,
        slot: "bench" as const,
        orderNo: 12 + i,
      })),
    ],
  };
}
const lineups: LineupPair = { home: lineupWithBench("H"), away: lineupWithBench("A") };

function stream(...specs: Array<[type: string, payload?: unknown]>): EventEnvelope[] {
  return specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));
}
const cfgOf = (raw: unknown): FootballCfg => football.configSchema.parse(raw);
const fold = (cfg: FootballCfg, events: EventEnvelope[]) =>
  foldMatch(football, cfg, lineups, events);

const sub = (off: string, on: string): [string, unknown] => [
  "football.sub",
  { by: "H", off, on },
];

// ---------------------------------------------------------------------------
// Law 3 — substitutions. 11-a-side uses return-forbidden subs under a cap;
// youth and small-sided football use repeat ("rolling"/"flying") substitutions.
// ---------------------------------------------------------------------------

describe("substitution rules per variant (Law 3)", () => {
  it("keeps return substitutions illegal by default (11-a-side)", () => {
    expect(() =>
      fold(cfgOf({}), stream(["core.start"], sub("H-p1", "H-b1"), sub("H-b1", "H-p1"))),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });

  it("lets a substituted player return when cfg.rollingSubs is on", () => {
    const state = fold(
      cfgOf({ rollingSubs: true }),
      stream(["core.start"], sub("H-p1", "H-b1"), sub("H-b1", "H-p1")),
    );
    expect(state.squads.home.onPitch).toContain("H-p1");
    expect(state.squads.home.onPitch).not.toContain("H-b1");
    // The player who came off goes back to the bench, not to offUsed.
    expect(state.squads.home.bench).toContain("H-b1");
    expect(state.squads.home.offUsed).toEqual([]);
  });

  it("refuses the substitution that would exceed cfg.maxSubs", () => {
    const cfg = cfgOf({ maxSubs: 3 });
    const three = stream(
      ["core.start"],
      sub("H-p1", "H-b1"),
      sub("H-p2", "H-b2"),
      sub("H-p3", "H-b3"),
    );
    expect(fold(cfg, three).squads.home.offUsed).toHaveLength(3);
    expect(() =>
      fold(cfg, [...three, makeEnvelope(4, { type: "football.sub", payload: { by: "H", off: "H-p4", on: "H-b4" } })]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });

  it("counts the cap per side, not per fixture", () => {
    const cfg = cfgOf({ maxSubs: 1 });
    const state = fold(
      cfg,
      stream(
        ["core.start"],
        sub("H-p1", "H-b1"),
        ["football.sub", { by: "A", off: "A-p1", on: "A-b1" }],
      ),
    );
    expect(state.squads.home.offUsed).toEqual(["H-p1"]);
    expect(state.squads.away.offUsed).toEqual(["A-p1"]);
  });

  it("never caps a rolling-substitution match", () => {
    const cfg = cfgOf({ rollingSubs: true, maxSubs: 1 });
    const state = fold(
      cfg,
      stream(["core.start"], sub("H-p1", "H-b1"), sub("H-p2", "H-b2"), sub("H-b1", "H-p1")),
    );
    expect(state.squads.home.onPitch).toContain("H-p1");
    expect(state.squads.home.onPitch).toContain("H-b2");
  });

  it("declares rolling substitutions on the youth and small-sided variants", () => {
    expect(football.variants.youth?.rollingSubs).toBe(true);
    expect(football.variants["small-sided"]?.rollingSubs).toBe(true);
    expect(football.variants["11-a-side"]?.rollingSubs).toBeUndefined();
  });
});
