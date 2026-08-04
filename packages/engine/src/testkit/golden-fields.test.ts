// W4a (#425) T10 — the FIELD half of the golden coverage gate.
//
// `uncoveredTierTypes` asks "does the corpus contain one event of every type
// the module declares". This asks the strictly harder question the wave needed
// and did not have: "does the corpus WRITE every optional field those payloads
// declare". It did not — after the sanctioned EXTEND_GOLDEN pass, not one of
// football's 274 or icehockey's 148 recorded events carried `at`, the field the
// whole wave exists to add, so a rename or a reshape of it reddened nothing.
//
// The corpora here are hand-built literals, not `readCorpus` — the mechanism is
// what is under test, and a synthetic ledger is the only way to assert both
// directions of "covered" without depending on what the frozen files happen to
// hold today.
import { describe, expect, it } from "vitest";
import { builtinModules } from "../sports/index.ts";
import { cricket } from "../sports/cricket/index.ts";
import { icehockey } from "../sports/icehockey/index.ts";
import { football } from "../sports/football/index.ts";
import { tennis } from "../sports/tennis/index.ts";
import {
  MAX_EVENTS,
  MIN_EVENTS,
  UNREACHABLE_CONFIG_FIELDS,
  UNREACHABLE_FIELDS,
  UNREACHABLE_STATE_PATHS,
  coverageTokens,
  declaredOptionalConfigFields,
  declaredOptionalFields,
  pinnedConfigFields,
  staleUnreachableConfigFields,
  staleUnreachableFields,
  staleUnreachableStatePaths,
  statePathsOf,
  uncoveredConfigFields,
  undeclaredUnreachableConfigFields,
  undeclaredUnreachableFields,
  uncoveredTierFields,
  unreachableStatePathsGoneStale,
  type GoldenCorpus,
  type GoldenEvent,
} from "./golden.ts";

function corpusOf(key: string, ...streams: GoldenEvent[][]): GoldenCorpus {
  return {
    key,
    version: "1.0.0",
    recordedBy: "testkit/golden.ts",
    params: { minEvents: MIN_EVENTS, maxEvents: MAX_EVENTS },
    configs: { default: {} },
    streams: streams.map((events, i) => ({
      config: "default",
      seed: i + 1,
      events,
      states: events.map(() => "{}"),
      outcome: "null",
      summary: "{}",
      deltas: "{}",
    })),
  };
}

/** A synthetic corpus with a chosen raw config and a chosen frozen state, so
 *  the two config PINS can be exercised one at a time. */
function cfgCorpusOf(key: string, rawConfig: unknown, frozenCfg?: unknown): GoldenCorpus {
  return {
    key,
    version: "1.0.0",
    recordedBy: "testkit/golden.ts",
    params: { minEvents: MIN_EVENTS, maxEvents: MAX_EVENTS },
    configs: { only: rawConfig },
    streams: [
      {
        config: "only",
        seed: 1,
        events: [],
        states: [JSON.stringify({ phase: "live", cfg: frozenCfg ?? {} })],
        outcome: "null",
        summary: "{}",
        deltas: "{}",
      },
    ],
  };
}

const goal = (payload: unknown): GoldenEvent => ({ type: "football.goal", payload });

describe("declaredOptionalFields", () => {
  it("is the module's own event union, not a hand-kept list", () => {
    const paths = declaredOptionalFields(football);
    expect(paths).toContain("at");
    expect(paths).toContain("addedMinutes"); // FootballPeriod
    expect(paths).toContain("goalkeeper"); // FootballPenalty
    expect(paths).not.toContain("by"); // required on six of eight branches
  });
});

describe("uncoveredTierFields", () => {
  it("does not list a field a recorded payload writes", () => {
    const missing = uncoveredTierFields(football, corpusOf("football", [goal({ by: "H", scorer: "p1" })]));
    expect(missing).not.toContain("scorer");
    expect(missing).toContain("at");
  });

  it("counts a field written on ANY stream, not just the first", () => {
    const missing = uncoveredTierFields(
      football,
      corpusOf("football", [goal({ by: "H" })], [goal({ by: "A", ownGoal: true })]),
    );
    expect(missing).not.toContain("ownGoal");
  });

  it("counts a field written on any EVENT of a stream, not just the first", () => {
    const missing = uncoveredTierFields(
      football,
      corpusOf("football", [goal({ by: "H" }), goal({ by: "A", penalty: true })]),
    );
    expect(missing).not.toContain("penalty");
  });

  it("counts a falsy written value as coverage — `false` is a recorded fact", () => {
    const missing = uncoveredTierFields(football, corpusOf("football", [goal({ by: "H", ownGoal: false })]));
    expect(missing).not.toContain("ownGoal");
  });

  it("resolves a nested path only when the leaf itself is written", () => {
    const withFielder = corpusOf("cricket", [
      { type: "cricket.ball", payload: { wicket: { kind: "caught", fielder: "p1" } } },
    ]);
    const missing = uncoveredTierFields(cricket, withFielder);
    expect(missing).not.toContain("wicket");
    expect(missing).not.toContain("wicket.fielder");
    // A sibling leaf is NOT covered by its parent object being written.
    expect(missing).toContain("wicket.fielderAssist");
  });

  it("reports EVERY declared optional field for an empty ledger, minus the allow-list", () => {
    const empty = uncoveredTierFields(football, corpusOf("football", []));
    const allowed = new Set(Object.keys(UNREACHABLE_FIELDS.football ?? {}));
    for (const path of declaredOptionalFields(football)) {
      expect(missingMatches(empty, allowed, path), `football.${path}`).toBe(true);
    }
  });

  it("is sorted, so a diff of the failure message reads as a set", () => {
    const missing = uncoveredTierFields(football, corpusOf("football", []));
    expect(missing).toEqual([...missing].sort());
  });
});

/** A declared field must be EITHER reported missing OR on the allow-list. */
function missingMatches(missing: string[], allowed: Set<string>, path: string): boolean {
  return missing.includes(path) !== allowed.has(path);
}

describe("coverageTokens", () => {
  it("tags event types and written optional fields apart", () => {
    const tokens = coverageTokens(football, [goal({ by: "H", at: { period: "H1", elapsed: 30 } })]);
    expect(tokens).toContain("type:football.goal");
    expect(tokens).toContain("field:at");
    expect(tokens).not.toContain("field:scorer");
  });

  it("emits no field token for a key the module does not declare", () => {
    // Otherwise a typo'd payload key would count as coverage of nothing.
    const tokens = coverageTokens(football, [goal({ by: "H", bogusKey: 1 })]);
    expect(tokens.filter((t) => t.startsWith("field:"))).toEqual([]);
  });

  it("emits a type token for a core event too — the corpus records those", () => {
    const tokens = coverageTokens(football, [{ type: "core.abandon", payload: { reason: "rain" } }]);
    expect(tokens).toContain("type:core.abandon");
  });
});

// ------------------------------------------------------- allow-list hygiene
//
// An allow-list that grows without reasons is exactly the defect this gate
// exists to catch, one level up. These four run against the REAL modules and
// corpora so an entry cannot rot in place: a typo, a removed field, a field the
// corpus has since started writing, or a bare entry with no reason all red.

describe("UNREACHABLE_FIELDS is self-policing", () => {
  it("names only real module keys", () => {
    const keys = new Set(builtinModules.map((m) => m.key));
    expect(Object.keys(UNREACHABLE_FIELDS).filter((k) => !keys.has(k))).toEqual([]);
  });

  it("names only fields the module still declares as optional", () => {
    for (const module of builtinModules) {
      expect(
        undeclaredUnreachableFields(module),
        `${module.key}: allow-listed a field its event union no longer declares optional — ` +
          `the entry is stale and is now suppressing nothing`,
      ).toEqual([]);
    }
  });

  it("carries a real reason on every entry, not a placeholder", () => {
    for (const [key, entries] of Object.entries(UNREACHABLE_FIELDS)) {
      for (const [path, reason] of Object.entries(entries)) {
        expect(reason.length, `${key}.${path} reason`).toBeGreaterThan(30);
        expect(reason, `${key}.${path} reason`).not.toMatch(/^(TODO|FIXME|unreachable\.?$)/i);
      }
    }
  });

  it("subtracts every entry it holds — the list is actually wired in", () => {
    for (const module of builtinModules) {
      const missing = uncoveredTierFields(module, corpusOf(module.key, []));
      const allowed = Object.keys(UNREACHABLE_FIELDS[module.key] ?? {});
      expect(missing.filter((p) => allowed.includes(p)), module.key).toEqual([]);
    }
  });

  it("reds on an entry the ledger has since started writing", () => {
    // Synthetic, so it holds whatever the allow-list happens to contain today:
    // a corpus that WRITES an allow-listed field makes that entry stale.
    for (const module of builtinModules) {
      const allowed = Object.keys(UNREACHABLE_FIELDS[module.key] ?? {});
      if (allowed.length === 0) continue;
      const path = allowed[0] as string;
      const payload = path.split(".").reduceRight<unknown>((acc, seg) => ({ [seg]: acc }), 1);
      const stale = staleUnreachableFields(module, corpusOf(module.key, [{ type: "x", payload }]));
      expect(stale, `${module.key}.${path} written but allow-listed`).toEqual([path]);
      expect(staleUnreachableFields(module, corpusOf(module.key, []))).toEqual([]);
    }
  });
});

// ======================================================= T2: the CONFIG half
//
// `configSchema` IS a runtime zod schema, so the declared side is the same
// walker the payload half uses. Only the observed side is different: a config
// knob is pinned by the recorded RAW config (replay re-parses that value) or by
// the `cfg` serialised into a frozen state (`stateMismatch` compares it as a
// subset), and the two catch different classes of change.

describe("declaredOptionalConfigFields", () => {
  it("is the module's own config schema, not a hand-kept list", () => {
    const paths = declaredOptionalConfigFields(football);
    expect(paths).toContain("subWindows"); // W4a §5.2, optional with no default
    expect(paths).toContain("periodSeconds"); // W4a, optional with no default
    expect(paths).toContain("abandonPolicy"); // defaulted, so a config may omit it
    // Required WHEN its defaulted parent is written, so covering `extraTime`
    // pins its shape — it is not a field to cover in its own right.
    expect(paths).not.toContain("extraTime.enabled");
  });

  it("is a DIFFERENT set from the event union's — the two halves never merged", () => {
    // `subWindows` is two fields sharing a name: a cfg COUNT and a state array.
    // Anything treating them as one field is wrong, and this pins that the
    // config walker is reading configSchema rather than eventSchema.
    expect(declaredOptionalConfigFields(football)).not.toEqual(declaredOptionalFields(football));
    expect(declaredOptionalFields(football)).not.toContain("subWindows");
  });
});

describe("pinnedConfigFields", () => {
  it("counts a knob a RAW recorded config sets", () => {
    const pinned = pinnedConfigFields(football, cfgCorpusOf("football", { subWindows: 3 }));
    expect(pinned.has("subWindows")).toBe(true);
  });

  it("counts a knob only the FROZEN state carries — the subset rule pins it", () => {
    // The organiser never set `abandonPolicy`; `parse` defaulted it and the
    // value went into every frozen state, where a rename or a changed default
    // reds `stateMismatch`. That is a real pin, and a weaker one than raw.
    const pinned = pinnedConfigFields(football, cfgCorpusOf("football", {}, { abandonPolicy: "replay" }));
    expect(pinned.has("abandonPolicy")).toBe(true);
  });

  it("counts neither when the knob is absent from both", () => {
    const pinned = pinnedConfigFields(football, cfgCorpusOf("football", {}, { abandonPolicy: "replay" }));
    expect(pinned.has("subWindows")).toBe(false);
    expect(pinned.has("periodSeconds")).toBe(false);
  });

  it("resolves a RECORD path — the period kernel's suspension classes", () => {
    // `suspensions.classes` is a z.record, so its declared path carries the same
    // `[]` an array would. Before `fieldPresent` learned to descend a record,
    // every one of these was unreachable by construction.
    expect(declaredOptionalConfigFields(icehockey)).toContain("suspensions.classes[].pim");
    const pinned = pinnedConfigFields(
      icehockey,
      cfgCorpusOf("icehockey", {}, { suspensions: { classes: { misconduct: { pim: 10 } } } }),
    );
    expect(pinned.has("suspensions.classes[].pim")).toBe(true);
  });

  it("counts a knob set to a FALSY value — `false` is a recorded decision", () => {
    const pinned = pinnedConfigFields(football, cfgCorpusOf("football", { rollingSubs: false }));
    expect(pinned.has("rollingSubs")).toBe(true);
  });
});

describe("uncoveredConfigFields", () => {
  it("reports every declared knob for a corpus that pins none, minus the allow-list", () => {
    const missing = uncoveredConfigFields(football, cfgCorpusOf("football", {}));
    const allowed = new Set(Object.keys(UNREACHABLE_CONFIG_FIELDS.football ?? {}));
    for (const path of declaredOptionalConfigFields(football)) {
      expect(missing.includes(path) !== allowed.has(path), `football.${path}`).toBe(true);
    }
  });

  it("drops a knob once something pins it", () => {
    expect(uncoveredConfigFields(football, cfgCorpusOf("football", { subWindows: 3 }))).not.toContain(
      "subWindows",
    );
  });
});

describe("UNREACHABLE_CONFIG_FIELDS is self-policing", () => {
  it("names only real module keys", () => {
    const keys = new Set(builtinModules.map((m) => m.key));
    expect(Object.keys(UNREACHABLE_CONFIG_FIELDS).filter((k) => !keys.has(k))).toEqual([]);
  });

  it("names only knobs the config schema still declares optional", () => {
    for (const module of builtinModules) {
      expect(undeclaredUnreachableConfigFields(module), module.key).toEqual([]);
    }
  });

  it("carries a real reason on every entry, not a placeholder", () => {
    for (const [key, entries] of Object.entries(UNREACHABLE_CONFIG_FIELDS)) {
      for (const [path, reason] of Object.entries(entries)) {
        expect(reason.length, `${key}.${path} reason`).toBeGreaterThan(30);
        expect(reason, `${key}.${path} reason`).not.toMatch(/^(TODO|FIXME|unreachable\.?$)/i);
      }
    }
  });

  it("reds on an entry the corpus has since started pinning", () => {
    // Guards the guard: the list is empty today, so drive the mechanism with a
    // knob that WOULD be exempt if it were listed, and assert the detector
    // separates pinned from unpinned rather than answering constantly.
    const pinned = cfgCorpusOf("football", { subWindows: 3 });
    expect(pinnedConfigFields(football, pinned).has("subWindows")).toBe(true);
    expect(staleUnreachableConfigFields(football, pinned)).toEqual([]);
    expect(Object.keys(UNREACHABLE_CONFIG_FIELDS.football ?? {})).toEqual([]);
  });
});

// ======================================================== T2: the STATE half
//
// No `stateSchema` exists, so there is no declared list to walk and the paths
// come from the recorded states. These pin the normalisation — without it,
// lineup ids and a home/away asymmetry read as missing fields.

describe("statePathsOf", () => {
  const collapse = new Set(["home", "away", "H", "A", "H-p1", "A-p1"]);

  it("drops `cfg` — the config half owns it", () => {
    const paths = statePathsOf({ cfg: { setTo: 25 }, phase: "live" }, collapse);
    expect(paths).toEqual(["phase"]);
  });

  it("collapses the side keys, so which side the seed picked does not matter", () => {
    const homeBinned = { squads: { home: { sinBin: [{ person: "H-p1" }] }, away: {} } };
    const awayBinned = { squads: { home: {}, away: { sinBin: [{ person: "A-p1" }] } } };
    expect(statePathsOf(homeBinned, collapse)).toEqual(statePathsOf(awayBinned, collapse));
  });

  it("collapses person-keyed records, so lineup ids are not schema paths", () => {
    const paths = statePathsOf({ fine: { batterRuns: { "H-p1": 12, "A-p1": 4 } } }, collapse);
    expect(paths).toEqual(["fine", "fine.batterRuns", "fine.batterRuns[]"]);
  });

  it("keeps a conditional field as its own path — that is what gets covered", () => {
    expect(statePathsOf({ asOf: { period: "H1", elapsed: 30 } }, collapse)).toEqual([
      "asOf",
      "asOf.elapsed",
      "asOf.period",
    ]);
    expect(statePathsOf({ phase: "pre" }, collapse)).not.toContain("asOf");
  });
});

describe("UNREACHABLE_STATE_PATHS is self-policing", () => {
  it("names only real module keys", () => {
    const keys = new Set(builtinModules.map((m) => m.key));
    expect(Object.keys(UNREACHABLE_STATE_PATHS).filter((k) => !keys.has(k))).toEqual([]);
  });

  it("carries a real reason on every entry, not a placeholder", () => {
    for (const [key, entries] of Object.entries(UNREACHABLE_STATE_PATHS)) {
      for (const [path, reason] of Object.entries(entries)) {
        expect(reason.length, `${key}.${path} reason`).toBeGreaterThan(30);
        expect(reason, `${key}.${path} reason`).not.toMatch(/^(TODO|FIXME|unreachable\.?$)/i);
      }
    }
  });

  it("is empty, and both staleness detectors answer [] against a real corpus", () => {
    // Guards the guard. An always-[] detector would make the two gate tests in
    // golden.test.ts vacuous, so `statePathsOf` above is what pins that they
    // can distinguish a written path from an absent one.
    expect(Object.keys(UNREACHABLE_STATE_PATHS)).toEqual([]);
    const empty = corpusOf(tennis.key, []);
    expect(staleUnreachableStatePaths(tennis, empty)).toEqual([]);
    expect(unreachableStatePathsGoneStale(tennis, empty)).toEqual([]);
  });
});

describe("coverageTokens with a config and states", () => {
  it("tags cfg and state tokens apart from types and payload fields", () => {
    const tokens = coverageTokens(football, [goal({ by: "H", at: { period: "H1", elapsed: 3 } })], {
      rawConfig: { subWindows: 3 },
      states: [{ cfg: { subWindows: 3 }, asOf: { period: "H1", elapsed: 3 } }],
      collapse: new Set(["home", "away"]),
    });
    expect(tokens).toContain("type:football.goal");
    expect(tokens).toContain("field:at");
    expect(tokens).toContain("cfg:subWindows");
    expect(tokens).toContain("state:asOf");
    expect(tokens).not.toContain("state:cfg"); // dropped, the cfg half owns it
  });

  it("emits a cfg token for a knob `parse` DEFAULTS in, not only for a raw one", () => {
    // An appended stream freezes its RESOLVED cfg into every state, so that is
    // what the greedy pick has to score against.
    const tokens = coverageTokens(football, [], { rawConfig: {} });
    expect(tokens).toContain("cfg:abandonPolicy");
    expect(tokens).not.toContain("cfg:subWindows");
  });

  it("emits no cfg or state token when the caller supplies neither", () => {
    const tokens = coverageTokens(football, [goal({ by: "H" })]);
    expect(tokens.filter((t) => t.startsWith("cfg:") || t.startsWith("state:"))).toEqual([]);
  });
});
