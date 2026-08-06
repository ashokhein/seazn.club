// #429 scope item 3 — the equivalence proof.
//
// Slimming the corpora is only safe if the SLIM corpus kills every mutation the
// FULL one killed. That is a claim about a set of changes, so it is checked as
// a set: `CORPUS_MUTATIONS` is run against each committed corpus in both storage
// forms, and each entry must red in both. An entry the full corpus kills and the
// slim one does not is a blocker, not a footnote.
//
// The state-level entries are applied at `digestStep` on purpose — the step the
// full corpus stores whole and the slim corpus stores as a 64-bit digest. That
// is the only step where the two forms could possibly disagree, so aiming
// anywhere else would make the whole file vacuous.
//
// RUN OVER EVERY BUILTIN, not football alone (review follow-up). The
// shape-preservation half of the proof — `golden-slim.test.ts` — already covers
// all eleven; this half covered one, and one is the wrong number for the defect
// scope item 4b fixed. Cricket owns 708 of the ~2,450 digests and has by far the
// most exotic state (`r1`/`r2` innings keys, person-keyed records), so an
// integer-like state key, which a `JSON.parse` round trip silently normalises,
// would appear there first. A module that genuinely cannot host the proof is
// SKIPPED BY NAME with a reason the harness itself computes, because a loop that
// quietly skips is worse than a loop that only ever ran on football.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AnySportModule } from "../sport/module.ts";
import { football } from "../sports/football/index.ts";
import { builtinModules } from "../sports/index.ts";
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
  jsonObjectMembers,
  readCorpus,
  slimCorpus,
  unslimCorpus,
  type GoldenCorpus,
  type GoldenStream,
} from "./golden.ts";

// ------------------------------------------------------------- the witness
//
// Every entry needs the same three things from a module's corpus, and the two
// ways a corpus can fail to supply them are named so the skip list below cannot
// drift into prose.

/** No stream stores a step as a digest AND another step (after 0) in full — so
 *  the two storage forms are the same corpus and the proof asserts nothing. */
const NO_MIXED_STREAM =
  "no stream carries both a digested step and an anchored step after step 0";

/** The digested step's recorded state has no number outside the config, so the
 *  `state-value-changed` entry ("a fold that starts producing a different
 *  number") cannot be expressed against it at all. */
const NO_NUMERIC_STATE =
  "no digested step's state carries a numeric member outside the config";

interface Aim {
  module: AnySportModule;
  committed: GoldenCorpus;
  full: GoldenCorpus;
  slim: GoldenCorpus;
  streamIndex: number;
  digestStep: number;
  anchorStep: number;
  configKey: string | null;
}

/** Whether a recorded state carries a number outside the module's config. */
function hasNonConfigNumber(state: string, configKey: string | null): boolean {
  const members = jsonObjectMembers(state);
  if (members === null) return false;
  return members.some(
    (member) => member.key !== configKey && /:(-?\d+)(?=[,}])/.test(member.rawValue),
  );
}

/** The strongest stream in a corpus to aim the list at, or the reason there is
 *  none. "Strongest" = the most digested steps, so the proof runs against the
 *  stream where slimming threw the most away; ties break on the lower index, so
 *  the choice is deterministic across runs and machines. */
function witnessFor(module: AnySportModule): Aim | { skip: string } {
  const committed = readCorpus(module.key);
  const full = unslimCorpus(module, committed);
  const slim = slimCorpus(module, full);

  let streamIndex = -1;
  let best = 0;
  let sawMixed = false;
  slim.streams.forEach((stream, i) => {
    const digests = stream.states.filter(isStateDigest).length;
    const anchored = stream.states.some((state, j) => j > 0 && !isStateDigest(state));
    if (digests === 0 || !anchored) return;
    sawMixed = true;
    const fullStream = full.streams[i] as GoldenStream;
    const step = stream.states.findIndex(isStateDigest);
    const configKey = configStateKey(module, full.configs[stream.config], stream.lineups);
    if (!hasNonConfigNumber(fullStream.states[step] as string, configKey)) return;
    if (digests > best) {
      best = digests;
      streamIndex = i;
    }
  });
  if (streamIndex < 0) return { skip: sawMixed ? NO_NUMERIC_STATE : NO_MIXED_STREAM };

  const stream = slim.streams[streamIndex] as GoldenStream;
  return {
    module,
    committed,
    full,
    slim,
    streamIndex,
    digestStep: stream.states.findIndex(isStateDigest),
    anchorStep: stream.states.findIndex((state, i) => i > 0 && !isStateDigest(state)),
    configKey: configStateKey(module, full.configs[stream.config], stream.lineups),
  };
}

const witnesses = builtinModules.map((module) => [module.key, witnessFor(module)] as const);

// ------------------------------------------------------------- the skip list

/** Modules the equivalence proof cannot run against, each with the harness's own
 *  diagnosis and why that is a fact about the corpus rather than a gap. The
 *  `reason` is asserted to be the one `witnessFor` computes, so an entry cannot
 *  survive the corpus that justified it. */
const PROOF_SKIPS: Record<string, { reason: string; why: string }> = {
  boardgame: {
    reason: NO_NUMERIC_STATE,
    why:
      "boardgame records one result event per stream, so its longest stream is 3 steps and " +
      "exactly 2 of its 152 recorded states are digested at all. The one digested step's " +
      "state is the pre-result board — every member of it is a string or an object, so there " +
      "is no number for a changed fold value to move. Nothing here is unguarded: the FULL " +
      "corpus is what golden.test.ts replays, and slimming touched 2 states of 152.",
  },
};

describe("the skip list is exactly the modules that cannot host the proof", () => {
  it("names every module without a witness, and no module that has one", () => {
    const skipped = witnesses
      .filter(([, witness]) => "skip" in witness)
      .map(([key]) => key)
      .sort();
    expect(
      skipped,
      "a module that silently drops out of the equivalence proof is the failure this list " +
        "exists to make loud. Add it with a reason, or find out why it lost its witness.",
    ).toEqual(Object.keys(PROOF_SKIPS).sort());
  });

  it("records the reason the harness itself computes, not a remembered one", () => {
    for (const [key, witness] of witnesses) {
      const entry = PROOF_SKIPS[key];
      if (entry === undefined) continue;
      expect("skip" in witness ? witness.skip : "(has a witness)", key).toBe(entry.reason);
      // Same contract as CORPUS_MUTATIONS.why: the reason IS the entry.
      expect(entry.why.length, key).toBeGreaterThan(60);
    }
  });
});

// -------------------------------------------------------------- the entries

for (const [key, witness] of witnesses) {
  if ("skip" in witness) continue;
  const aim = witness;

  const contextFor = (form: "full" | "slim"): MutationContext =>
    mutationContext(
      aim.module,
      aim.full,
      aim.slim,
      form,
      aim.streamIndex,
      aim.digestStep,
      aim.anchorStep,
      aim.configKey,
    );

  describe(`${key}: the mutation list is aimed at something`, () => {
    it("found a stream with both a digested and an anchored step", () => {
      const slimStream = aim.slim.streams[aim.streamIndex] as GoldenStream;
      expect(aim.digestStep).toBeGreaterThan(0);
      expect(aim.anchorStep).toBeGreaterThan(0);
      // The claim the whole file rests on: this step is a digest in the slim
      // corpus and a full recorded state in the full one.
      expect(isStateDigest(slimStream.states[aim.digestStep] as string)).toBe(true);
      expect(
        isStateDigest((aim.full.streams[aim.streamIndex] as GoldenStream).states[
          aim.digestStep
        ] as string),
      ).toBe(false);
    });

    it("the two forms are genuinely different corpora", () => {
      expect(JSON.stringify(aim.slim).length).toBeLessThan(JSON.stringify(aim.full).length);
    });

    // And the derived slim form is the corpus that is actually COMMITTED — so
    // the mutations below run against the real artefact, not against a
    // reconstruction of it that could have drifted. Without this the file would
    // still pass while proving things about a corpus nobody ships.
    it("the derived slim form reproduces the COMMITTED corpus exactly", () => {
      expect(aim.slim).toEqual(aim.committed);
    });
  });

  describe(`${key}: every mutation reds against the FULL corpus and against the SLIM one`, () => {
    for (const mutation of CORPUS_MUTATIONS.filter((m) => m.killedBy === "corpus")) {
      it(`${mutation.id} (${mutation.klass})`, () => {
        const run = mutation.run;
        expect(run, `${mutation.id} claims killedBy:corpus and must be runnable`).toBeDefined();
        const failuresFull = (run as NonNullable<typeof run>)(contextFor("full"));
        const failuresSlim = (run as NonNullable<typeof run>)(contextFor("slim"));
        expect(
          failuresFull.length,
          `${key}/${mutation.id}: the FULL corpus did not red — the entry is vacuous`,
        ).toBeGreaterThan(0);
        expect(
          failuresSlim.length,
          `${key}/${mutation.id}: the FULL corpus killed this and the SLIM corpus did NOT. ` +
            `Slimming has weakened the tripwire — this is a blocker, not a tuning problem.`,
        ).toBeGreaterThan(0);
      });
    }
  });

  describe(`${key}: every tolerance stays green in both forms — the vacuity control`, () => {
    for (const tolerance of CORPUS_TOLERANCES) {
      it(tolerance.id, () => {
        expect(tolerance.run(contextFor("full")), `${key}/${tolerance.id} full`).toEqual([]);
        expect(tolerance.run(contextFor("slim")), `${key}/${tolerance.id} slim`).toEqual([]);
      });
    }
  });
}

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
    const full = unslimCorpus(football, readCorpus("football"));
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
