// #429 scope item 1 — the golden corpus WRITE POLICY, made enforceable.
//
// The policy is in GOLDEN-POLICY.md next to this file: a re-baseline is
// legitimate only when it is DELIBERATE, ISOLATED IN ITS OWN COMMIT, and
// REVIEWED AS A STATE DIFF. The mechanism for it (`REBASELINE_GOLDEN=1`)
// already existed and enforced none of those three clauses — it would rewrite
// eleven corpora on top of a half-finished branch and print nothing about what
// moved, which produces a commit no reviewer can read: a state that moved
// because the fold changed is indistinguishable from one that moved because
// the tree was dirty.
//
// Both halves under test here are PURE and take their inputs as data — a
// porcelain listing, a pair of corpora — so nothing below manufactures dirty
// git state or runs a re-baseline. The impure wiring is two `execFileSync`
// probes, and the only thing asserted of them is the one behaviour that must
// fail closed: outside a checkout there is no diff to review.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_EVENTS,
  MIN_EVENTS,
  corpusStateDiff,
  corpusWritablePaths,
  corpusWriteVerdict,
  formatCorpusStateDiff,
  gitPorcelain,
  gitRepoRoot,
  type GoldenCorpus,
  type GoldenStream,
} from "./golden.ts";

const FOOTBALL = "packages/engine/src/sports/football/football.golden.json";
const CRICKET = "packages/engine/src/sports/cricket/cricket.golden.json";

// ------------------------------------------------------- the cleanliness probe

describe("corpusWriteVerdict — a corpus write refuses a dirty working tree", () => {
  it("passes on a completely clean tree", () => {
    const verdict = corpusWriteVerdict([], [FOOTBALL, CRICKET]);
    expect(verdict.ok).toBe(true);
    expect(verdict.offending).toEqual([]);
  });

  it("passes when the only dirty paths are corpus files it is about to rewrite", () => {
    expect(corpusWriteVerdict([` M ${FOOTBALL}`, ` M ${CRICKET}`], [FOOTBALL, CRICKET]).ok).toBe(
      true,
    );
  });

  it("REFUSES when a non-corpus path is dirty, and names it", () => {
    const kernel = "packages/engine/src/sports/football/kernel.ts";
    const verdict = corpusWriteVerdict([` M ${FOOTBALL}`, ` M ${kernel}`], [FOOTBALL]);
    expect(verdict.ok).toBe(false);
    expect(verdict.offending).toEqual([kernel]);
    // The message has to name the path — "your tree is dirty" sends the reader
    // back to `git status`, which is where they already were.
    expect(verdict.reason).toContain(kernel);
  });

  it("REFUSES on an untracked file", () => {
    const verdict = corpusWriteVerdict(["?? scratch/probe.ts"], [FOOTBALL]);
    expect(verdict.ok).toBe(false);
    expect(verdict.offending).toEqual(["scratch/probe.ts"]);
  });

  it("REFUSES a staged change as readily as an unstaged one", () => {
    const verdict = corpusWriteVerdict(["M  apps/web/src/app/page.tsx"], [FOOTBALL]);
    expect(verdict.ok).toBe(false);
    expect(verdict.offending).toEqual(["apps/web/src/app/page.tsx"]);
  });

  it("REFUSES a corpus file the run is NOT about to rewrite", () => {
    // The allowance is the exact set the run will write, not "any golden".
    const verdict = corpusWriteVerdict([` M ${CRICKET}`], [FOOTBALL]);
    expect(verdict.ok).toBe(false);
    expect(verdict.offending).toEqual([CRICKET]);
  });

  it("names BOTH sides of a rename", () => {
    const verdict = corpusWriteVerdict(["R  src/old.ts -> src/new.ts"], [FOOTBALL]);
    expect(verdict.ok).toBe(false);
    expect(verdict.offending).toEqual(["src/new.ts", "src/old.ts"]);
  });

  it("reads a quoted porcelain path with a space in it", () => {
    const verdict = corpusWriteVerdict([' M "docs/a b/c.md"'], [FOOTBALL]);
    expect(verdict.offending).toEqual(["docs/a b/c.md"]);
  });

  it("reports each offending path once, sorted", () => {
    const verdict = corpusWriteVerdict([" M b.ts", " M a.ts", "?? b.ts"], [FOOTBALL]);
    expect(verdict.offending).toEqual(["a.ts", "b.ts"]);
  });

  it("FAILS CLOSED when the directory is not a git checkout", () => {
    // Not an edge case: with no diff there is nothing to review, so the run
    // cannot satisfy the clause it is being gated on.
    const verdict = corpusWriteVerdict(null, [FOOTBALL]);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("not a git checkout");
  });
});

describe("the git probes behind the guard", () => {
  it("returns null outside a checkout, which is what fails the guard closed", () => {
    const outside = mkdtempSync(join(tmpdir(), "golden-policy-"));
    expect(gitRepoRoot(outside)).toBeNull();
    expect(gitPorcelain(outside)).toBeNull();
    expect(corpusWriteVerdict(gitPorcelain(outside), []).ok).toBe(false);
  });

  it("reads this checkout", () => {
    const root = gitRepoRoot(process.cwd());
    expect(root).not.toBeNull();
    expect(gitPorcelain(process.cwd())).not.toBeNull();
  });

  it("allows exactly the committed corpus files, repo-relative and on disk", () => {
    const root = gitRepoRoot(process.cwd()) as string;
    const paths = corpusWritablePaths(root);
    expect(paths).toHaveLength(11);
    expect(paths).toContain(FOOTBALL);
    expect(paths).toContain(CRICKET);
    for (const path of paths) {
      expect(path.startsWith("packages/engine/src/sports/"), path).toBe(true);
      expect(path.endsWith(".golden.json"), path).toBe(true);
      expect(existsSync(join(root, path)), path).toBe(true);
    }
  });
});

// -------------------------------------------------------- the state-diff summary

function stream(over: Partial<GoldenStream>): GoldenStream {
  return {
    config: "default",
    seed: 1,
    events: [{ type: "football.goal", payload: { by: "home" } }],
    states: [`{"cfg":{"halfMinutes":45},"phase":"live","goals":{"home":0,"away":0}}`],
    outcome: "null",
    summary: "{}",
    deltas: "{}",
    ...over,
  };
}

function corpus(streams: GoldenStream[]): GoldenCorpus {
  return {
    key: "football",
    version: "1.0.0",
    recordedBy: "testkit/golden.ts",
    params: { minEvents: MIN_EVENTS, maxEvents: MAX_EVENTS },
    configs: { default: {} },
    streams,
  };
}

describe("corpusStateDiff — what a re-baseline moved, as reviewable data", () => {
  it("reports nothing when nothing moved", () => {
    const before = corpus([stream({})]);
    const diff = corpusStateDiff(before, corpus([stream({})]));
    expect(diff.streams).toEqual([]);
    expect(diff.changedStreams).toBe(0);
    expect(diff.changedStates).toBe(0);
    expect(diff.eventsMoved).toBe(false);
    expect(formatCorpusStateDiff(diff)).toContain("nothing moved");
  });

  it("names the stream, the changed STEP indices and the changed state KEYS", () => {
    const states = [
      `{"cfg":{"a":1},"phase":"pre","goals":0}`,
      `{"cfg":{"a":1},"phase":"live","goals":0}`,
      `{"cfg":{"a":1},"phase":"live","goals":1}`,
    ];
    const before = corpus([stream({ config: "knockout", seed: 7, states })]);
    const after = corpus([
      stream({
        config: "knockout",
        seed: 7,
        states: [states[0] as string, `{"cfg":{"a":1},"phase":"live","goals":9}`, states[2] as string],
      }),
    ]);
    const diff = corpusStateDiff(before, after);
    expect(diff.changedStreams).toBe(1);
    expect(diff.changedStates).toBe(1);
    expect(diff.streams[0]?.index).toBe(0);
    expect(diff.streams[0]?.config).toBe("knockout");
    expect(diff.streams[0]?.seed).toBe(7);
    expect(diff.streams[0]?.changedSteps).toEqual([1]);
    expect(diff.streams[0]?.changedStateKeys).toEqual(["goals"]);
    expect(diff.changedStateKeys).toEqual(["goals"]);
  });

  it("attributes a change nested inside a value to its TOP-LEVEL key", () => {
    const before = corpus([stream({ states: [`{"cfg":{"a":1},"goals":{"home":0,"away":0}}`] })]);
    const after = corpus([stream({ states: [`{"cfg":{"a":1},"goals":{"home":2,"away":0}}`] })]);
    expect(corpusStateDiff(before, after).changedStateKeys).toEqual(["goals"]);
  });

  it("reports a state key that only one side carries", () => {
    const before = corpus([stream({ states: [`{"cfg":{"a":1},"phase":"live"}`] })]);
    const after = corpus([stream({ states: [`{"cfg":{"a":1},"phase":"live","shootout":null}`] })]);
    expect(corpusStateDiff(before, after).changedStateKeys).toEqual(["shootout"]);
  });

  it("reports integer-like state keys without reordering them into the diff", () => {
    const before = corpus([stream({ states: ['{"cfg":{"a":1},"2":"b","1":"a"}'] })]);
    const after = corpus([stream({ states: ['{"cfg":{"a":1},"2":"z","1":"a"}'] })]);
    expect(corpusStateDiff(before, after).changedStateKeys).toEqual(["2"]);
  });

  it("reports outcome, summary and deltas independently of the states", () => {
    const before = corpus([stream({})]);
    const after = corpus([stream({ outcome: `{"winner":"home"}`, deltas: `{"league":[3,0]}` })]);
    const diff = corpusStateDiff(before, after);
    expect(diff.changedStreams).toBe(1);
    expect(diff.streams[0]?.changedSteps).toEqual([]);
    expect(diff.streams[0]?.outcomeMoved).toBe(true);
    expect(diff.streams[0]?.summaryMoved).toBe(false);
    expect(diff.streams[0]?.deltasMoved).toBe(true);
  });

  it("lists only the streams that moved", () => {
    const before = corpus([stream({ seed: 1 }), stream({ seed: 2 })]);
    const after = corpus([
      stream({ seed: 1 }),
      stream({ seed: 2, states: [`{"cfg":{"a":1},"phase":"done"}`] }),
    ]);
    const diff = corpusStateDiff(before, after);
    expect(diff.streams.map((s) => s.index)).toEqual([1]);
  });

  it("FLAGS a moved recorded event — that is a re-record, not a re-baseline", () => {
    const before = corpus([stream({})]);
    const after = corpus([
      stream({ events: [{ type: "football.goal", payload: { by: "away" } }] }),
    ]);
    const diff = corpusStateDiff(before, after);
    expect(diff.eventsMoved).toBe(true);
    expect(diff.streams[0]?.eventsMoved).toBe(true);
    expect(formatCorpusStateDiff(diff)).toContain("RECORDED EVENTS MOVED");
  });

  it("FLAGS a changed stream count as an events move", () => {
    const diff = corpusStateDiff(corpus([stream({})]), corpus([stream({}), stream({ seed: 2 })]));
    expect(diff.eventsMoved).toBe(true);
  });

  it("prints the module, the step indices and the moved keys", () => {
    const before = corpus([stream({ states: [`{"cfg":{"a":1},"phase":"live"}`] })]);
    const after = corpus([stream({ states: [`{"cfg":{"a":1},"phase":"done"}`] })]);
    const text = formatCorpusStateDiff(corpusStateDiff(before, after));
    expect(text).toContain("football");
    expect(text).toContain("steps=[0]");
    expect(text).toContain("keys=[phase]");
    expect(text).toContain("state keys moved: phase");
  });
});
