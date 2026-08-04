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
import { football } from "../sports/football/index.ts";
import {
  MAX_EVENTS,
  MIN_EVENTS,
  UNREACHABLE_FIELDS,
  coverageTokens,
  declaredOptionalFields,
  staleUnreachableFields,
  undeclaredUnreachableFields,
  uncoveredTierFields,
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
