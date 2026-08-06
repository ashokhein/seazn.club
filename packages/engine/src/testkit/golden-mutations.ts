// #429 scope item 3 — the mutation list the slim corpus has to keep killing.
//
// WHY A LIST AND NOT A PARAGRAPH. Slimming the corpora replaces most of what
// the tripwire compares (a full recorded state per step) with a 64-bit digest
// of it. "The digest is over the same text, so detection is unchanged" is an
// argument, and an argument is not evidence: the way this goes wrong is that
// some class of change stops redding and nobody notices for a year, because the
// gate reporting success is exactly what a weakened gate looks like. So every
// class of break the corpus is supposed to catch is written down here, run
// against the corpus in BOTH forms, and required to red in both. A mutation the
// full corpus killed and the slim one does not is a blocker.
//
// HOW THE MUTATIONS ARE APPLIED. To the REPLAYED result, not to a module's
// source: `verifyStream` takes the replay as an argument precisely so a
// perturbation can stand in for a fold that changed. That makes every entry
// deterministic, cheap and CI-safe, so the list runs in the normal suite
// instead of being a procedure someone is supposed to remember to follow. The
// one entry that cannot work this way is a source-level schema narrowing, and
// it is recorded as a manual procedure with the failure line it produces.
//
// WHAT IS DELIBERATELY NOT HERE. The football `abandonPolicy` enum narrowing is
// in the list but marked `killedBy: "schema-snapshot"`, because the corpus does
// not kill it and never did — the frozen states pin the one value the corpus
// recorded, so dropping a DIFFERENT member of the enum moves no state at all.
// That is the two gates' division of labour, and writing it down as a corpus
// mutation that "passes" would be a lie in the other direction.
import type { AnySportModule } from "../sport/module.ts";
import {
  anchorSteps,
  jsonObjectMembers,
  recomputeStream,
  slimStates,
  stepMismatch,
  verifyStream,
  type GoldenCorpus,
  type GoldenEvent,
  type GoldenStream,
  type JsonMember,
  type ReplayedStream,
} from "./golden.ts";

// ------------------------------------------------------------ text surgery
//
// Every state-level mutation edits the SOURCE TEXT of a recorded state rather
// than a parsed object. That is not fussiness: `JSON.parse` reorders
// integer-like keys, so a parse/re-serialise round trip cannot express "these
// two keys were recorded in the other order" at all — the mutation would
// normalise itself away and the entry would be vacuous.

function membersOf(state: string): JsonMember[] {
  const members = jsonObjectMembers(state);
  if (members === null) throw new Error(`not a JSON object: ${state.slice(0, 60)}`);
  return members;
}

function render(members: readonly JsonMember[]): string {
  return `{${members.map((m) => `${m.rawKey}:${m.rawValue}`).join(",")}}`;
}

/** The first integer literal in VALUE position, incremented. */
function bumpFirstNumber(raw: string): string | null {
  const match = /:(-?\d+)(?=[,}])/.exec(raw);
  if (match === null) return null;
  const value = Number(match[1]) + 1;
  return `${raw.slice(0, match.index)}:${value}${raw.slice(match.index + match[0].length)}`;
}

function nonConfig(members: readonly JsonMember[], configKey: string | null): number[] {
  return members.flatMap((member, i) => (member.key === configKey ? [] : [i]));
}

/** Applies `edit` to exactly one step of a replayed stream. */
function atStep(
  replayed: ReplayedStream,
  step: number,
  edit: (state: string) => string,
): ReplayedStream {
  return { ...replayed, states: replayed.states.map((s, i) => (i === step ? edit(s) : s)) };
}

// ------------------------------------------------------------- the contract

export interface MutationContext {
  module: AnySportModule;
  /** Which storage form the corpus under test is in. Every entry must red in
   *  both — that IS the equivalence proof. */
  form: "full" | "slim";
  /** The corpus, already in `form`. */
  corpus: GoldenCorpus;
  /** A stream of it long enough that `form: "slim"` digests some of its steps. */
  stream: GoldenStream;
  /** A step the SLIM form stores as a digest and the FULL form stores whole —
   *  the step slimming could have weakened, so every state-level mutation that
   *  can be applied there is. */
  digestStep: number;
  /** An anchored step, stored whole in both forms. */
  anchorStep: number;
  /** Where this module files its parsed config in its state, or null. */
  configKey: string | null;
  /** The unmutated replay of `stream`. */
  replayed: ReplayedStream;
  /** The real gate, as the replay test calls it. Non-empty is a kill. */
  verify: (replayed: ReplayedStream) => string[];
  /** Puts hand-written recorded states into `form`, for the entries that need a
   *  shape no real fold produces (an integer-like state key; a module that
   *  files its config under a name other than `cfg`). */
  synthetic: (states: readonly string[], configKey: string | null) => GoldenStream;
}

export interface CorpusMutation {
  id: string;
  /** The class of back-compat break this stands for. */
  klass:
    | "fold"
    | "state-shape"
    | "state-order"
    | "config"
    | "outcome"
    | "ledger"
    | "schema-narrowing";
  /** Where the entry came from — a W4 class, or a defect proven in this pass. */
  origin: string;
  /** Why the gate must red on it. */
  why: string;
  /** Which of the two gates actually kills it. `schema-snapshot` entries are
   *  the honest record that the corpus does NOT, and why. */
  killedBy: "corpus" | "schema-snapshot";
  /** Returns the gate's failure messages. A non-empty result is the kill.
   *  Absent only on a `manual` entry. */
  run?: (ctx: MutationContext) => string[];
  /** A break no runtime perturbation can express, with the procedure to run it
   *  by hand and the failure line it produces. */
  manual?: { procedure: string; expected: string };
}

/** Perturbations the corpus must TOLERATE, in both forms. Without these the
 *  list above proves nothing: a gate that reds on everything kills every
 *  mutation and guards nothing. */
export interface CorpusTolerance {
  id: string;
  why: string;
  run: (ctx: MutationContext) => string[];
}

// ------------------------------------------------------------- the mutations

export const CORPUS_MUTATIONS: CorpusMutation[] = [
  {
    id: "state-value-changed",
    klass: "fold",
    origin: "W4 — a changed fold value, the break the corpus exists for",
    why:
      "A fold that starts producing a different number at any step is a behaviour change. " +
      "Applied at a digest-only step, because that is the step slimming could have blinded.",
    killedBy: "corpus",
    run: (ctx) =>
      ctx.verify(
        atStep(ctx.replayed, ctx.digestStep, (state) => {
          const members = membersOf(state);
          for (const i of nonConfig(members, ctx.configKey)) {
            const bumped = bumpFirstNumber((members[i] as JsonMember).rawValue);
            if (bumped === null) continue;
            const copy = [...members];
            copy[i] = { ...(members[i] as JsonMember), rawValue: bumped };
            return render(copy);
          }
          throw new Error("no numeric value in this state to change");
        }),
      ),
  },
  {
    id: "state-key-dropped",
    klass: "state-shape",
    origin: "W4 — a dropped state key",
    why: "A state field that stops being written is a removal, and removals are what break replay.",
    killedBy: "corpus",
    run: (ctx) =>
      ctx.verify(
        atStep(ctx.replayed, ctx.digestStep, (state) => {
          const members = membersOf(state);
          const drop = nonConfig(members, ctx.configKey).at(-1) as number;
          return render(members.filter((_, i) => i !== drop));
        }),
      ),
  },
  {
    id: "state-key-added",
    klass: "state-shape",
    origin: "W4 — an added state key",
    why:
      "Only the module's CONFIG is compared as a subset. A new key in the fold itself is a " +
      "state change and must red — that is what REBASELINE_GOLDEN exists to land deliberately.",
    killedBy: "corpus",
    run: (ctx) =>
      ctx.verify(
        atStep(ctx.replayed, ctx.digestStep, (state) =>
          render([
            ...membersOf(state),
            { rawKey: `"__addedByMutation"`, key: "__addedByMutation", rawValue: "1" },
          ]),
        ),
      ),
  },
  {
    id: "state-key-reordered",
    klass: "state-order",
    origin: "W4 — a reordered state key",
    why:
      "The comparison this digest replaces was byte-exact on the recorded source text, key " +
      "order included, and the folds are deterministic, so replay reproduces the recorded " +
      "order exactly. An order-insensitive digest would be strictly WEAKER than what it " +
      "replaces, for no benefit — so order is part of the digest and this entry pins it.",
    killedBy: "corpus",
    run: (ctx) =>
      ctx.verify(
        atStep(ctx.replayed, ctx.digestStep, (state) => {
          const members = membersOf(state);
          const [a, b] = nonConfig(members, ctx.configKey);
          const copy = [...members];
          copy[a as number] = members[b as number] as JsonMember;
          copy[b as number] = members[a as number] as JsonMember;
          return render(copy);
        }),
      ),
  },
  {
    id: "state-integer-key-reordered",
    klass: "state-order",
    origin:
      "#429 scope item 4b, proven this session — a JSON.parse round trip normalises " +
      "integer-like keys, so a comparison that parses both sides reports a real order change " +
      "as EQUAL",
    why:
      "No corpus has an integer-like state key today, which is why this needs a hand-written " +
      "stream: the day a module numbers a map by period, over or board, the failure mode of " +
      "the old comparison was a gate reporting success. Driven at a DIGEST-only step, so it " +
      "proves the digest inherited the order-sensitivity and not just the exact path.",
    killedBy: "corpus",
    run: (ctx) => {
      // String literals, not object literals: `JSON.stringify({"2":…,"1":…})`
      // reorders at construction, so a literal-built fixture is vacuous.
      const states = Array.from(
        { length: 12 },
        (_, i) => `{"cfg":{"x":1},"2":"b${i}","1":"a"}`,
      );
      const stream = ctx.synthetic(states, "cfg");
      const step = 3; // off-stride, shape never grows: digested in slim form
      const reordered = `{"cfg":{"x":1},"1":"a","2":"b${step}"}`;
      const hit = stepMismatch(stream, step, reordered, "cfg");
      return hit === null ? [] : [hit];
    },
  },
  {
    id: "state-config-value-changed",
    klass: "config",
    origin:
      "#429 scope item 4a, proven this session — the subset tolerance used to be handed to " +
      "whatever key was literally spelled `cfg`, which is a claim about a SPELLING standing " +
      "in for a claim about the module",
    why:
      "A changed value on a config key the corpus recorded must still red, and it must red " +
      "for a module that files its config under any other name. Driven at an ANCHOR: a " +
      "digest-only step is config-blind by design, which costs nothing because no fold " +
      "rewrites the config and step 0 is always an anchor.",
    killedBy: "corpus",
    run: (ctx) => {
      const states = Array.from(
        { length: 12 },
        (_, i) => `{"settings":{"halfMinutes":45},"phase":"live","n":${i}}`,
      );
      const stream = ctx.synthetic(states, "settings");
      const changed = `{"settings":{"halfMinutes":40},"phase":"live","n":0}`;
      const hit = stepMismatch(stream, 0, changed, "settings");
      return hit === null ? [] : [hit];
    },
  },
  {
    id: "outcome-changed",
    klass: "outcome",
    origin: "W4 — a changed outcome",
    why:
      "Never digested, always exact. The outcome is what standings are computed from and it " +
      "is a few hundred bytes, so there is nothing to buy by weakening it.",
    killedBy: "corpus",
    run: (ctx) => ctx.verify({ ...ctx.replayed, outcome: `{"kind":"win","winner":"__mutated"}` }),
  },
  {
    id: "summary-changed",
    klass: "outcome",
    origin: "W4 — the summary the scoreboard reads",
    why: "Same rule as the outcome: small, load-bearing, never digested.",
    killedBy: "corpus",
    run: (ctx) => ctx.verify({ ...ctx.replayed, summary: `{"__mutated":true}` }),
  },
  {
    id: "deltas-changed",
    klass: "outcome",
    origin: "W4 — a changed standings delta",
    why:
      "The league table is derived from these. A points change that moved no state at all " +
      "would otherwise be invisible to the whole harness.",
    killedBy: "corpus",
    run: (ctx) => ctx.verify({ ...ctx.replayed, deltas: `{"league":[99,0],"knockout":null}` }),
  },
  {
    id: "stream-truncated",
    klass: "ledger",
    origin: "W4 — a truncated stream",
    why:
      "A fold that stops early replays every step it did produce correctly, so the per-step " +
      "comparison alone cannot see it. The step COUNT has to be asserted separately.",
    killedBy: "corpus",
    run: (ctx) => ctx.verify({ ...ctx.replayed, states: ctx.replayed.states.slice(0, -1) }),
  },
  {
    id: "event-payload-changed",
    klass: "ledger",
    origin: "W4 — a changed event payload",
    why:
      "The recorded ledger is the one thing a re-baseline may never touch, and it is what " +
      "makes every digested state recomputable. An altered payload must red — either because " +
      "the fold diverges, or because the payload no longer parses at all.",
    killedBy: "corpus",
    run: (ctx) => {
      const events: GoldenEvent[] = ctx.stream.events.map((event, i) =>
        i === ctx.digestStep ? { ...event, payload: flipSide(event.payload) } : event,
      );
      let replayed: ReplayedStream;
      try {
        replayed = recomputeStream(
          ctx.module,
          ctx.corpus.configs[ctx.stream.config],
          events,
          ctx.stream.lineups,
        );
      } catch (error) {
        return [`the mutated ledger no longer folds: ${String(error)}`];
      }
      return ctx.verify(replayed);
    },
  },
  {
    id: "football-abandonPolicy-enum-narrowed",
    klass: "schema-narrowing",
    origin: "#429 scope item 2 — the case that motivated the schema snapshots",
    why:
      "THE CORPUS DOES NOT KILL THIS, and that is the entry. Every football stream records " +
      "abandonPolicy: \"replay\", so the frozen states pin that ONE member; dropping any " +
      "other member of the enum moves no recorded state and all eleven corpora stay green. " +
      "`<key>.schema.json` records the DECLARATION instead of a replay, so the narrowing is " +
      "a removed line there. The two gates are not redundant and this is where that shows.",
    killedBy: "schema-snapshot",
    manual: {
      procedure:
        "In src/sports/football/config.ts narrow the abandonPolicy enum to exclude a member " +
        "the corpus does NOT record (e.g. drop \"abandoned\"), then run: " +
        "npx vitest run src/testkit/golden.test.ts src/testkit/schema-snapshot.test.ts",
      expected:
        "golden.test.ts stays GREEN for all eleven modules. schema-snapshot.test.ts reds on " +
        "football with a removed line under configSchema — the staleness failure counts " +
        "removals separately because a removed line is a narrowing.",
    },
  },
];

/** Football payloads carry a `by` side on the events that matter; flipping it
 *  keeps the payload parseable, so the kill comes from the STATE comparison
 *  rather than from a refusal. The fallback covers a payload that has no side. */
function flipSide(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { __mutated: true };
  }
  const record = payload as Record<string, unknown>;
  if (record.by === "home") return { ...record, by: "away" };
  if (record.by === "away") return { ...record, by: "home" };
  return { ...record, __mutated: true };
}

// ------------------------------------------------------------ the tolerances

export const CORPUS_TOLERANCES: CorpusTolerance[] = [
  {
    id: "unmutated-replay",
    why:
      "The control that makes every entry above mean something. A gate that reds on an " +
      "untouched replay kills every mutation in the list and guards nothing.",
    run: (ctx) => ctx.verify(ctx.replayed),
  },
  {
    id: "config-knob-added",
    why:
      "The config-subset tolerance is PERMANENT. A zod `.default()` on an additive knob " +
      "shifts the resolved config in every frozen state while changing no fold; without the " +
      "tolerance the period family had to route around the harness with a compile-time " +
      "preset instead of a config field. The digest keeps it by hashing the same " +
      "config-placeholdered text the exact path compares.",
    run: (ctx) =>
      ctx.verify({
        ...ctx.replayed,
        states: ctx.replayed.states.map((state) => {
          if (ctx.configKey === null) return state;
          const members = membersOf(state);
          return render(
            members.map((member) =>
              member.key === ctx.configKey
                ? { ...member, rawValue: `{"__addedKnob":true,${member.rawValue.slice(1)}` }
                : member,
            ),
          );
        }),
      }),
  },
];

// --------------------------------------------------------------- the driver

/** Builds the context every entry is run against, for one storage form. */
export function mutationContext(
  module: AnySportModule,
  full: GoldenCorpus,
  slim: GoldenCorpus,
  form: "full" | "slim",
  streamIndex: number,
  digestStep: number,
  anchorStep: number,
  configKey: string | null,
): MutationContext {
  const corpus = form === "full" ? full : slim;
  const stream = corpus.streams[streamIndex] as GoldenStream;
  const replayed = recomputeStream(
    module,
    corpus.configs[stream.config],
    stream.events,
    stream.lineups,
  );
  return {
    module,
    form,
    corpus,
    stream,
    digestStep,
    anchorStep,
    configKey,
    replayed,
    verify: (result) => verifyStream(module, corpus, stream, result),
    synthetic: (states, key) => {
      const base: GoldenStream = {
        config: "synthetic",
        seed: 0,
        events: states.map(() => ({ type: "synthetic.step", payload: {} })),
        states: [...states],
        outcome: "null",
        summary: "{}",
        deltas: "{}",
      };
      if (form === "full") return base;
      const keep = new Set(anchorSteps(base.states, { configKey: key }));
      return { ...base, states: slimStates(base.states, keep, key) };
    },
  };
}
