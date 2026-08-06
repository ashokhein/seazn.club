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
import type { AnySportModule } from "../sport/module.ts";
import { football } from "../sports/football/index.ts";
import { buildStream, defaultLineupPair } from "./helpers.ts";
import {
  MAX_EVENTS,
  MIN_EVENTS,
  configStateKey,
  jsonObjectMembers,
  keepRecordedConfig,
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
    expect(stateMismatch(recorded, recorded, "cfg")).toBeNull();
  });

  // The defect this item fixes.
  it("allows a NEW cfg key — an optional config knob is additive", () => {
    const actual = replayed((s) => {
      (s.cfg as Record<string, unknown>).teamSize = 7;
    });
    expect(stateMismatch(actual, recorded, "cfg")).toBeNull();
  });

  it("allows a new key nested inside a recorded cfg object", () => {
    const actual = replayed((s) => {
      ((s.cfg as Record<string, unknown>).points as Record<string, unknown>).shootoutWin = 2;
    });
    expect(stateMismatch(actual, recorded, "cfg")).toBeNull();
  });

  it("allows a defaulted cfg key that lands anywhere in key order", () => {
    const cfg = JSON.parse(recorded).cfg as Record<string, unknown>;
    const actual = JSON.stringify({
      cfg: { abandonPolicy: "replay", ...cfg },
      phase: "live",
      goals: { home: 1, away: 0 },
    });
    expect(stateMismatch(actual, recorded, "cfg")).toBeNull();
  });

  // ------------------------------------------------------------ the tripwire

  it("still reds on a CHANGED value for a recorded cfg key", () => {
    const actual = replayed((s) => {
      (s.cfg as Record<string, unknown>).halfMinutes = 40;
    });
    expect(stateMismatch(actual, recorded, "cfg")).toContain("cfg.halfMinutes");
  });

  it("still reds on a changed value nested in a recorded cfg object", () => {
    const actual = replayed((s) => {
      ((s.cfg as Record<string, unknown>).points as Record<string, unknown>).win = 2;
    });
    expect(stateMismatch(actual, recorded, "cfg")).toContain("cfg.points.win");
  });

  it("still reds on a REMOVED cfg key", () => {
    const actual = replayed((s) => {
      delete (s.cfg as Record<string, unknown>).halfMinutes;
    });
    expect(stateMismatch(actual, recorded, "cfg")).toContain("cfg.halfMinutes");
  });

  it("still reds on an appended element in a recorded cfg array", () => {
    const actual = replayed((s) => {
      (s.cfg as Record<string, unknown>).goalKinds = ["fg", "og", "pc"];
    });
    expect(stateMismatch(actual, recorded, "cfg")).toContain("cfg.goalKinds");
  });

  it("still reds on a fold change — the score moved", () => {
    const actual = replayed((s) => {
      (s.goals as Record<string, unknown>).home = 2;
    });
    expect(stateMismatch(actual, recorded, "cfg")).not.toBeNull();
  });

  it("still reds on a NEW non-cfg state key — only cfg is subset-compared", () => {
    const actual = replayed((s) => {
      s.penalties = [];
    });
    expect(stateMismatch(actual, recorded, "cfg")).not.toBeNull();
  });

  it("still reds on a removed non-cfg state key", () => {
    const actual = replayed((s) => {
      delete s.phase;
    });
    expect(stateMismatch(actual, recorded, "cfg")).not.toBeNull();
  });

  it("still reds when non-cfg key ORDER changes — serialisation stays exact", () => {
    const parsed = JSON.parse(recorded) as Record<string, unknown>;
    const actual = JSON.stringify({ cfg: parsed.cfg, goals: parsed.goals, phase: parsed.phase });
    expect(stateMismatch(actual, recorded, "cfg")).not.toBeNull();
  });

  it("compares states that carry no cfg at all exactly", () => {
    const a = JSON.stringify({ phase: "live", goals: 1 });
    expect(stateMismatch(a, a, null)).toBeNull();
    expect(
      stateMismatch(JSON.stringify({ phase: "live", goals: 1, extra: 0 }), a, null),
    ).not.toBeNull();
  });

  // A module gaining or losing `cfg` in its state IS a fold change, so the
  // subset rule must not swallow either direction.
  it("still reds when the golden recorded no cfg but the replay has one", () => {
    const golden = JSON.stringify({ phase: "live" });
    const actual = JSON.stringify({ cfg: { halfMinutes: 45 }, phase: "live" });
    expect(stateMismatch(actual, golden, "cfg")).not.toBeNull();
  });

  it("still reds when the golden recorded a cfg but the replay dropped it", () => {
    const golden = JSON.stringify({ cfg: { halfMinutes: 45 }, phase: "live" });
    const actual = JSON.stringify({ phase: "live" });
    expect(stateMismatch(actual, golden, "cfg")).not.toBeNull();
  });

  it("reds when cfg stops being an object", () => {
    const actual = replayed((s) => {
      s.cfg = null;
    });
    expect(stateMismatch(actual, recorded, "cfg")).not.toBeNull();
  });
});

// ------------------------------------------------------- #429 scope item 4a
//
// The subset tolerance used to be handed to whatever top-level key was
// literally spelled `cfg`. That is a claim about a SPELLING standing in for a
// claim about the module, and it is wrong in the direction that matters: a
// module embedding its parsed config under any other name silently loses the
// tolerance, so an additive config knob reds its corpus — the precise failure
// the tolerance was introduced to prevent, and one that would be diagnosed as a
// fold change. Where the config lives is now derived from the module
// (`configStateKey`) and passed in.

/** A module stub whose only interesting property is WHERE `init` files the
 *  parsed config. Only `configSchema.parse` and `init` are ever reached. */
function stubModule(init: (cfg: unknown) => unknown): AnySportModule {
  return {
    key: "stub",
    configSchema: { parse: (raw: unknown) => ({ ...(raw as object), halfMinutes: 45 }) },
    init,
  } as unknown as AnySportModule;
}

const stubLineups = defaultLineupPair(resolvePositions(football, football.configSchema.parse({})));

describe("configStateKey — the config is located by the module, never by its name", () => {
  it("finds football's config, which happens to be at 'cfg'", () => {
    expect(configStateKey(football, {})).toBe("cfg");
  });

  it("finds a config the module files under another name", () => {
    const module = stubModule((cfg) => ({ phase: "pre", settings: cfg }));
    expect(configStateKey(module, {}, stubLineups)).toBe("settings");
  });

  it("finds a config the module COPIES rather than stores by reference", () => {
    const module = stubModule((cfg) => ({ settings: { ...(cfg as object) } }));
    expect(configStateKey(module, {}, stubLineups)).toBe("settings");
  });

  it("ignores a NESTED key named cfg — nesting is not where a config lives", () => {
    const module = stubModule((cfg) => ({ settings: cfg, inner: { cfg: { decoy: true } } }));
    expect(configStateKey(module, {}, stubLineups)).toBe("settings");
  });

  it("returns null when the module embeds no config in its state at all", () => {
    const module = stubModule(() => ({ phase: "pre", goals: 0 }));
    expect(configStateKey(module, {}, stubLineups)).toBeNull();
  });

  it("returns null rather than guessing when the module cannot be initialised", () => {
    const module = stubModule(() => {
      throw new Error("no lineups");
    });
    expect(configStateKey(module, {}, stubLineups)).toBeNull();
  });
});

describe("stateMismatch — the subset tolerance follows the config, not the name", () => {
  const settingsGolden = JSON.stringify({ settings: { halfMinutes: 45 }, phase: "live" });

  it("gives the subset tolerance to a config key that is NOT named cfg", () => {
    const actual = JSON.stringify({
      settings: { halfMinutes: 45, teamSize: 7 },
      phase: "live",
    });
    expect(stateMismatch(actual, settingsGolden, "settings")).toBeNull();
  });

  it("still reds on a changed value under a config key not named cfg", () => {
    const actual = JSON.stringify({ settings: { halfMinutes: 40 }, phase: "live" });
    expect(stateMismatch(actual, settingsGolden, "settings")).toContain("settings.halfMinutes");
  });

  it("still reds on a fold change alongside a config key not named cfg", () => {
    const actual = JSON.stringify({ settings: { halfMinutes: 45 }, phase: "done" });
    expect(stateMismatch(actual, settingsGolden, "settings")).not.toBeNull();
  });

  it("does NOT give the tolerance to a nested key named cfg", () => {
    const golden = JSON.stringify({ settings: { a: 1 }, inner: { cfg: { x: 1 } } });
    const actual = JSON.stringify({ settings: { a: 1 }, inner: { cfg: { x: 1, y: 2 } } });
    expect(stateMismatch(actual, golden, "settings")).not.toBeNull();
  });

  it("does NOT give the tolerance to a nested cfg when the config IS named cfg", () => {
    const golden = JSON.stringify({ cfg: { a: 1 }, inner: { cfg: { x: 1 } } });
    const actual = JSON.stringify({ cfg: { a: 1 }, inner: { cfg: { x: 1, y: 2 } } });
    expect(stateMismatch(actual, golden, "cfg")).not.toBeNull();
  });

  it("compares a key named cfg EXACTLY when the module embeds no config", () => {
    const golden = JSON.stringify({ cfg: { a: 1 }, phase: "live" });
    const actual = JSON.stringify({ cfg: { a: 1, b: 2 }, phase: "live" });
    expect(stateMismatch(actual, golden, null)).not.toBeNull();
  });

  it("finds the config wherever it sits in key order (generic files phase first)", () => {
    const golden = JSON.stringify({ phase: "live", cfg: { halfMinutes: 45 } });
    const actual = JSON.stringify({ phase: "live", cfg: { halfMinutes: 45, teamSize: 7 } });
    expect(stateMismatch(actual, golden, "cfg")).toBeNull();
  });
});

// ------------------------------------------------------- #429 scope item 4b
//
// `JSON.parse` does not preserve key order: array-index-like own keys come
// first, ascending, whatever the text said. The comparison parsed BOTH sides
// and re-serialised them, so it normalised them identically and a genuine
// order change between the recorded and the replayed state came out EQUAL —
// a false green on the exact-equality half, which is the half that carries the
// entire fold. The fix drops the round-trip rather than sorting after it: a
// sort picks a canonical order, and the comparison needs the RECORDED one.
//
// These states are written as literals on purpose. An object literal reorders
// integer-like keys at construction, so `JSON.stringify({ "2": …, "1": … })`
// cannot express the fixture this needs.

describe("stateMismatch — order-stable across integer-like state keys", () => {
  const numericGolden = '{"cfg":{"halfMinutes":45},"2":"b","1":"a"}';

  it("reds when integer-like non-config keys were recorded in a different order", () => {
    const reordered = '{"cfg":{"halfMinutes":45},"1":"a","2":"b"}';
    expect(stateMismatch(reordered, numericGolden, "cfg")).not.toBeNull();
  });

  it("reds when the config key itself moves relative to integer-like keys", () => {
    const reordered = '{"2":"b","1":"a","cfg":{"halfMinutes":45}}';
    expect(stateMismatch(reordered, numericGolden, "cfg")).not.toBeNull();
  });

  it("reds on a changed value under an integer-like key", () => {
    const changed = '{"cfg":{"halfMinutes":45},"2":"z","1":"a"}';
    expect(stateMismatch(changed, numericGolden, "cfg")).not.toBeNull();
  });

  it("still allows an additive config knob alongside integer-like keys", () => {
    const additive = '{"cfg":{"halfMinutes":45,"teamSize":7},"2":"b","1":"a"}';
    expect(stateMismatch(additive, numericGolden, "cfg")).toBeNull();
  });

  it("keeps the RECORDED order in the mismatch message", () => {
    const changed = '{"cfg":{"halfMinutes":45},"2":"z","1":"a"}';
    const message = stateMismatch(changed, numericGolden, "cfg");
    // The recorded text said "2" before "1"; a round-tripped message says "1"
    // before "2" and misdescribes the corpus a reviewer is about to inspect.
    expect(message).toContain(`"2":"b","1":"a"`);
  });
});

// `keepRecordedConfig` is the OTHER round-trip, and the one with teeth: it runs
// on the WRITE path, so a re-baseline that reorders keys writes the reordered
// state into the corpus and the next replay reds on an ordering the re-baseline
// itself introduced. Driven directly — a fold cannot be made to produce an
// integer-like state key on demand, and going through `rebaselineCorpus` with
// football states exercises none of this.
describe("keepRecordedConfig — writes back the LIVE fold's bytes, config aside", () => {
  it("splices the recorded config value into the fresh state", () => {
    expect(keepRecordedConfig(`{"cfg":{"x":1},"phase":"live"}`, `{"cfg":{"x":9}}`, "cfg")).toBe(
      `{"cfg":{"x":9},"phase":"live"}`,
    );
  });

  it("keeps the FRESH state's key order, integer-like keys included", () => {
    expect(keepRecordedConfig('{"2":"b","1":"a","cfg":{"x":1}}', '{"cfg":{"x":9}}', "cfg")).toBe(
      '{"2":"b","1":"a","cfg":{"x":9}}',
    );
  });

  it("keeps the fresh state's non-config bytes exactly", () => {
    const fresh = '{"cfg":{"x":1},"goals":{"home":2,"away":0},"cards":[]}';
    expect(keepRecordedConfig(fresh, '{"cfg":{"x":1}}', "cfg")).toBe(fresh);
  });

  it("finds the config under a key that is not named cfg", () => {
    expect(
      keepRecordedConfig(`{"phase":"live","settings":{"x":1}}`, `{"settings":{"x":9}}`, "settings"),
    ).toBe(`{"phase":"live","settings":{"x":9}}`);
  });

  it("leaves the fresh state alone when there is no config to keep", () => {
    const fresh = `{"cfg":{"x":1},"phase":"live"}`;
    expect(keepRecordedConfig(fresh, fresh, null)).toBe(fresh);
    expect(keepRecordedConfig(fresh, `{"phase":"live"}`, "cfg")).toBe(fresh);
    expect(keepRecordedConfig(`{"phase":"live"}`, fresh, "cfg")).toBe(`{"phase":"live"}`);
    expect(keepRecordedConfig("not json", fresh, "cfg")).toBe("not json");
    expect(keepRecordedConfig(fresh, "not json", "cfg")).toBe(fresh);
  });
});

describe("jsonObjectMembers — the source-text split the order-stability rests on", () => {
  it("keeps integer-like keys in the order the text wrote them", () => {
    const members = jsonObjectMembers('{"2":"b","10":"c","1":"a"}');
    expect(members?.map((m) => m.key)).toEqual(["2", "10", "1"]);
  });

  it("keeps each value as its exact bytes, nested values included", () => {
    const members = jsonObjectMembers('{"a":{"z":1,"y":[2,3]},"b":null,"c":-1.5e3}');
    expect(members?.map((m) => m.rawValue)).toEqual([`{"z":1,"y":[2,3]}`, "null", "-1.5e3"]);
  });

  it("handles braces, brackets, colons and escapes inside strings", () => {
    const members = jsonObjectMembers('{"a":"{\\"x\\": [1,2]}","b":2}');
    expect(members?.map((m) => m.key)).toEqual(["a", "b"]);
    expect(members?.[1]?.rawValue).toBe("2");
  });

  it("keeps an escaped key's source text and decodes the key", () => {
    const members = jsonObjectMembers('{"a\\"b":1}');
    expect(members?.[0]?.key).toBe(`a"b`);
    expect(members?.[0]?.rawKey).toBe('"a\\"b"');
  });

  it("reads an empty object", () => {
    expect(jsonObjectMembers("{}")).toEqual([]);
  });

  it("returns null for anything that is not a JSON object", () => {
    for (const text of ["[1,2]", `"str"`, "null", "17", "", "{", `{"a":}`, `{"a":1`, `{"a":1}x`]) {
      expect(jsonObjectMembers(text), text).toBeNull();
    }
  });

  it("round-trips every recorded state key of a real fold", () => {
    const cfg = football.configSchema.parse({});
    const events: GoldenEvent[] = buildStream(
      football,
      cfg,
      defaultLineupPair(resolvePositions(football, cfg)),
      1,
      3,
    ).map((e) => ({ type: e.type, payload: e.payload }));
    const state = recomputeStream(football, {}, events).states[0] as string;
    const members = jsonObjectMembers(state);
    expect(members).not.toBeNull();
    expect(`{${(members ?? []).map((m) => `${m.rawKey}:${m.rawValue}`).join(",")}}`).toBe(state);
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
    expect(stateMismatch(fresh, JSON.stringify(state), "cfg")).toContain("cfg.halfMinutes");
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
