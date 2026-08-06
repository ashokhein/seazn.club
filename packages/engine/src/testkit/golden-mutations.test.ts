// #429 scope item 3 — the equivalence proof.
//
// Slimming the corpora is only safe if the SLIM corpus kills every mutation the
// FULL one killed. That is a claim about a set of changes, so it is checked as
// a set: `CORPUS_MUTATIONS` is run against the committed football corpus in
// both storage forms, and each entry must red in both. An entry the full corpus
// kills and the slim one does not is a blocker, not a footnote.
//
// The state-level entries are applied at `digestStep` on purpose — the step the
// full corpus stores whole and the slim corpus stores as a 64-bit digest. That
// is the only step where the two forms could possibly disagree, so aiming
// anywhere else would make the whole file vacuous.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { football } from "../sports/football/index.ts";
import {
  CORPUS_MUTATIONS,
  CORPUS_TOLERANCES,
  mutationContext,
  type MutationContext,
} from "./golden-mutations.ts";
import {
  configStateKey,
  goldenPath,
  isStateDigest,
  readCorpus,
  slimCorpus,
  unslimCorpus,
  type GoldenStream,
} from "./golden.ts";

// The committed corpus IS the slim form. The full form is derived by re-folding
// the ledger it still stores — that is the recomputability claim scope item 3
// rests on, and it is what stops this file degrading into comparing a corpus
// with itself once nothing full is left on disk.
const committed = readCorpus("football");
const full = unslimCorpus(football, committed);
const slim = slimCorpus(football, full);

// The stream every entry runs against: the first one long enough that slimming
// digests some of its steps. Picking a short stream (football records several
// two-event ones, where every step is an anchor) would make "slim" identical to
// "full" and the proof would assert nothing.
const streamIndex = slim.streams.findIndex(
  (stream) => stream.states.some(isStateDigest) && stream.states.length > 4,
);
const slimStream = slim.streams[streamIndex] as GoldenStream;
const digestStep = slimStream.states.findIndex(isStateDigest);
const anchorStep = slimStream.states.findIndex((state, i) => i > 0 && !isStateDigest(state));
const configKey = configStateKey(football, full.configs[slimStream.config], slimStream.lineups);

function contextFor(form: "full" | "slim"): MutationContext {
  return mutationContext(
    football,
    full,
    slim,
    form,
    streamIndex,
    digestStep,
    anchorStep,
    configKey,
  );
}

describe("the mutation list is aimed at something", () => {
  it("found a stream with both a digested and an anchored step", () => {
    expect(streamIndex).toBeGreaterThanOrEqual(0);
    expect(digestStep).toBeGreaterThan(0);
    expect(anchorStep).toBeGreaterThan(0);
    // The claim the whole file rests on: this step is a digest in the slim
    // corpus and a full recorded state in the full one.
    expect(isStateDigest(slimStream.states[digestStep] as string)).toBe(true);
    expect(isStateDigest((full.streams[streamIndex] as GoldenStream).states[digestStep] as string)).toBe(
      false,
    );
  });

  it("the two forms are genuinely different corpora", () => {
    expect(JSON.stringify(slim).length).toBeLessThan(JSON.stringify(full).length);
  });
});

// ------------------------------------------------------------- the entries

describe("every mutation reds against the FULL corpus and against the SLIM one", () => {
  for (const mutation of CORPUS_MUTATIONS.filter((m) => m.killedBy === "corpus")) {
    it(`${mutation.id} (${mutation.klass})`, () => {
      const run = mutation.run;
      expect(run, `${mutation.id} claims killedBy:corpus and must be runnable`).toBeDefined();
      const failuresFull = (run as NonNullable<typeof run>)(contextFor("full"));
      const failuresSlim = (run as NonNullable<typeof run>)(contextFor("slim"));
      expect(
        failuresFull.length,
        `${mutation.id}: the FULL corpus did not red — the entry is vacuous`,
      ).toBeGreaterThan(0);
      expect(
        failuresSlim.length,
        `${mutation.id}: the FULL corpus killed this and the SLIM corpus did NOT. Slimming ` +
          `has weakened the tripwire — this is a blocker, not a tuning problem.`,
      ).toBeGreaterThan(0);
    });
  }
});

describe("every tolerance stays green in both forms — the vacuity control", () => {
  for (const tolerance of CORPUS_TOLERANCES) {
    it(tolerance.id, () => {
      expect(tolerance.run(contextFor("full")), `${tolerance.id} full`).toEqual([]);
      expect(tolerance.run(contextFor("slim")), `${tolerance.id} slim`).toEqual([]);
    });
  }
});

// ---------------------------------------------------- the list's own hygiene

describe("the list itself", () => {
  it("has unique ids and a stated reason on every entry", () => {
    const ids = CORPUS_MUTATIONS.map((m) => m.id);
    expect(ids).toEqual([...new Set(ids)]);
    for (const mutation of [...CORPUS_MUTATIONS, ...CORPUS_TOLERANCES]) {
      // The reason IS the entry, the same contract UNREACHABLE_FIELDS is under:
      // a list that grows without one rots into a rubber stamp.
      expect(mutation.why.length, mutation.id).toBeGreaterThan(60);
    }
  });

  it("covers every class of break W4 threw at the corpus", () => {
    const classes = new Set(CORPUS_MUTATIONS.map((m) => m.klass));
    for (const klass of [
      "fold",
      "state-shape",
      "state-order",
      "config",
      "outcome",
      "ledger",
      "schema-narrowing",
    ]) {
      expect(classes, `no entry covers ${klass}`).toContain(klass);
    }
  });

  it("gives every entry either a runnable perturbation or a manual procedure", () => {
    for (const mutation of CORPUS_MUTATIONS) {
      const hasRun = mutation.run !== undefined;
      const hasManual = mutation.manual !== undefined;
      expect(hasRun || hasManual, mutation.id).toBe(true);
      if (hasManual) {
        // A manual entry that does not say what failure to expect is a note,
        // not a procedure — the next reader cannot tell a pass from a miss.
        expect(mutation.manual?.expected.length, mutation.id).toBeGreaterThan(40);
        expect(mutation.manual?.procedure, mutation.id).toContain("vitest");
      }
    }
  });
});

// ------------------------------------------- the two gates' division of labour
//
// `football-abandonPolicy-enum-narrowed` is recorded as killed by the SCHEMA
// SNAPSHOT and not by the corpus. That is a claim about the corpus's blindness,
// so it is asserted rather than asserted-in-prose: the corpus records exactly
// one value of the knob, while the declaration carries more than one member.
// Drop any of the others and no recorded state moves.

describe("why the corpus cannot kill an enum narrowing", () => {
  it("records ONE abandonPolicy value while the schema declares several", () => {
    const recorded = new Set<string>();
    for (const stream of full.streams) {
      for (const state of stream.states) {
        const match = /"abandonPolicy":"([^"]+)"/.exec(state);
        if (match !== null) recorded.add(match[1] as string);
      }
    }
    expect(recorded.size, "distinct abandonPolicy values in the football corpus").toBe(1);

    const snapshot = readFileSync(
      goldenPath("football").replace(/\.golden\.json$/, ".schema.json"),
      "utf8",
    );
    const declared = /"abandonPolicy":\s*\{[^}]*"enum":\s*\[([^\]]*)\]/.exec(snapshot);
    expect(declared, "abandonPolicy enum in the committed schema snapshot").not.toBeNull();
    const members = (declared?.[1] as string).split(",").filter((part) => part.trim() !== "");
    expect(members.length, "declared abandonPolicy members").toBeGreaterThan(recorded.size);
  });
});
