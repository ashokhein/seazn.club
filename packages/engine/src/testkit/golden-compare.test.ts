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
import { resolvePositions } from "../sport/catalog.ts";
import { football } from "../sports/football/index.ts";
import { buildStream, defaultLineupPair } from "./helpers.ts";
import {
  MAX_EVENTS,
  MIN_EVENTS,
  rebaselineCorpus,
  recomputeStream,
  stateMismatch,
  type GoldenCorpus,
  type GoldenEvent,
} from "./golden.ts";

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

  // A module gaining or losing `cfg` in its state IS a fold change, so the
  // subset rule must not swallow either direction.
  it("still reds when the golden recorded no cfg but the replay has one", () => {
    const golden = JSON.stringify({ phase: "live" });
    const actual = JSON.stringify({ cfg: { halfMinutes: 45 }, phase: "live" });
    expect(stateMismatch(actual, golden)).not.toBeNull();
  });

  it("still reds when the golden recorded a cfg but the replay dropped it", () => {
    const golden = JSON.stringify({ cfg: { halfMinutes: 45 }, phase: "live" });
    const actual = JSON.stringify({ phase: "live" });
    expect(stateMismatch(actual, golden)).not.toBeNull();
  });

  it("reds when cfg stops being an object", () => {
    const actual = replayed((s) => {
      s.cfg = null;
    });
    expect(stateMismatch(actual, recorded)).not.toBeNull();
  });
});

// ------------------------------------------------ the cfg tolerance's limit
//
// W4a (#425) T10. `rebaselineCorpus` swaps the RECORDED cfg back into every
// re-folded state (`keepRecordedCfg`), wholesale, and that reads at a glance
// like "a cfg change can never red a golden". It is narrower than that, and the
// difference is what a reader must not over-trust:
//
//   - A NEW cfg key is invisible to a golden, deliberately and permanently.
//     `stateMismatch` compares cfg as a subset (W4 item 5) because a `.default()`
//     on an additive knob shifts the resolved cfg in every frozen state while
//     changing no fold; without the tolerance the period family had to route
//     around the harness with a compile-time preset instead of a config field.
//     The tolerance CANNOT be narrowed without re-breaking that.
//   - A CHANGED value on a recorded cfg key still reds, and — the part worth
//     pinning — a re-baseline does not launder it. `keepRecordedCfg` writes the
//     old value back, so the very next replay reds on the same key again. It can
//     leave a red red; it cannot turn a red green.
//
// So: DOCUMENTED AS PERMANENT, not narrowed. A green golden proves the fold is
// unchanged under the cfg the corpus recorded — it proves nothing about a cfg
// key the corpus never recorded, and the conformance kit owns that dimension.

/** A short real-football corpus whose LAST recorded state is `mutate`d — the
 *  mutator gets the whole state, so a fixture can make the recorded non-cfg
 *  half differ from the live fold (which is the situation a re-baseline exists
 *  for) and not only the cfg. */
function cfgCorpus(mutate: (state: Record<string, unknown>) => void): {
  corpus: GoldenCorpus;
  fresh: string;
} {
  // A real (short) generated stream rather than a hand-written goal: football
  // refuses a goal in phase "pre", so the kick-off has to be genuine.
  const cfg = football.configSchema.parse({});
  const events: GoldenEvent[] = buildStream(
    football,
    cfg,
    defaultLineupPair(resolvePositions(football, cfg)),
    1,
    3,
  ).map((e) => ({ type: e.type, payload: e.payload }));
  const states = recomputeStream(football, {}, events).states;
  const fresh = states[states.length - 1] as string;
  const state = JSON.parse(fresh) as Record<string, unknown>;
  mutate(state);
  return {
    fresh,
    corpus: {
      key: "football",
      version: football.version,
      recordedBy: "testkit/golden.ts",
      params: { minEvents: MIN_EVENTS, maxEvents: MAX_EVENTS },
      configs: { default: {} },
      streams: [
        {
          config: "default",
          seed: 1,
          events,
          states: [...states.slice(0, -1), JSON.stringify(state)],
          outcome: "null",
          summary: "{}",
          deltas: "{}",
        },
      ],
    },
  };
}

function rebaselinedState(corpus: GoldenCorpus): Record<string, unknown> {
  const out = rebaselineCorpus(football, corpus).streams[0]?.states ?? [];
  return JSON.parse(out[out.length - 1] as string) as Record<string, unknown>;
}

describe("rebaselineCorpus — what the cfg tolerance does and does not hide", () => {
  it("keeps the RECORDED cfg, so a re-baseline does not bake in a new knob", () => {
    // `abandonPolicy` standing in for a knob the corpus predates: the recorded
    // cfg has never carried it, the live one always resolves it.
    const { corpus } = cfgCorpus((state) => {
      delete (state.cfg as Record<string, unknown>).abandonPolicy;
    });
    const cfg = rebaselinedState(corpus).cfg as Record<string, unknown>;
    expect(Object.hasOwn(cfg, "abandonPolicy")).toBe(false);
  });

  it("does NOT launder a CHANGED cfg value — the next replay still reds", () => {
    const { corpus, fresh } = cfgCorpus((state) => {
      (state.cfg as Record<string, unknown>).halfMinutes = 40; // the module resolves 45
    });
    const state = rebaselinedState(corpus);
    expect((state.cfg as Record<string, unknown>).halfMinutes).toBe(40);
    // The whole point: re-baselining a corpus reddened by a cfg change leaves it
    // reddened. `keepRecordedCfg` can hold a red open; it cannot close one.
    expect(stateMismatch(fresh, JSON.stringify(state))).toContain("cfg.halfMinutes");
  });

  it("re-folds the NON-cfg half — that is what a re-baseline is for", () => {
    // The recorded state is STALE outside cfg (a fold change moved it), which is
    // the only situation a re-baseline is ever run in. The written state must
    // take the live fold's goals, not the recorded ones — otherwise the swap has
    // replaced the state wholesale and the re-baseline does nothing at all.
    const { corpus, fresh } = cfgCorpus((state) => {
      (state.cfg as Record<string, unknown>).halfMinutes = 40;
      (state.goals as Record<string, unknown>).home = 99;
    });
    const after = rebaselinedState(corpus);
    expect(after.goals).toEqual((JSON.parse(fresh) as Record<string, unknown>).goals);
    expect((after.goals as Record<string, unknown>).home).not.toBe(99);
    // ...while the cfg half still comes from the record.
    expect((after.cfg as Record<string, unknown>).halfMinutes).toBe(40);
  });
});
