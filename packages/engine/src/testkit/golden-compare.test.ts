// W4 shared-engine item 5 (#407) — the golden harness over-constrained config.
//
// `recomputeStream` records JSON.stringify of the WHOLE folded state after
// every event, and every module carries its parsed `cfg` inside that state. So
// a zod `.default()` on ANY new config key shifted the resolved cfg and turned
// every golden for that module red — even though adding an optional config knob
// is by definition additive and cannot change a single fold. The period family
// had to route around it with a compile-time preset field instead of a config
// field, which is a workaround for a harness defect, not a design.
//
// The fix: `cfg` is compared as a SUBSET — every key the golden recorded must
// still be present with an identical value, new keys are allowed. Everything
// else about the state comparison stays exact, and the tripwire must still bite.
import { describe, expect, it } from "vitest";
import { stateMismatch } from "./golden.ts";

const recorded = JSON.stringify({
  cfg: { halfMinutes: 45, points: { win: 3, draw: 1 }, goalKinds: ["fg", "og"] },
  phase: "live",
  goals: { home: 1, away: 0 },
});

/** The recorded state with `mutate` applied to the parsed object. */
function replayed(mutate: (state: Record<string, unknown>) => void): string {
  const state = JSON.parse(recorded) as Record<string, unknown>;
  mutate(state);
  return JSON.stringify(state);
}

describe("stateMismatch — cfg is a subset, everything else is exact", () => {
  it("matches a byte-identical state", () => {
    expect(stateMismatch(recorded, recorded)).toBeNull();
  });

  // The defect this item fixes.
  it("allows a NEW cfg key — an optional config knob is additive", () => {
    const actual = replayed((s) => {
      (s.cfg as Record<string, unknown>).teamSize = 7;
    });
    expect(stateMismatch(actual, recorded)).toBeNull();
  });

  it("allows a new key nested inside a recorded cfg object", () => {
    const actual = replayed((s) => {
      ((s.cfg as Record<string, unknown>).points as Record<string, unknown>).shootoutWin = 2;
    });
    expect(stateMismatch(actual, recorded)).toBeNull();
  });

  it("allows a defaulted cfg key that lands anywhere in key order", () => {
    const cfg = JSON.parse(recorded).cfg as Record<string, unknown>;
    const actual = JSON.stringify({
      cfg: { abandonPolicy: "replay", ...cfg },
      phase: "live",
      goals: { home: 1, away: 0 },
    });
    expect(stateMismatch(actual, recorded)).toBeNull();
  });

  // ------------------------------------------------------------ the tripwire

  it("still reds on a CHANGED value for a recorded cfg key", () => {
    const actual = replayed((s) => {
      (s.cfg as Record<string, unknown>).halfMinutes = 40;
    });
    expect(stateMismatch(actual, recorded)).toContain("cfg.halfMinutes");
  });

  it("still reds on a changed value nested in a recorded cfg object", () => {
    const actual = replayed((s) => {
      ((s.cfg as Record<string, unknown>).points as Record<string, unknown>).win = 2;
    });
    expect(stateMismatch(actual, recorded)).toContain("cfg.points.win");
  });

  it("still reds on a REMOVED cfg key", () => {
    const actual = replayed((s) => {
      delete (s.cfg as Record<string, unknown>).halfMinutes;
    });
    expect(stateMismatch(actual, recorded)).toContain("cfg.halfMinutes");
  });

  it("still reds on an appended element in a recorded cfg array", () => {
    const actual = replayed((s) => {
      (s.cfg as Record<string, unknown>).goalKinds = ["fg", "og", "pc"];
    });
    expect(stateMismatch(actual, recorded)).toContain("cfg.goalKinds");
  });

  it("still reds on a fold change — the score moved", () => {
    const actual = replayed((s) => {
      (s.goals as Record<string, unknown>).home = 2;
    });
    expect(stateMismatch(actual, recorded)).not.toBeNull();
  });

  it("still reds on a NEW non-cfg state key — only cfg is subset-compared", () => {
    const actual = replayed((s) => {
      s.penalties = [];
    });
    expect(stateMismatch(actual, recorded)).not.toBeNull();
  });

  it("still reds on a removed non-cfg state key", () => {
    const actual = replayed((s) => {
      delete s.phase;
    });
    expect(stateMismatch(actual, recorded)).not.toBeNull();
  });

  it("still reds when non-cfg key ORDER changes — serialisation stays exact", () => {
    const parsed = JSON.parse(recorded) as Record<string, unknown>;
    const actual = JSON.stringify({ cfg: parsed.cfg, goals: parsed.goals, phase: parsed.phase });
    expect(stateMismatch(actual, recorded)).not.toBeNull();
  });

  it("compares states that carry no cfg at all exactly", () => {
    const a = JSON.stringify({ phase: "live", goals: 1 });
    expect(stateMismatch(a, a)).toBeNull();
    expect(stateMismatch(JSON.stringify({ phase: "live", goals: 1, extra: 0 }), a)).not.toBeNull();
  });

  it("reds when cfg stops being an object", () => {
    const actual = replayed((s) => {
      s.cfg = null;
    });
    expect(stateMismatch(actual, recorded)).not.toBeNull();
  });
});
