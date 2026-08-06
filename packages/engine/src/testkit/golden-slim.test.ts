// #429 scope item 3 — per-step state DIGESTS with deliberate full-state anchors.
//
// The corpora recorded a full `JSON.stringify(state)` after every event, which
// ran to 4.5 MB across eleven single-line files. This slims the bulk to a
// per-step digest while keeping a chosen set of steps in full.
//
// THE TENSION THIS FILE PINS. Scope item 1 made "reviewed as a state diff" the
// core of the re-baseline policy, and a digest tells a reviewer THAT a step
// moved and never WHAT moved — the old value is a hash in git too. So the
// anchors are not a sampling convenience, they are the review story, and two
// properties have to hold or the slimming is a net loss:
//
//   1. DETECTION IS UNCHANGED. The digest is taken over the very text the
//      byte-exact comparison compares, so it reds on exactly what that
//      comparison redded on — a changed fold value, a dropped/added/reordered
//      state key — and tolerates exactly what it tolerated (an additive config
//      knob). `golden-mutations.test.ts` is the equivalence proof; this file
//      pins the mechanism.
//   2. COVERAGE IS UNCHANGED. Every gate that walks the recorded states for a
//      shape — `recordedStatePaths` here, `stateShapeOf` in schema-snapshot.ts
//      — must see the same paths and kinds afterwards. That is what makes the
//      anchor rule "every step at which the stream's state shape GROWS", rather
//      than a stride someone tuned.
import { describe, expect, it } from "vitest";
import { resolvePositions } from "../sport/catalog.ts";
import { football } from "../sports/football/index.ts";
import { builtinModules } from "../sports/index.ts";
import { defaultLineupPair } from "./helpers.ts";
import {
  ANCHOR_STRIDE,
  STATE_DIGEST_PREFIX,
  anchorSteps,
  comparableStateText,
  configStateKey,
  extendCorpus,
  isSlimStream,
  isStateDigest,
  readCorpus,
  rebaselineCorpus,
  recomputeStream,
  recordedStatePaths,
  slimCorpus,
  stateDigest,
  stateShapeTokens,
  stepMismatch,
  unslimCorpus,
  verifyStream,
  type GoldenStream,
} from "./golden.ts";
import { statePathKinds } from "./schema-snapshot.ts";

// ---------------------------------------------------------------- the digest

describe("stateDigest — order-sensitive, over the text the exact path compares", () => {
  const recorded = '{"cfg":{"halfMinutes":45},"phase":"live","goals":{"home":1,"away":0}}';

  it("is stable for the same text", () => {
    expect(stateDigest(recorded, "cfg")).toBe(stateDigest(recorded, "cfg"));
  });

  it("is marked as a digest and is not valid JSON", () => {
    const digest = stateDigest(recorded, "cfg");
    expect(digest.startsWith(STATE_DIGEST_PREFIX)).toBe(true);
    expect(isStateDigest(digest)).toBe(true);
    expect(() => JSON.parse(digest)).toThrow();
    // A real state is never mistaken for one — every recorded state is an object.
    expect(isStateDigest(recorded)).toBe(false);
  });

  it("MOVES on a changed fold value", () => {
    const changed = '{"cfg":{"halfMinutes":45},"phase":"live","goals":{"home":2,"away":0}}';
    expect(stateDigest(changed, "cfg")).not.toBe(stateDigest(recorded, "cfg"));
  });

  it("MOVES on an added state key", () => {
    const added = '{"cfg":{"halfMinutes":45},"phase":"live","goals":{"home":1,"away":0},"x":[]}';
    expect(stateDigest(added, "cfg")).not.toBe(stateDigest(recorded, "cfg"));
  });

  it("MOVES on a dropped state key", () => {
    const dropped = '{"cfg":{"halfMinutes":45},"goals":{"home":1,"away":0}}';
    expect(stateDigest(dropped, "cfg")).not.toBe(stateDigest(recorded, "cfg"));
  });

  // The brief's "order-insensitive where the state is genuinely a set" does NOT
  // apply here: the comparison it replaces is byte-exact on the source text, key
  // order included, and the folds are deterministic, so replay reproduces the
  // recorded order exactly. An order-insensitive digest would be strictly weaker
  // than what it replaces for no benefit at all.
  it("MOVES on reordered top-level keys — it replaces an order-EXACT comparison", () => {
    const reordered = '{"cfg":{"halfMinutes":45},"goals":{"home":1,"away":0},"phase":"live"}';
    expect(stateDigest(reordered, "cfg")).not.toBe(stateDigest(recorded, "cfg"));
  });

  it("MOVES on reordered INTEGER-LIKE keys, which a JSON round-trip would normalise", () => {
    // Written as literals on purpose: `JSON.stringify({"2":…,"1":…})` reorders at
    // construction, so an object-literal fixture cannot express this at all.
    const a = '{"cfg":{"x":1},"2":"b","1":"a"}';
    const b = '{"cfg":{"x":1},"1":"a","2":"b"}';
    expect(stateDigest(a, "cfg")).not.toBe(stateDigest(b, "cfg"));
  });

  // The config-subset tolerance is permanent (a `.default()` on an additive knob
  // shifts the resolved cfg in every frozen state while changing no fold). The
  // digest keeps it by hashing the same config-placeholdered text `withoutConfig`
  // builds — hashing the raw state instead would red all eleven corpora on the
  // next additive default.
  it("does NOT move when a NEW config knob is resolved into the state", () => {
    const widened =
      '{"cfg":{"halfMinutes":45,"abandonPolicy":"replay"},"phase":"live","goals":{"home":1,"away":0}}';
    expect(stateDigest(widened, "cfg")).toBe(stateDigest(recorded, "cfg"));
  });

  it("does not move on a changed value INSIDE the config — anchors own that", () => {
    // Deliberate and stated: the config is constant across a stream (no fold
    // rewrites it) and step 0 is always an anchor, so the subset pin survives
    // once per stream. `golden-mutations.test.ts` proves the stream still reds.
    const changed = '{"cfg":{"halfMinutes":40},"phase":"live","goals":{"home":1,"away":0}}';
    expect(stateDigest(changed, "cfg")).toBe(stateDigest(recorded, "cfg"));
  });

  it("follows the config wherever the module files it, and hashes everything when there is none", () => {
    const settings = '{"settings":{"halfMinutes":45},"phase":"live"}';
    const widened = '{"settings":{"halfMinutes":45,"teamSize":7},"phase":"live"}';
    expect(stateDigest(widened, "settings")).toBe(stateDigest(settings, "settings"));
    // configKey null: nothing is placeholdered, so the same widening DOES move.
    expect(stateDigest(widened, null)).not.toBe(stateDigest(settings, null));
  });

  it("keeps the config's POSITION in key order", () => {
    const first = '{"cfg":{"x":1},"phase":"live"}';
    const last = '{"phase":"live","cfg":{"x":1}}';
    expect(stateDigest(first, "cfg")).not.toBe(stateDigest(last, "cfg"));
  });

  it("hashes the raw text when the state is not a JSON object", () => {
    expect(comparableStateText("not json", "cfg")).toBe("not json");
    expect(stateDigest("not json", "cfg")).not.toBe(stateDigest("also not json", "cfg"));
  });
});

// ------------------------------------------------------------- shape tokens

describe("stateShapeTokens — the same path/kind grammar the snapshot walker uses", () => {
  const collapse = new Set(["home", "away"]);
  const omit = new Set(["cfg"]);

  // golden.ts must not import schema-snapshot.ts — schema-snapshot.ts imports
  // golden.ts, and a module cycle between them is not worth the two dozen lines
  // saved. This test is what holds the two walkers together instead: if either
  // grammar drifts, the anchor rule stops preserving the committed snapshots and
  // this reds first.
  it("agrees with statePathKinds on a real folded state, exactly", () => {
    const cfg = football.configSchema.parse({});
    const state: unknown = football.init(cfg, defaultLineupPair(resolvePositions(football, cfg)));
    const expected = new Set<string>();
    for (const [path, kinds] of statePathKinds(state, collapse, omit)) {
      for (const kind of kinds) expected.add(`${path} ${kind}`);
    }
    expect([...stateShapeTokens(state, collapse, omit)].sort()).toEqual([...expected].sort());
  });

  it("agrees with statePathKinds on nested arrays, nulls and collapsed keys", () => {
    const state = {
      cfg: { dropped: true },
      goals: { home: 1, away: null },
      cards: [{ by: "home", min: 3 }, {}],
      empty: [],
      flag: false,
    };
    const expected = new Set<string>();
    for (const [path, kinds] of statePathKinds(state, collapse, omit)) {
      for (const kind of kinds) expected.add(`${path} ${kind}`);
    }
    expect([...stateShapeTokens(state, collapse, omit)].sort()).toEqual([...expected].sort());
    expect([...expected].some((token) => token.startsWith("cfg"))).toBe(false);
  });
});

// ----------------------------------------------------------------- anchors

describe("anchorSteps — deliberate full states, not a sample", () => {
  const states = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => JSON.stringify({ cfg: { x: 1 }, step: i }));

  it("always keeps the FIRST and the LAST step", () => {
    const anchors = anchorSteps(states(37), { configKey: "cfg" });
    expect(anchors[0]).toBe(0);
    expect(anchors[anchors.length - 1]).toBe(36);
  });

  it("keeps a stride of interior anchors so a change can be localised", () => {
    const anchors = anchorSteps(states(37), { configKey: "cfg" });
    for (let i = 0; i < 37; i += ANCHOR_STRIDE) expect(anchors).toContain(i);
  });

  it("never leaves a gap wider than the stride", () => {
    const anchors = anchorSteps(states(120), { configKey: "cfg" });
    for (let i = 1; i < anchors.length; i++) {
      expect((anchors[i] as number) - (anchors[i - 1] as number)).toBeLessThanOrEqual(
        ANCHOR_STRIDE,
      );
    }
  });

  it("is sorted and free of duplicates", () => {
    const anchors = anchorSteps(states(45), { configKey: "cfg" });
    expect(anchors).toEqual([...new Set(anchors)].sort((a, b) => a - b));
  });

  it("handles a one-step and a zero-step stream", () => {
    expect(anchorSteps(states(1), { configKey: "cfg" })).toEqual([0]);
    expect(anchorSteps([], { configKey: "cfg" })).toEqual([]);
  });

  // The rule that makes the anchors deliberate rather than arbitrary.
  it("keeps every step at which the state SHAPE grows, stride or not", () => {
    const plain = { cfg: { x: 1 }, phase: "live" };
    const grown = { cfg: { x: 1 }, phase: "live", shootout: { attempts: [] } };
    const raw = [
      ...Array.from({ length: 7 }, () => JSON.stringify(plain)),
      JSON.stringify(grown), // step 7 — off-stride, and the shape grew here
      ...Array.from({ length: 4 }, () => JSON.stringify(grown)),
    ];
    expect(anchorSteps(raw, { configKey: "cfg" })).toContain(7);
  });

  it("does NOT keep an off-stride step that only changes a VALUE", () => {
    const raw = Array.from({ length: 12 }, (_, i) =>
      JSON.stringify({ cfg: { x: 1 }, goals: i }),
    );
    expect(anchorSteps(raw, { configKey: "cfg" })).not.toContain(7);
  });

  it("ignores the config when deciding that the shape grew", () => {
    // The config is constant across a stream and step 0 pins it; a config path
    // must never drive an anchor or the rule would anchor step 0 twice over.
    const raw = [
      JSON.stringify({ cfg: { x: 1 }, phase: "live" }),
      ...Array.from({ length: 6 }, () => JSON.stringify({ cfg: { x: 1, y: 2 }, phase: "live" })),
    ];
    expect(anchorSteps(raw, { configKey: "cfg" })).toEqual([0, 6]);
  });
});

// ------------------------------------------------------------------ slimming

describe("slimCorpus — anchors in full, everything else a digest", () => {
  // The COMMITTED corpus is slim, so the full form has to be derived rather than
  // read: `unslimCorpus` re-folds the ledger the corpus still stores. Reading
  // the committed file as "full" would compare a corpus with itself and every
  // assertion below would hold vacuously.
  const corpus = unslimCorpus(football, readCorpus("football"));
  const slim = slimCorpus(football, corpus);

  it("keeps one entry per event, so states[i] still indexes events[i]", () => {
    for (let i = 0; i < corpus.streams.length; i++) {
      expect(slim.streams[i]?.states).toHaveLength(corpus.streams[i]?.states.length as number);
    }
  });

  it("keeps the FIRST and LAST state of every stream in full", () => {
    for (const stream of slim.streams) {
      const last = stream.states.length - 1;
      expect(isStateDigest(stream.states[0] as string)).toBe(false);
      expect(isStateDigest(stream.states[last] as string)).toBe(false);
    }
  });

  it("replaces every non-anchor step with the digest of the state it dropped", () => {
    for (let s = 0; s < corpus.streams.length; s++) {
      const before = corpus.streams[s] as { states: string[]; config: string; lineups?: never };
      const after = slim.streams[s] as { states: string[] };
      const configKey = configStateKey(football, corpus.configs[before.config]);
      for (let i = 0; i < before.states.length; i++) {
        const entry = after.states[i] as string;
        if (!isStateDigest(entry)) {
          expect(entry).toBe(before.states[i]);
          continue;
        }
        expect(entry).toBe(stateDigest(before.states[i] as string, configKey));
      }
    }
  });

  it("never digests outcome, summary or deltas — standings depend on them", () => {
    for (let s = 0; s < corpus.streams.length; s++) {
      expect(slim.streams[s]?.outcome).toBe(corpus.streams[s]?.outcome);
      expect(slim.streams[s]?.summary).toBe(corpus.streams[s]?.summary);
      expect(slim.streams[s]?.deltas).toBe(corpus.streams[s]?.deltas);
    }
  });

  it("never touches the recorded ledger", () => {
    expect(slim.streams.map((s) => s.events)).toEqual(corpus.streams.map((s) => s.events));
    expect(slim.configs).toEqual(corpus.configs);
    expect(slim.key).toBe(corpus.key);
    expect(slim.version).toBe(corpus.version);
  });

  it("is idempotent — re-slimming an already-slim corpus is a no-op", () => {
    expect(slimCorpus(football, slim)).toEqual(slim);
    // A stream short enough that every step is an anchor is legitimately NOT
    // slim, so pick one the rule actually digested — and assert some stream was.
    const slimmed = slim.streams.filter(isSlimStream);
    expect(slimmed.length).toBeGreaterThan(0);
    for (const stream of slimmed) expect(isSlimStream(stream)).toBe(true);
    expect(corpus.streams.some(isSlimStream)).toBe(false);
  });

  it("actually saves most of the bytes", () => {
    const weigh = (c: unknown): number => JSON.stringify(c).length;
    expect(weigh(slim)).toBeLessThan(weigh(corpus) * 0.6);
  });
});

// ------------------------------------------------------------ the replay seam

describe("stepMismatch — exact at an anchor, digest everywhere else", () => {
  const corpus = unslimCorpus(football, readCorpus("football"));
  const slim = slimCorpus(football, corpus);
  const index = slim.streams.findIndex(isSlimStream);
  const stream = slim.streams[index] as GoldenStream;
  const full = corpus.streams[index] as GoldenStream;
  const configKey = configStateKey(football, corpus.configs[stream.config], stream.lineups);
  const anchor = stream.states.findIndex((s, i) => i > 0 && !isStateDigest(s));
  const digested = stream.states.findIndex(isStateDigest);

  it("found both kinds of step to test", () => {
    expect(anchor).toBeGreaterThan(0);
    expect(digested).toBeGreaterThan(0);
  });

  it("passes the recorded state at both an anchor and a digest step", () => {
    expect(stepMismatch(stream, anchor, full.states[anchor] as string, configKey)).toBeNull();
    expect(stepMismatch(stream, digested, full.states[digested] as string, configKey)).toBeNull();
  });

  it("reds at an ANCHOR step and still names the key that moved", () => {
    const moved = (full.states[anchor] as string).replace(`"phase"`, `"phaseX"`);
    const hit = stepMismatch(stream, anchor, moved, configKey);
    expect(hit).not.toBeNull();
    expect(hit).toContain("phaseX");
  });

  it("reds at a DIGEST step", () => {
    const moved = `${(full.states[digested] as string).slice(0, -1)},"injected":1}`;
    expect(stepMismatch(stream, digested, moved, configKey)).not.toBeNull();
  });

  // A digest cannot say what changed, so the message has to say where to look.
  it("tells the reader the full state is RECOMPUTABLE, and names the nearest anchor", () => {
    const moved = `${(full.states[digested] as string).slice(0, -1)},"injected":1}`;
    const hit = stepMismatch(stream, digested, moved, configKey) as string;
    expect(hit).toContain("digest");
    expect(hit).toContain("recomputeStream");
    expect(hit).toContain("stream.events");
    expect(hit).toMatch(/nearest stored full state is step \d+/);
  });

  it("still tolerates an additive config knob at a digest step", () => {
    const widened = (full.states[digested] as string).replace(
      `"cfg":{`,
      `"cfg":{"brandNewKnob":true,`,
    );
    expect(stepMismatch(stream, digested, widened, configKey)).toBeNull();
  });
});

describe("verifyStream — one gate, driven by the replay test and the mutation list alike", () => {
  const corpus = unslimCorpus(football, readCorpus("football"));
  const slim = slimCorpus(football, corpus);
  const index = slim.streams.findIndex(isSlimStream);

  it("passes every committed stream, full corpus and slim corpus alike", () => {
    for (let i = 0; i < corpus.streams.length; i++) {
      expect(verifyStream(football, corpus, corpus.streams[i] as GoldenStream)).toEqual([]);
      expect(verifyStream(football, slim, slim.streams[i] as GoldenStream)).toEqual([]);
    }
  });

  it("reports a TRUNCATED replay rather than passing on the steps that remain", () => {
    const stream = slim.streams[index] as GoldenStream;
    const replayed = recomputeStream(
      football,
      slim.configs[stream.config],
      stream.events,
      stream.lineups,
    );
    const truncated = { ...replayed, states: replayed.states.slice(0, -1) };
    expect(verifyStream(football, slim, stream, truncated).length).toBeGreaterThan(0);
  });

  it("reports outcome, summary and deltas independently", () => {
    const stream = slim.streams[index] as GoldenStream;
    const replayed = recomputeStream(
      football,
      slim.configs[stream.config],
      stream.events,
      stream.lineups,
    );
    for (const key of ["outcome", "summary", "deltas"] as const) {
      const failures = verifyStream(football, slim, stream, { ...replayed, [key]: `{"x":1}` });
      expect(failures.join("\n"), key).toContain(key);
    }
  });
});

// -------------------------------------------------- the re-baseline writes slim

describe("rebaselineCorpus — writes slim states and still keeps the recorded config", () => {
  const corpus = unslimCorpus(football, readCorpus("football"));

  it("produces slim streams from a full corpus", () => {
    const after = rebaselineCorpus(football, corpus);
    expect(after.streams.some(isSlimStream)).toBe(true);
    expect(after.streams.map((s) => s.events)).toEqual(corpus.streams.map((s) => s.events));
    for (let i = 0; i < corpus.streams.length; i++) {
      expect(after.streams[i]?.states).toHaveLength(corpus.streams[i]?.states.length as number);
    }
  });

  it("is a fixed point on an ALREADY-slim corpus — a second run writes the same bytes", () => {
    const once = rebaselineCorpus(football, corpus);
    expect(rebaselineCorpus(football, once)).toEqual(once);
  });

  it("keeps the RECORDED config at every anchor of an already-slim corpus", () => {
    // The recorded config is only stored at anchors now, so a re-baseline of a
    // slim corpus has to take it from the stream's first stored state rather
    // than from the step's own — which no longer has one.
    const slim = slimCorpus(football, corpus);
    const stream = slim.streams[slim.streams.findIndex(isSlimStream)] as GoldenStream;
    const stripped: GoldenStream = {
      ...stream,
      states: stream.states.map((s) =>
        isStateDigest(s) ? s : s.replace(`,"abandonPolicy":"replay"}`, "}"),
      ),
    };
    expect(stripped.states[0]).not.toContain("abandonPolicy");
    const after = rebaselineCorpus(football, { ...slim, streams: [stripped] });
    for (const state of after.streams[0]?.states ?? []) {
      if (isStateDigest(state)) continue;
      expect(state).not.toContain("abandonPolicy");
    }
  });
});

// --------------------------------------------------- the coverage guarantee
//
// The gates that walk recorded states for a SHAPE must be unable to tell the
// difference. `recordedStatePaths` feeds `uncoveredStatePaths` (the state half
// of the additive tripwire) and `stateShapeOf` feeds the committed
// `<key>.schema.json` files, whose CI gate is byte equality after a regenerate.
// If either moved, slimming would have silently narrowed a different tripwire
// and dropped eleven schema snapshots on the floor.

describe("slimming preserves every shape gate that reads the recorded states", () => {
  for (const module of builtinModules) {
    it(`${module.key}: recordedStatePaths and stateShapeOf are unchanged`, async () => {
      const { stateShapeOf } = await import("./schema-snapshot.ts");
      const committed = readCorpus(module.key);
      const full = unslimCorpus(module, committed);
      const slim = slimCorpus(module, full);
      expect(recordedStatePaths(module, slim)).toEqual(recordedStatePaths(module, full));
      expect(stateShapeOf(module, slim)).toEqual(stateShapeOf(module, full));
      // And the committed file IS that canonical slim form. This is what catches
      // a hand-edited digest, a hand-edited anchor, or a corpus slimmed under a
      // different anchor rule than the one this suite proves things about.
      expect(slim).toEqual(committed);
    }, 30_000);
  }
});

// ------------------------------------------------ EXTEND_GOLDEN writes slim
//
// The gate two blocks up asserts the committed corpus IS `slimCorpus` of itself.
// `EXTEND_GOLDEN=1` is the one sanctioned way a new stream reaches a committed
// corpus, so a stream it appends in FULL form breaks that gate the moment it
// lands — and breaks it with a message about "a hand-edited digest, a
// hand-edited anchor", which points at the wrong cause entirely. The scenario is
// not hypothetical: a new fidelity-tier event type reds `golden.test.ts`, whose
// failure tells the reader to run exactly this mode.
//
// Only the APPENDED stream is slimmed, never the whole corpus. `golden.test.ts`
// asserts `streams.slice(0, before.length)` equals the committed prefix byte for
// byte, and re-slimming an already-slim stream is not an identity: `anchorSteps`
// derives shape growth by walking states, a digest contributes no shape, so a
// second pass can compute a DIFFERENT anchor set from the one the full states
// produced.

describe("extendCorpus appends in the canonical slim form", () => {
  // Dropping the last stream leaves a coverage token uncovered, so the greedy
  // has something to append; each of these then appends a stream long enough
  // that slimming digests some of its steps. Cheap: ~250 ms for all three.
  for (const key of ["volleyball", "badminton", "tabletennis"]) {
    it(`${key}: the appended stream is already slim, and the prefix is untouched`, () => {
      const module = builtinModules.find((m) => m.key === key) as (typeof builtinModules)[number];
      const committed = readCorpus(key);
      const trimmed = { ...committed, streams: committed.streams.slice(0, -1) };
      const { corpus, appended } = extendCorpus(module, trimmed);

      expect(
        appended.length,
        `${key}: dropping the last stream left nothing uncovered, so nothing was appended and ` +
          `this test proves nothing. Pick a module whose last stream carries a unique token.`,
      ).toBeGreaterThan(0);
      // The constraint the fix must not break: existing streams byte for byte.
      expect(corpus.streams.slice(0, trimmed.streams.length)).toEqual(trimmed.streams);

      const fresh = corpus.streams.slice(trimmed.streams.length);
      const canonical = slimCorpus(module, corpus).streams.slice(trimmed.streams.length);
      // Aiming, and it must hold whichever way `extendCorpus` writes: the
      // canonical slim form of what was appended DOES digest steps. A stream
      // short enough that every step is an anchor would make the gate below
      // trivially true.
      expect(
        canonical.some((stream) => stream.states.some(isStateDigest)),
        `${key}: the appended stream is too short to digest a step, so "already slim" is ` +
          `trivially true and the gate below cannot fail`,
      ).toBe(true);
      // The gate itself, stated the way golden-slim's own gate states it: the
      // corpus `EXTEND_GOLDEN=1` would write IS its own canonical slim form.
      expect(fresh).toEqual(canonical);
      expect(slimCorpus(module, corpus)).toEqual(corpus);
    }, 30_000);
  }
});
