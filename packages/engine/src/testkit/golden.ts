// Cross-sport golden-replay harness — W4 step 0 (#407 programme).
//
// WHY THIS EXISTS. `conformance.ts` generates its streams with fast-check at
// run time, so it re-derives its inputs from whatever the schemas currently
// are: it can never prove that a schema change was *additive*. This harness
// freezes a corpus of pre-change event streams to disk and replays them
// against the live module. A committed stream that no longer folds to the
// recorded state — or no longer parses against `eventSchema` — is a
// back-compat break, whatever the version number says.
//
// Generalised from the football-only gate that used to live in
// sports/football/football.golden.test.ts (same mulberry32 seeded walk over
// `module.arbitraryEvent`, same UPDATE_GOLDEN convention, now with per-event
// folded state and an eventSchema re-parse on every recorded payload).
//
// Regenerate ONLY when a fold change is intended:
//   UPDATE_GOLDEN=1 npx vitest run src/testkit/golden.test.ts
//
// Purity note: this file lives in testkit and may touch node:fs. Nothing under
// src/sport/** or src/sports/** may import it — @seazn/engine ships with zero
// runtime dependencies.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { EngineError } from "../core/errors.ts";
import { foldMatch, isCoreEventType, type EventEnvelope } from "../core/events.ts";
import type { LineupPair, StageCtx } from "../core/types.ts";
import { resolvePositions } from "../sport/catalog.ts";
import type { AnySportModule } from "../sport/module.ts";
import { buildStream, buildWalk, defaultLineupPair, makeEnvelope } from "./helpers.ts";
import { fieldPresent, optionalFieldPaths, valueFieldPaths } from "./schema-fields.ts";

// W4a (#425) §3.3 — every fold below is PAD-SHAPED: it builds a stream event by
// event, which is the write path. `strictFromSeq: 0` marks the whole stream new
// and is therefore exactly the pre-seam behaviour. Only a real READ path
// (apps/web fold.ts) and the cfg-replay property pass no options at all.
const STRICT_ALL = { strictFromSeq: 0 } as const;

// ---------------------------------------------------------------- generation

/** Streams shorter than this are "trivial" — a module that can reach it must. */
export const MIN_EVENTS = 20;
/** Hard cap on a recorded stream (keeps the committed corpus a sane size). */
export const MAX_EVENTS = 40;
/** Seeds always recorded, long or short — these catch the early-exit branches
 *  (forfeit / abandon / instant result) that a length filter would discard. */
const COVERAGE_SEEDS = 3;
/** Extra seeds picked purely for length, scanning up to SEED_SCAN. */
const LONG_PICKS = 2;
const SEED_SCAN = 500;
/** Modules that decide in one or two events by design (boardgame, generic)
 *  cannot give depth, so they get breadth instead: enough seeds that every
 *  branch of the result union — win / draw / agreement / forfeit / abandon —
 *  lands in the corpus. */
const SHORT_FALLBACK_SEEDS = 24;
/** Cap on configs per module (default + named variants + EXTRA_CONFIGS). */
const MAX_CONFIGS = 4;

/** Stage contexts standingsDelta is recorded under. */
const STAGE_CTXS: StageCtx[] = [{ kind: "league" }, { kind: "knockout" }];

// Hand-picked configs that no `variants` entry reaches but that own real fold
// paths. Football's pre-existing golden covered extra-time + shootout and the
// group-stage shootout points split; keeping them here preserves that coverage
// through the migration onto this harness.
const EXTRA_CONFIGS: Record<string, Record<string, unknown>> = {
  football: {
    knockout: { extraTime: { enabled: true, halfMinutes: 15 }, shootout: true },
    groupSO: {
      shootout: true,
      points: { win: 3, draw: 1, loss: 0, shootoutWin: 2, shootoutLoss: 1 },
    },
  },
};

// Where each module's golden lives: next to its implementation. The setbased
// trio share one directory, so the file name (not the directory) is the key.
export const SPORT_DIRS: Record<string, string> = {
  football: "football",
  cricket: "cricket",
  boardgame: "boardgame",
  carrom: "carrom",
  generic: "generic",
  volleyball: "setbased",
  badminton: "setbased",
  tabletennis: "setbased",
  tennis: "tennis",
  icehockey: "icehockey",
  hockey: "hockey",
};

const HERE = dirname(fileURLToPath(import.meta.url));

export function goldenPath(key: string): string {
  const dir = SPORT_DIRS[key];
  if (dir === undefined) {
    throw new Error(`no golden directory registered for sport module "${key}"`);
  }
  return join(HERE, "..", "sports", dir, `${key}.golden.json`);
}

// ------------------------------------------------------------------- corpus

export interface GoldenEvent {
  type: string;
  payload: unknown;
}

export interface GoldenStream {
  /** Key into GoldenCorpus.configs. */
  config: string;
  seed: number;
  /** W4 review item 3 — the lineups this stream was recorded against, when
   *  they are NOT `defaultLineupPair(resolvePositions(module, cfg))`. Absent on
   *  every pre-W4 stream, which is the point: changing the default lineups
   *  would change `init` for all eleven corpora, so a coverage stream that
   *  needs a bench (football cannot substitute without one) carries its own. */
  lineups?: LineupPair;
  events: GoldenEvent[];
  /** JSON of the folded state after each event — states[i] is the fold of
   *  events[0..i]. Length always equals events.length. */
  states: string[];
  /** JSON of module.outcome(finalState) — "null" while undecided. */
  outcome: string;
  /** JSON of module.summary(finalState). */
  summary: string;
  /** JSON of { [stageKind]: [homeDelta, awayDelta] | null }. */
  deltas: string;
}

export interface GoldenCorpus {
  key: string;
  /** The module version the corpus was recorded against. Replay asserts
   *  golden.version <= module.version — minor bumps are expected. */
  version: string;
  recordedBy: "testkit/golden.ts";
  params: { minEvents: number; maxEvents: number };
  /** Config name -> the RAW config object, re-parsed at replay time. */
  configs: Record<string, unknown>;
  streams: GoldenStream[];
}

// ------------------------------------------------------------------ recording

function configsFor(module: AnySportModule): Record<string, unknown> {
  const extra = EXTRA_CONFIGS[module.key] ?? {};
  const candidates: [string, unknown][] = [
    ["default", {}],
    ...Object.entries(extra),
    ...Object.entries(module.variants as Record<string, unknown>),
  ];
  const out: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (const [name, raw] of candidates) {
    let fingerprint: string;
    try {
      fingerprint = JSON.stringify(module.configSchema.parse(raw));
    } catch {
      continue; // e.g. generic has no valid empty config — its variants cover it
    }
    if (seen.has(fingerprint)) continue; // 11-a-side ≡ football's default
    seen.add(fingerprint);
    out[name] = raw;
    if (Object.keys(out).length >= MAX_CONFIGS) break;
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`module "${module.key}" has no parseable config`);
  }
  return out;
}

function seedsFor(module: AnySportModule, cfg: unknown, lineups: LineupPair): number[] {
  const picks = new Set<number>();
  for (let seed = 1; seed <= COVERAGE_SEEDS; seed++) picks.add(seed);
  let long = 0;
  for (let seed = 1; seed <= SEED_SCAN && long < LONG_PICKS; seed++) {
    if (buildStream(module, cfg, lineups, seed, MAX_EVENTS).length >= MIN_EVENTS) {
      picks.add(seed);
      long++;
    }
  }
  if (long === 0) {
    for (let seed = 1; seed <= SHORT_FALLBACK_SEEDS; seed++) picks.add(seed);
  }
  return [...picks].sort((a, b) => a - b);
}

/** Recomputes everything a GoldenStream records, from the module as it is
 *  RIGHT NOW. Replay compares this against the committed values; recording
 *  simply stores it. Deliberately never calls arbitraryEvent — a recorded
 *  corpus must be independent of the generator. */
export function recomputeStream(
  module: AnySportModule,
  rawConfig: unknown,
  events: readonly GoldenEvent[],
  recordedLineups?: LineupPair,
): Pick<GoldenStream, "states" | "outcome" | "summary" | "deltas"> {
  const cfg = module.configSchema.parse(rawConfig);
  const lineups = recordedLineups ?? defaultLineupPair(resolvePositions(module, cfg));
  const envelopes: EventEnvelope[] = events.map((event, i) => makeEnvelope(i, event));

  const states = envelopes.map((_, i) =>
    JSON.stringify(foldMatch(module, cfg, lineups, envelopes.slice(0, i + 1), STRICT_ALL)),
  );
  const finalState = foldMatch(module, cfg, lineups, envelopes, STRICT_ALL);
  const outcome = module.outcome(finalState);

  const deltas: Record<string, unknown> = {};
  for (const ctx of STAGE_CTXS) {
    deltas[ctx.kind] =
      outcome === null || (outcome.kind === "draw" && !module.supportsDraws(cfg, ctx.kind))
        ? null
        : module.standingsDelta(outcome, cfg, ctx, finalState);
  }

  return {
    states,
    outcome: JSON.stringify(outcome ?? null),
    summary: JSON.stringify(module.summary(finalState)),
    deltas: JSON.stringify(deltas),
  };
}

export function buildCorpus(module: AnySportModule): GoldenCorpus {
  const configs = configsFor(module);
  const streams: GoldenStream[] = [];

  for (const [name, raw] of Object.entries(configs)) {
    const cfg = module.configSchema.parse(raw);
    const lineups = defaultLineupPair(resolvePositions(module, cfg));
    for (const seed of seedsFor(module, cfg, lineups)) {
      const envelopes = buildStream(module, cfg, lineups, seed, MAX_EVENTS);
      const events: GoldenEvent[] = envelopes.map((e) => ({ type: e.type, payload: e.payload }));
      streams.push({ config: name, seed, events, ...recomputeStream(module, raw, events) });
    }
  }

  return {
    key: module.key,
    version: module.version,
    recordedBy: "testkit/golden.ts",
    params: { minEvents: MIN_EVENTS, maxEvents: MAX_EVENTS },
    configs,
    streams,
  };
}

// --------------------------------------------------------------------- io

export const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === "1";

/** Refresh the DERIVED half of a corpus — states, outcome, summary, deltas —
 *  leaving every recorded event byte-identical (#429: a re-baseline is
 *  legitimate when it is deliberate, isolated in its own commit, and reviewed
 *  as a state diff; a silent one is not). This is the only honest way to land
 *  an intended fold change on a frozen corpus: the ledger is untouched, so the
 *  diff IS the behaviour change and nothing hides inside a fresh generator
 *  walk. `UPDATE_GOLDEN=1` re-records the events too and must stay reserved
 *  for a corpus being built from nothing. */
export const REBASELINE_GOLDEN = process.env.REBASELINE_GOLDEN === "1";

/** Append coverage streams for uncovered fidelity-tier event types. */
export const EXTEND_GOLDEN = process.env.EXTEND_GOLDEN === "1";

// ------------------------------------------------------- coverage extension
//
// W4 review item 3. `carriesNonTrivialCorpus` asserted only `types.length > 2`,
// and the corpora were frozen before the W4 event types existed, so the gate
// covered a fraction of what it claimed to guard: football was missing 3 of its
// 7 tier types, cricket 12 of 15. Adding a required field to the PRE-EXISTING
// `FootballSub` left the whole golden gate green.
//
// The fix is coverage, and coverage means new streams. Existing streams are
// PRESERVED byte for byte — this only ever appends.

/** Event types a module declares in `fidelityTiers`. That declaration is the
 *  module's own claim about what a scorer can record, so it is the right
 *  yardstick for "does the corpus guard what it says it guards". */
export function tierEventTypes(module: AnySportModule): string[] {
  return [...new Set(module.fidelityTiers.flatMap((tier) => tier.eventTypes))].sort();
}

/** Tier types with no recorded event of that type. */
export function uncoveredTierTypes(module: AnySportModule, corpus: GoldenCorpus): string[] {
  const seen = new Set(eventTypesIn(corpus));
  return tierEventTypes(module).filter((type) => !seen.has(type));
}

// ------------------------------------------------- optional-FIELD coverage
//
// W4a (#425) T10. Everything above reasons about event TYPES, and one recorded
// event of a type satisfies it. The wave's own deliverable proved how little
// that covers: after the sanctioned EXTEND_GOLDEN pass, 0 of 148 icehockey and
// 0 of 274 football events carried `at`, because both modules already covered
// every type they declare and `extendCorpus` therefore appended nothing —
// a generator that has started emitting a new field does not retroactively
// reach a frozen corpus. Nothing in the ledger carried `at`, so making it
// required, renaming it, reshaping `GameTime` or narrowing `DurationSeconds`
// would have reddened none of the eleven corpora.

/** Walking a union is not free and `extendCorpus` asks per candidate stream. */
const DECLARED_FIELDS = new WeakMap<AnySportModule, string[]>();

/** Every OPTIONAL field the module's event union declares, as dotted paths.
 *
 *  LIMIT, and read it before trusting a green. The union's branches carry no
 *  discriminator — the ENVELOPE's `type` is what `apply` reads — so there is no
 *  sound branch-to-type map here and the paths are pooled across the whole
 *  union. Coverage of `at` therefore means "SOME recorded payload writes `at`",
 *  not "every branch that declares `at` has one". Reshaping `GameTime`, renaming
 *  `at` on the shared schema, or narrowing `DurationSeconds` reds (they move
 *  every branch at once); renaming `at` on one branch only does not.
 *  `uncoveredTierTypes` is the assertion that guards the branch dimension. */
export function declaredOptionalFields(module: AnySportModule): string[] {
  const cached = DECLARED_FIELDS.get(module);
  if (cached !== undefined) return cached;
  const fields = optionalFieldPaths(module.eventSchema);
  DECLARED_FIELDS.set(module, fields);
  return fields;
}

/** Optional payload fields no seeded walk of the module's own `arbitraryEvent`
 *  can reach, each against the reason it cannot. THE REASON IS THE ENTRY: a
 *  list that grows without one is precisely the defect this gate exists to
 *  catch, one level up, and `golden-fields.test.ts` reds on a bare reason, on a
 *  path the module no longer declares, and on a path the ledger has since
 *  started writing.
 *
 *  Three classes appear below, and only the first is a corpus problem:
 *    GENERATOR — the branch declares the field, `arbitraryEvent` never sets it.
 *      NOT really an exemption: a coverage gap in the sport's own generator,
 *      wearing one. Twenty sat here and ALL TWENTY ARE CLOSED — football's
 *      added time, assists and penalty goals, carrom's named offender,
 *      tennis's receiver side, both period sports' whole shoot-out `meta` plus
 *      the goal's own period label, cricket's incoming batter, reviewed batter,
 *      umpire target and progressive innings, and the set-based trio's
 *      in-progress set snapshot — by widening the generators under
 *      src/sports/**, always SOMETIMES and never always: a field written on
 *      every event leaves the missing-field fold path exactly as unwalked as
 *      one written on none. `generator-fields.test.ts` is what holds them
 *      closed, and asserts the EXACT (now empty) set of those still blocked.
 *      The last seven were blocked on three fold defects the generator change
 *      merely EXPOSED — two cfg-derived refusals unguarded on the read path
 *      (§3.3) and a coarsener that emitted two partials for one set (§9.6) —
 *      and closing them meant fixing those first, not widening around them.
 *    KERNEL-UNION — the setbased kernel gives volleyball, badminton and
 *      tabletennis ONE event union while each sport's `records` preset
 *      registers a different subset of event types. The union therefore
 *      over-declares for a given sport: the field belongs to a type that sport
 *      cannot record at all, `apply` refuses it BY NAME, and no config reaches
 *      it (`records` is a compile-time preset, not a cfg knob).
 *    CFG — genuinely cfg-gated; prefer a COVERAGE_CONFIGS entry, and both that
 *      were found (generic's draws, hockey's assists) got one instead of a line
 *      here. Nothing is allow-listed under this class today. */
export const UNREACHABLE_FIELDS: Record<string, Record<string, string>> = {
  volleyball: {
    returns:
      "KERNEL-UNION: the setbased kernel gives all three sports ONE event union, but volleyball's preset registers no expedite system — apply refuses volleyball.expedite.start with `\"volleyball\" has no expedite system`, so no config or seed can record this field.",
    serving:
      "KERNEL-UNION: same as `returns` — the field rides on the expedite payload volleyball cannot record.",
  },
  badminton: {
    off: "KERNEL-UNION: apply refuses badminton.sub with `\"badminton\" does not record substitutions`; `records` is a compile-time preset, not a cfg knob, so no coverage config reaches it.",
    on: "KERNEL-UNION: same as `off` — the field rides on the substitution payload badminton cannot record.",
    returns:
      "KERNEL-UNION: apply refuses badminton.expedite.start with `\"badminton\" has no expedite system` — the expedite payload is table tennis's alone.",
    serving: "KERNEL-UNION: same as `returns` — rides on the expedite payload badminton cannot record.",
    technical:
      "KERNEL-UNION: apply refuses badminton.timeout with `\"badminton\" does not record timeouts`; the field rides on that payload.",
  },
  tabletennis: {
    off: "KERNEL-UNION: apply refuses tabletennis.sub with `\"tabletennis\" does not record substitutions` — its preset registers timeouts, sanctions and expedite, but no substitutions.",
    on: "KERNEL-UNION: same as `off` — rides on the substitution payload tabletennis cannot record.",
  },
};

function corpusEvents(corpus: GoldenCorpus): GoldenEvent[] {
  return corpus.streams.flatMap((stream) => stream.events);
}

/** Declared optional fields some event in `events` actually writes. */
function writtenFields(module: AnySportModule, events: readonly GoldenEvent[]): Set<string> {
  const out = new Set<string>();
  for (const path of declaredOptionalFields(module)) {
    if (events.some((event) => fieldPresent(event.payload, path))) out.add(path);
  }
  return out;
}

/** Declared optional fields no recorded payload writes, minus the allow-list. */
export function uncoveredTierFields(module: AnySportModule, corpus: GoldenCorpus): string[] {
  const written = writtenFields(module, corpusEvents(corpus));
  const allowed = UNREACHABLE_FIELDS[module.key] ?? {};
  return declaredOptionalFields(module).filter(
    (path) => !written.has(path) && !Object.hasOwn(allowed, path),
  );
}

/** What a candidate stream contributes to coverage, in one tagged namespace so
 *  `extendCorpus` can go on picking the stream that brings in the most of what
 *  is missing:
 *    `type:`  — an event type it records;
 *    `field:` — a declared optional PAYLOAD field it writes;
 *    `cfg:`   — a declared optional CONFIG field its config sets (T2);
 *    `state:` — a state path its fold writes (T2).
 *
 *  `cfg` and `state` tokens need what the events alone cannot say — the config
 *  the stream would be recorded under, and the states it folds to — so they
 *  appear only when the caller supplies them. */
export function coverageTokens(
  module: AnySportModule,
  events: readonly GoldenEvent[],
  context?: {
    rawConfig?: unknown;
    states?: readonly unknown[];
    collapse?: ReadonlySet<string>;
  },
): string[] {
  const out = new Set<string>();
  for (const event of events) out.add(`type:${event.type}`);
  for (const path of writtenFields(module, events)) out.add(`field:${path}`);
  if (context?.rawConfig !== undefined) {
    // The RESOLVED cfg, not the raw one: an appended stream freezes its parsed
    // cfg into every recorded state, and that is what `pinnedConfigFields` will
    // see once the stream lands. Scoring the raw object instead would make the
    // greedy pick undercount every defaulted knob it is about to pin.
    let resolved: unknown;
    try {
      resolved = module.configSchema.parse(context.rawConfig);
    } catch {
      resolved = undefined;
    }
    for (const path of declaredOptionalConfigFields(module)) {
      if (fieldPresent(context.rawConfig, path) || fieldPresent(resolved, path)) {
        out.add(`cfg:${path}`);
      }
    }
  }
  if (context?.states !== undefined) {
    const collapse = context.collapse ?? new Set<string>();
    for (const state of context.states) {
      for (const path of statePathsOf(state, collapse)) out.add(`state:${path}`);
    }
  }
  return [...out].sort();
}

/** Allow-listed fields the ledger DOES now write — stale entries, suppressing
 *  nothing while still reading as a considered exemption. */
export function staleUnreachableFields(module: AnySportModule, corpus: GoldenCorpus): string[] {
  const written = writtenFields(module, corpusEvents(corpus));
  return Object.keys(UNREACHABLE_FIELDS[module.key] ?? {})
    .filter((path) => written.has(path))
    .sort();
}

/** Allow-listed paths the module's event union no longer declares optional —
 *  a typo, or a field that has since been renamed, removed or made required. */
export function undeclaredUnreachableFields(module: AnySportModule): string[] {
  const declared = new Set(declaredOptionalFields(module));
  return Object.keys(UNREACHABLE_FIELDS[module.key] ?? {})
    .filter((path) => !declared.has(path))
    .sort();
}

// ------------------------------------------------ optional-CONFIG coverage
//
// T2 (#425 follow-up). Everything above reasons about the EVENT schema. The
// same additive question applies to `configSchema`, and nothing asked it: a
// module can narrow, rename or reshape an optional config knob and every one of
// the eleven corpora stays green, because a knob no recorded config sets and no
// frozen state carries is pinned by nothing at all. `subWindows`,
// `periodSeconds`, `clock.delay` and the ice-hockey/hockey `releaseOnGoal` were
// all in exactly that position when this was written — every one of them added
// by W4a, none of them guarded by the corpus the wave shipped.
//
// Unlike state, cfg HAS a runtime schema (`SportModule.configSchema`), so the
// declared side is the same walker the payload half uses.

const DECLARED_CONFIG_FIELDS = new WeakMap<AnySportModule, string[]>();

/** Every OPTIONAL field the module's config schema declares, as dotted paths. */
export function declaredOptionalConfigFields(module: AnySportModule): string[] {
  const cached = DECLARED_CONFIG_FIELDS.get(module);
  if (cached !== undefined) return cached;
  const fields = optionalFieldPaths(module.configSchema);
  DECLARED_CONFIG_FIELDS.set(module, fields);
  return fields;
}

/** The parsed `cfg` a stream's frozen state carries, or undefined. Taken from
 *  the FIRST recorded state: no fold rewrites `cfg`, so every state in a stream
 *  carries the same one, and `keepRecordedCfg` preserves it across a
 *  re-baseline precisely so this stays the cfg the corpus was frozen against. */
function recordedCfgOf(stream: GoldenStream): unknown {
  const first = stream.states[0];
  if (first === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(first);
    return isPlainObject(parsed) ? parsed.cfg : undefined;
  } catch {
    return undefined;
  }
}

/** Optional config fields a raw config WRITES. The scorer's-input rule the
 *  payload half uses, applied to the organiser's input: what matters is the
 *  value that was recorded, not what `parse` filled in around it. */
export function writtenConfigFields(module: AnySportModule, rawConfig: unknown): Set<string> {
  return new Set(declaredOptionalConfigFields(module).filter((p) => fieldPresent(rawConfig, p)));
}

/** Optional config fields the corpus PINS. Two independent pins, and a field
 *  needs only one of them, but they are not the same guarantee:
 *
 *    RAW — some recorded `configs` entry writes the key, so replay re-parses
 *      that value through the live schema. Narrowing the field's DOMAIN (a
 *      tightened `min`, a dropped enum member, an int where a float was) reds.
 *    FROZEN — some frozen state's serialised `cfg` carries the key, which
 *      `stateMismatch` compares as a subset. A rename, a removal, or a changed
 *      resolved value reds.
 *
 *  LIMIT, and it is why the two are reported as one set rather than silently
 *  conflated in a comment: a FROZEN-only pin does NOT catch a domain narrowing
 *  that still admits the recorded value — tightening `z.number().int()` to
 *  `z.literal(2)` on a knob whose default is 2 and which no config overrides
 *  reds nothing. Closing that needs a COVERAGE_CONFIGS entry that sets the knob
 *  to something, which is why one is always preferable to an allow-list line. */
export function pinnedConfigFields(module: AnySportModule, corpus: GoldenCorpus): Set<string> {
  const declared = declaredOptionalConfigFields(module);
  const recorded: unknown[] = [
    ...Object.values(corpus.configs),
    ...corpus.streams.map(recordedCfgOf),
  ];
  return new Set(declared.filter((p) => recorded.some((cfg) => fieldPresent(cfg, p))));
}

/** Optional config fields no recorded config sets and no frozen state carries,
 *  each against the reason no corpus can reach it. Same contract as
 *  UNREACHABLE_FIELDS — the reason IS the entry, and `golden-fields.test.ts`
 *  reds on a bare one, on a path the schema no longer declares, and on a path
 *  the corpus has since started pinning. Prefer a COVERAGE_CONFIGS entry: it
 *  makes the knob genuinely recorded instead of exempted. */
export const UNREACHABLE_CONFIG_FIELDS: Record<string, Record<string, string>> = {};

/** Declared optional config fields the corpus pins nowhere, minus the
 *  allow-list. */
export function uncoveredConfigFields(module: AnySportModule, corpus: GoldenCorpus): string[] {
  const pinned = pinnedConfigFields(module, corpus);
  const allowed = UNREACHABLE_CONFIG_FIELDS[module.key] ?? {};
  return declaredOptionalConfigFields(module).filter(
    (path) => !pinned.has(path) && !Object.hasOwn(allowed, path),
  );
}

/** Allow-listed config fields the corpus DOES pin — stale entries. */
export function staleUnreachableConfigFields(
  module: AnySportModule,
  corpus: GoldenCorpus,
): string[] {
  const pinned = pinnedConfigFields(module, corpus);
  return Object.keys(UNREACHABLE_CONFIG_FIELDS[module.key] ?? {})
    .filter((path) => pinned.has(path))
    .sort();
}

/** Allow-listed paths the config schema no longer declares optional. */
export function undeclaredUnreachableConfigFields(module: AnySportModule): string[] {
  const declared = new Set(declaredOptionalConfigFields(module));
  return Object.keys(UNREACHABLE_CONFIG_FIELDS[module.key] ?? {})
    .filter((path) => !declared.has(path))
    .sort();
}

// ---------------------------------------------------------- STATE coverage
//
// T2 (#425 follow-up), and the harder half. `SportModule<Cfg, Ev, State>`
// declares no `stateSchema` — `State` is a bare generic and every state shape
// is a plain TS interface never validated at runtime — so there is no schema to
// walk and no declared set to compare against.
//
// WHAT IS ALREADY GUARDED, so the gap is stated exactly. `stateMismatch`
// compares everything outside `cfg` as EXACT STRING equality, so for any path
// the corpus already writes, BOTH directions red today: narrowing or renaming
// changes the replayed string, and a new state key changes it too (which is
// what `REBASELINE_GOLDEN` exists for). Freezing the observed path set would
// therefore only restate, more weakly, an assertion the replay already makes
// byte for byte.
//
// WHAT IS NOT. A state field NO recorded stream writes is invisible to that
// comparison, and the wave's own fields were in exactly that position:
// `overran` and `overCount` are computed only under a `cfg.interruptions`
// allowance that no shipped variant declares, and football's `at` stamp reached
// cards and shoot-out penalties in the live generator while no frozen stream
// carried one. So the gap is COVERAGE, the same gap `uncoveredTierFields`
// closes for payloads.
//
// THE DECLARED SIDE, with no schema: the live modules themselves. A seeded
// sweep of `arbitraryEvent` over every candidate config says which state paths
// the module can produce NOW; the frozen corpora say which it has recorded.
// The difference is the uncovered set. That is self-maintaining in the way a
// hand-kept list is not — add a conditional state field, the sweep reaches it,
// and the gate reds until a stream is appended or the field is allow-listed.
//
// CONSEQUENCE worth knowing before widening a generator: this makes the gate
// sensitive to `arbitraryEvent`. A generator that starts reaching a new state
// path reds here until EXTEND_GOLDEN records one. That is the intended
// behaviour and it is also new blast radius.

/** The two side keys. A side-keyed map is symmetric by construction in every
 *  module here (`goals`, `squads`, `kindCounts`, `setPieces`), so keying the
 *  paths apart reports "this seed sin-binned an away player and not a home one"
 *  as a missing field. Collapsing them costs no real coverage: the two branches
 *  cannot have different shapes. */
const SIDE_KEYS = ["home", "away"];

/** Object keys the state walk renders as `[]` rather than as themselves —
 *  the side keys plus every entrant and person id in the lineups. Ids are the
 *  keys of the per-person records (cricket's `batterRuns`, `bowlerBalls`), and
 *  keying those by id turns lineup data into schema paths: 22 of them for one
 *  cricket innings, none of which names a field. */
function collapseKeysFor(lineups: LineupPair): Set<string> {
  const out = new Set<string>(SIDE_KEYS);
  for (const side of [lineups.home, lineups.away]) {
    out.add(side.entrantId);
    for (const slot of side.slots) out.add(slot.personId);
  }
  return out;
}

/** Dotted paths one folded state writes, `cfg` excluded — the config half above
 *  owns it, and leaving it in would double-count every knob. */
export function statePathsOf(state: unknown, collapse: ReadonlySet<string>): string[] {
  return valueFieldPaths(state, { collapse, omit: new Set(["cfg"]) });
}

function lineupsFor(module: AnySportModule, cfg: unknown, recorded?: LineupPair): LineupPair {
  return recorded ?? defaultLineupPair(resolvePositions(module, cfg));
}

/** Both state-path sets are walked repeatedly by the gate — the assertion, its
 *  failure message and the staleness checks all ask for them — and both are
 *  expensive: `recordedStatePaths` re-parses every state string of a corpus
 *  that runs to 1.6 MB for cricket, and `reachableStatePaths` folds thousands
 *  of generated events. Recomputing was not merely slow, it was WRONG in
 *  effect: the tennis and cricket cases crossed vitest's 5 s default and failed
 *  as an opaque `STACK_TRACE_ERROR`, which reads as a coverage failure and is
 *  not one. Keyed by corpus identity — `readCorpus` returns a fresh object per
 *  describe block, and a mutated corpus is a different object. */
const STATE_PATH_CACHE = new WeakMap<GoldenCorpus, { recorded?: string[]; reachable?: string[] }>();

function cacheFor(corpus: GoldenCorpus): { recorded?: string[]; reachable?: string[] } {
  const hit = STATE_PATH_CACHE.get(corpus);
  if (hit !== undefined) return hit;
  const fresh: { recorded?: string[]; reachable?: string[] } = {};
  STATE_PATH_CACHE.set(corpus, fresh);
  return fresh;
}

/** Every state path the FROZEN corpus writes, across every stream and every
 *  per-event state in it. */
export function recordedStatePaths(module: AnySportModule, corpus: GoldenCorpus): string[] {
  const cache = cacheFor(corpus);
  if (cache.recorded !== undefined) return cache.recorded;
  const out = new Set<string>();
  for (const stream of corpus.streams) {
    const cfg = module.configSchema.parse(corpus.configs[stream.config]);
    const collapse = collapseKeysFor(lineupsFor(module, cfg, stream.lineups));
    for (const serialised of stream.states) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(serialised);
      } catch {
        continue;
      }
      for (const path of statePathsOf(parsed, collapse)) out.add(path);
    }
  }
  cache.recorded = [...out].sort();
  return cache.recorded;
}

/** How far the reachability sweep walks. Deliberately generous relative to the
 *  recording pass (a state path can need a shoot-out, a super over or a fourth
 *  set) and deliberately fixed, so the declared set is a deterministic function
 *  of the modules and not of when the test ran. */
const STATE_SWEEP_SEEDS = 60;
const STATE_SWEEP_EVENTS = 80;

/** Every state path the LIVE module can still produce, from a seeded sweep of
 *  its own generator over every candidate config. This is the declared side of
 *  the state tripwire — see the section note for why a sweep stands in for the
 *  `stateSchema` the module does not have. */
export function reachableStatePaths(module: AnySportModule, corpus: GoldenCorpus): string[] {
  const cache = cacheFor(corpus);
  if (cache.reachable !== undefined) return cache.reachable;
  const out = new Set<string>();
  for (const [, raw] of coverageCandidates(module, corpus)) {
    let cfg: unknown;
    try {
      cfg = module.configSchema.parse(raw);
    } catch {
      continue;
    }
    const lineups = benchedLineups(module, cfg) ?? defaultLineupPair(resolvePositions(module, cfg));
    const collapse = collapseKeysFor(lineups);
    for (let seed = 1; seed <= STATE_SWEEP_SEEDS; seed++) {
      let states: unknown[];
      try {
        states = buildWalk(module, cfg, lineups, seed, STATE_SWEEP_EVENTS).states;
      } catch {
        continue; // a generator/apply refusal on this seed: it records nothing
      }
      for (const state of states) for (const path of statePathsOf(state, collapse)) out.add(path);
    }
  }
  cache.reachable = [...out].sort();
  return cache.reachable;
}

/** State paths the live modules can reach that no corpus can record, each
 *  against the reason. Same contract as UNREACHABLE_FIELDS: the reason IS the
 *  entry, and the hygiene tests red on a bare one, on a path the corpus has
 *  since started writing, and on a path the sweep can no longer reach at all
 *  (which makes the entry suppress nothing). */
export const UNREACHABLE_STATE_PATHS: Record<string, Record<string, string>> = {};

/** Live-reachable state paths the frozen corpus never writes, minus the
 *  allow-list. */
export function uncoveredStatePaths(module: AnySportModule, corpus: GoldenCorpus): string[] {
  const recorded = new Set(recordedStatePaths(module, corpus));
  const allowed = UNREACHABLE_STATE_PATHS[module.key] ?? {};
  return reachableStatePaths(module, corpus).filter(
    (path) => !recorded.has(path) && !Object.hasOwn(allowed, path),
  );
}

/** Allow-listed state paths the corpus DOES write — stale entries. */
export function staleUnreachableStatePaths(
  module: AnySportModule,
  corpus: GoldenCorpus,
): string[] {
  const recorded = new Set(recordedStatePaths(module, corpus));
  return Object.keys(UNREACHABLE_STATE_PATHS[module.key] ?? {})
    .filter((path) => recorded.has(path))
    .sort();
}

/** Allow-listed state paths the sweep can no longer reach — the field was
 *  renamed, removed, or the generator stopped producing it, so the entry now
 *  exempts nothing while still reading as a considered decision. */
export function unreachableStatePathsGoneStale(
  module: AnySportModule,
  corpus: GoldenCorpus,
): string[] {
  const reachable = new Set(reachableStatePaths(module, corpus));
  return Object.keys(UNREACHABLE_STATE_PATHS[module.key] ?? {})
    .filter((path) => !reachable.has(path))
    .sort();
}

/** Configs reached by no `variants` entry that own a fold path a tier type — or
 *  since W4a T10, an optional payload FIELD — needs. Cricket declares
 *  `superOver: false` everywhere, no variant enables it, so
 *  `cricket.superover.ball` was unreachable from any recorded config. A
 *  coverage config is always preferable to an UNREACHABLE_FIELDS line: it makes
 *  the field genuinely recorded rather than exempted. */
const COVERAGE_CONFIGS: Record<string, Record<string, unknown>> = {
  cricket: {
    superOver: { superOver: true, ballsPerInnings: 30, maxOversPerBowler: 5, minOversForResult: 1 },
  },
  // `generic.result.isDraw` is only emitted when draws are allowed AND the
  // result is not a score line — and the one shipped variant with
  // `allowDraws: true` is `score`, whose `resultMode: "score"` short-circuits
  // before the draw branches. Neither knob alone reaches it.
  generic: {
    drawable: {
      resultMode: "win_loss",
      allowDraws: true,
      points: { w: 3, d: 1, l: 0 },
      progressScore: false,
    },
  },
  // Hockey's `assists` default is `false` and none of fih-outdoor / fih-shootout
  // / youth overrides it, so `assists` on a hockey goal was unrecordable. Ice
  // hockey defaults it on, which is why only one of the two period sports
  // needed this.
  hockey: { assisted: { assists: true } },
};

/** T2 (#425 follow-up) — configs whose only job is to SET the optional knobs no
 *  shipped variant sets, so `uncoveredConfigFields` has something to pin them
 *  with. Each one is a plausible competition rather than a schema exercise, but
 *  it is a coverage instrument and not a preset: nothing outside this harness
 *  reads it.
 *
 *  `periodSeconds` is deliberately NON-uniform in each. A map giving every
 *  phase of a group the same value states nothing `periods.minutes` /
 *  `halfMinutes` does not, and `phaseLengths` IGNORES it in that case, so a
 *  uniform map would pin the key while exercising none of its behaviour. */
const COVERAGE_CONFIG_KNOBS: Record<string, Record<string, unknown>> = {
  // Law 3 as an FA youth competition writes it down: a squad cap, a window cap,
  // returns permitted, a declared sin-bin length, and a second half played
  // longer than the first (the one thing `halfMinutes` cannot say).
  football: {
    lawful: {
      teamSize: 11,
      maxSubs: 5,
      subWindows: 3,
      rollingSubs: true,
      sinBinMinutes: 10,
      periodSeconds: { H1: 2700, H2: 2820 },
    },
  },
  // ICC playing conditions declare a per-innings DRS allowance; no shipped
  // variant does, so `reviews` was pinned by nothing. The generator already
  // respects the allowance, so a stream under it stays valid.
  cricket: { reviewed: { reviews: { perInnings: 2 } } },
  // A Fischer-with-delay time control ("G/5 +3 d2"). `increment` and `delay`
  // are independent knobs and a control may declare both.
  boardgame: { timed: { clock: { base: 300, increment: 3, delay: 2 } } },
  // A competition that declares break allowances at all — none of the shipped
  // variants does, which is why `overran` and `overCount` had never been
  // computed by any fold. The generator's break is 120s long, so a 60s
  // allowance overruns it and a count of 1 puts the side's second break of a
  // kind in a set over the count.
  tennis: {
    breaks: {
      interruptions: {
        medical: { count: 1, seconds: 60 },
        heat: { count: 1, seconds: 60 },
        toilet: { count: 1, seconds: 60 },
        other: { count: 1, seconds: 60 },
      },
    },
  },
  // IIHF with the full points ladder, a pulled-goaltender-legal lineup, an
  // 8-second shoot-out clock and a third period played longer.
  icehockey: {
    "iihf-detail": {
      goalkeeper: "optional",
      periodSeconds: { P1: 1200, P2: 1200, P3: 1260 },
      points: { win: 3, draw: 1, loss: 0, otWin: 2, otLoss: 1, shootoutWin: 2, shootoutLoss: 1 },
      shootout: { attempts: 5, suddenDeath: true, clockSeconds: 8 },
    },
  },
  // FIH with sudden-death extra time played short-sided, a PIM column on the
  // card ladder, and every class stating explicitly that a goal does NOT end
  // it (FIH cards run to time, unlike an IIHF minor). The class KEYS must stay
  // green/yellow/red — the generator picks from them.
  hockey: {
    "fih-detail": {
      goalkeeper: "optional",
      periodSeconds: { Q1: 900, Q2: 900, Q3: 900, Q4: 960 },
      overtime: { kind: "sudden_death", minutes: 10, skaters: 7 },
      points: { win: 3, draw: 1, loss: 0, otWin: 2, otLoss: 1 },
      suspensions: {
        classes: {
          green: { minutes: 2, teamShort: true, pim: 2, releaseOnGoal: false },
          yellow: { minutes: 5, teamShort: true, pim: 5, releaseOnGoal: false },
          red: { minutes: null, teamShort: true, permanent: true, pim: 10, releaseOnGoal: false },
        },
      },
    },
  },
};

/** Bench slots a coverage stream needs that the minimal catalog lineup has
 *  none of. Football cannot substitute without a bench, which is why
 *  `football.sub` — a PRE-W4 event type — was never once recorded. Changing
 *  `defaultLineupPair` instead would change `init` for all eleven corpora, so
 *  these lineups ride on the stream (`GoldenStream.lineups`). */
const COVERAGE_BENCH: Record<string, number> = { football: 7 };

function benchedLineups(module: AnySportModule, cfg: unknown): LineupPair | undefined {
  const size = COVERAGE_BENCH[module.key];
  if (size === undefined) return undefined;
  const base = defaultLineupPair(resolvePositions(module, cfg));
  const withBench = (lineup: LineupPair["home"]): LineupPair["home"] => ({
    ...lineup,
    slots: [
      ...lineup.slots,
      ...Array.from({ length: size }, (_, i) => ({
        personId: `${lineup.entrantId}-b${i + 1}`,
        slot: "bench" as const,
        orderNo: lineup.slots.length + i + 1,
      })),
    ],
  });
  return { home: withBench(base.home), away: withBench(base.away) };
}

/** Every config a coverage scan may draw on: the ones already recorded, plus
 *  the module's own variants and its COVERAGE_CONFIGS. MAX_CONFIGS caps the
 *  RECORDING pass, not this one — a corpus with four configs can still need a
 *  fifth to reach one event type. */
function coverageCandidates(module: AnySportModule, corpus: GoldenCorpus): [string, unknown][] {
  const out: [string, unknown][] = Object.entries(corpus.configs);
  const known = new Set(out.map(([name]) => name));
  for (const [name, raw] of [
    ...Object.entries(module.variants as Record<string, unknown>),
    ...Object.entries(COVERAGE_CONFIGS[module.key] ?? {}),
    ...Object.entries(COVERAGE_CONFIG_KNOBS[module.key] ?? {}),
  ]) {
    if (known.has(name)) continue;
    try {
      module.configSchema.parse(raw);
    } catch {
      continue;
    }
    known.add(name);
    out.push([name, raw]);
  }
  return out;
}

/** How far a coverage scan walks per config before giving up on a seed range. */
const COVERAGE_SEED_SCAN = 3000;
/** Coverage streams may run long — a super over is only reached after a tie. */
const COVERAGE_MAX_EVENTS = 120;

export interface CorpusExtension {
  corpus: GoldenCorpus;
  /** Coverage tokens the appended streams brought in, in the order they were
   *  covered. `type:<event type>` and `field:<dotted optional path>`. */
  gained: string[];
  /** Tokens no config-and-seed in range could reach. */
  stillMissing: string[];
  /** `config:seed` of every stream appended. */
  appended: string[];
}

/** Everything the corpus is short of: event types it never records, optional
 *  payload fields it never writes, optional config fields nothing pins, and
 *  state paths the live modules reach but no stream recorded. One namespace so
 *  the greedy pick below can trade them off against each other — a single
 *  appended stream routinely brings in a missing type and four missing fields
 *  at once, and a coverage config brings in its own knobs AND the state paths
 *  those knobs unlock (tennis `interruptions` pins thirteen cfg fields and
 *  reaches `overran` / `overCount` in the same stream). */
export function uncoveredCoverageTokens(module: AnySportModule, corpus: GoldenCorpus): string[] {
  return [
    ...uncoveredTierTypes(module, corpus).map((type) => `type:${type}`),
    ...uncoveredTierFields(module, corpus).map((path) => `field:${path}`),
    ...uncoveredConfigFields(module, corpus).map((path) => `cfg:${path}`),
    ...uncoveredStatePaths(module, corpus).map((path) => `state:${path}`),
  ].sort();
}

/** Appends the fewest streams that cover a module's uncovered coverage tokens.
 *  Greedy: at each pass take the stream that brings in the most still-missing
 *  tokens, so the corpus grows by a handful of streams rather than one per
 *  token. Existing streams are PRESERVED byte for byte — this only appends. */
export function extendCorpus(module: AnySportModule, existing: GoldenCorpus): CorpusExtension {
  const wanted = new Set(uncoveredCoverageTokens(module, existing));
  const corpus: GoldenCorpus = { ...existing, configs: { ...existing.configs }, streams: [...existing.streams] };
  const gained: string[] = [];
  const appended: string[] = [];
  if (wanted.size === 0) return { corpus, gained, stillMissing: [], appended };
  // Folding a candidate's states costs more than reading its events, so only
  // pay it when a `state:` token is actually outstanding.
  const wantsState = [...wanted].some((token) => token.startsWith("state:"));
  const hitsOf = (
    raw: unknown,
    events: readonly GoldenEvent[],
    states: readonly unknown[],
    collapse: ReadonlySet<string>,
  ): string[] =>
    coverageTokens(module, events, {
      rawConfig: raw,
      ...(wantsState ? { states, collapse } : {}),
    }).filter((token) => wanted.has(token));

  const candidates = coverageCandidates(module, existing);
  const used = new Set(existing.streams.map((s) => `${s.config}:${s.seed}`));

  while (wanted.size > 0) {
    let best: { name: string; raw: unknown; seed: number; hits: string[] } | null = null;
    for (const [name, raw] of candidates) {
      const cfg = module.configSchema.parse(raw);
      const lineups = benchedLineups(module, cfg) ?? defaultLineupPair(resolvePositions(module, cfg));
      const collapse = collapseKeysFor(lineups);
      for (let seed = 1; seed <= COVERAGE_SEED_SCAN; seed++) {
        if (used.has(`${name}:${seed}`)) continue;
        let events: EventEnvelope[];
        let states: unknown[];
        try {
          const walk = buildWalk(module, cfg, lineups, seed, COVERAGE_MAX_EVENTS);
          events = walk.events;
          states = walk.states;
        } catch {
          continue;
        }
        const hits = hitsOf(raw, events, states, collapse);
        if (hits.length === 0) continue;
        if (best === null || hits.length > best.hits.length) best = { name, raw, seed, hits };
        if (best.hits.length === wanted.size) break;
      }
      if (best !== null && best.hits.length === wanted.size) break;
    }
    if (best === null) break;

    const cfg = module.configSchema.parse(best.raw);
    const lineups = benchedLineups(module, cfg);
    const resolved = lineups ?? defaultLineupPair(resolvePositions(module, cfg));
    const events: GoldenEvent[] = buildStream(module, cfg, resolved, best.seed, COVERAGE_MAX_EVENTS).map(
      (e) => ({ type: e.type, payload: e.payload }),
    );
    corpus.configs[best.name] = best.raw;
    corpus.streams.push({
      config: best.name,
      seed: best.seed,
      ...(lineups === undefined ? {} : { lineups }),
      events,
      ...recomputeStream(module, best.raw, events, lineups),
    });
    used.add(`${best.name}:${best.seed}`);
    appended.push(`${best.name}:${best.seed}`);
    for (const type of best.hits) {
      wanted.delete(type);
      gained.push(type);
    }
  }

  return { corpus, gained, stillMissing: [...wanted], appended };
}

export function rebaselineCorpus(module: AnySportModule, existing: GoldenCorpus): GoldenCorpus {
  return {
    ...existing,
    streams: existing.streams.map((stream) => {
      const raw = existing.configs[stream.config];
      const fresh = recomputeStream(module, raw, stream.events, stream.lineups);
      const configKey = configStateKey(module, raw, stream.lineups);
      return {
        ...stream,
        ...fresh,
        states: fresh.states.map((state, i) =>
          keepRecordedConfig(state, stream.states[i] as string, configKey),
        ),
      };
    }),
  };
}

/** A re-folded state carrying the cfg the corpus ORIGINALLY recorded.
 *  `cfg` is compared as a subset precisely so an additive config knob cannot
 *  red a corpus it cannot affect; letting a re-baseline bake the new key in
 *  would quietly convert that tolerance into a frozen expectation, and would
 *  put an unrelated config change into the same diff as the fold change the
 *  re-baseline exists to show. Replacing a value leaves key order untouched. */
export function keepRecordedConfig(
  recomputed: string,
  recorded: string,
  configKey: string | null,
): string {
  if (configKey === null) return recomputed;
  // Splice the value in the SOURCE TEXT rather than merging parsed objects: a
  // `JSON.parse` round-trip reorders integer-like keys, so the state written
  // back would differ in key order from the live fold and the very next replay
  // would red on an ordering the re-baseline itself introduced.
  const fresh = jsonObjectMembers(recomputed);
  const old = jsonObjectMembers(recorded);
  if (fresh === null || old === null) return recomputed;
  const recordedConfig = old.find((member) => member.key === configKey);
  if (recordedConfig === undefined) return recomputed;
  if (!fresh.some((member) => member.key === configKey)) return recomputed;
  const spliced = fresh
    .map(
      (member) =>
        `${member.rawKey}:${member.key === configKey ? recordedConfig.rawValue : member.rawValue}`,
    )
    .join(",");
  return `{${spliced}}`;
}

export function readCorpus(key: string): GoldenCorpus {
  return JSON.parse(readFileSync(goldenPath(key), "utf8")) as GoldenCorpus;
}

export function writeCorpus(corpus: GoldenCorpus): void {
  writeFileSync(goldenPath(corpus.key), `${JSON.stringify(corpus, null, 0)}\n`);
}

// ------------------------------------------------ corpus-write policy (#429)
//
// The policy, in one sentence: a re-baseline is legitimate only when it is
// DELIBERATE, ISOLATED IN ITS OWN COMMIT, and REVIEWED AS A STATE DIFF. Never a
// side effect of another change; never `UPDATE_GOLDEN=1` reached for to clear a
// red. See GOLDEN-POLICY.md next to this file.
//
// The mechanism for the middle clause existed before this pass and enforced
// nothing: `REBASELINE_GOLDEN=1` would happily rewrite eleven corpora on top of
// a half-finished feature branch, and the resulting commit is then unreviewable
// — a reader cannot tell which state moved because the fold changed and which
// moved because the working tree was dirty. So the two writing modes now refuse
// to run unless every dirty path is a corpus file they are about to rewrite.
//
// Split pure from impure deliberately: `corpusWriteVerdict` takes a porcelain
// listing and returns a verdict, so the unit tests drive it with fixture
// listings instead of manufacturing dirty git state.

export interface WorkingTreeVerdict {
  ok: boolean;
  /** Dirty paths that are NOT one of the corpus files the run may rewrite. */
  offending: string[];
  /** Why, ready to print — names the offending paths when there are any. */
  reason: string;
}

/** One porcelain line -> the path(s) it dirties. Renames and copies name two.
 *  A line too short to carry `XY <path>` is returned verbatim as its own path:
 *  the guard fails closed on anything it cannot read, rather than skipping it. */
function porcelainPaths(line: string): string[] {
  if (line.trim() === "") return [];
  if (line.length < 4) return [line];
  const status = line.slice(0, 2);
  const rest = line.slice(3);
  const parts =
    (status.includes("R") || status.includes("C")) && rest.includes(" -> ")
      ? rest.split(" -> ")
      : [rest];
  return parts.map((part) =>
    part.startsWith(`"`) ? ((JSON.parse(part) as string) ?? part) : part,
  );
}

/** Whether a corpus-writing run (UPDATE_GOLDEN / REBASELINE_GOLDEN) may proceed.
 *
 *  @param porcelain lines of `git status --porcelain`, or `null` when the
 *    directory is not a git checkout. `null` FAILS CLOSED, and that is the
 *    point rather than an edge case: outside a checkout there is no diff to
 *    review, so the run cannot satisfy the policy it is being gated on.
 *  @param writablePaths repo-relative paths the run is about to rewrite —
 *    i.e. the corpus files, and nothing else. */
export function corpusWriteVerdict(
  porcelain: readonly string[] | null,
  writablePaths: readonly string[],
): WorkingTreeVerdict {
  if (porcelain === null) {
    return {
      ok: false,
      offending: [],
      reason:
        `refusing to rewrite the golden corpus: this is not a git checkout, so the ` +
        `re-baseline could not be reviewed as a state diff (#429). Run it inside the repo.`,
    };
  }
  const allowed = new Set(writablePaths);
  const offending = [...new Set(porcelain.flatMap(porcelainPaths))]
    .filter((path) => !allowed.has(path))
    .sort();
  if (offending.length === 0) {
    return { ok: true, offending: [], reason: "working tree holds only corpus changes" };
  }
  return {
    ok: false,
    offending,
    reason:
      `refusing to rewrite the golden corpus: the working tree has ${offending.length} ` +
      `change(s) outside the corpus, so the commit could not be a reviewable state diff ` +
      `(#429 — a re-baseline is deliberate, isolated in its own commit, and reviewed as a ` +
      `state diff). Commit or stash these first:\n  ${offending.join("\n  ")}`,
  };
}

/** The corpus files a write mode may rewrite, repo-relative, or `null` when
 *  this is not a git checkout. Derived from `SPORT_DIRS`, so a module added
 *  without a corpus cannot widen the allowance by accident. */
export function corpusWritablePaths(repoRoot: string): string[] {
  return [...new Set(Object.keys(SPORT_DIRS).map((key) => relative(repoRoot, goldenPath(key))))]
    .sort()
    .map((path) => path.split(sep).join("/"));
}

/** `git status --porcelain` for `cwd`, or `null` when it is not a checkout. */
export function gitPorcelain(cwd: string): string[] | null {
  try {
    return execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" })
      .split("\n")
      .filter((line) => line.trim() !== "");
  } catch {
    return null;
  }
}

/** The repository root containing this file, or `null` when there is none. */
export function gitRepoRoot(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** The verdict for THIS checkout — the impure half, wired for the harness. */
export function corpusWriteGuard(): WorkingTreeVerdict {
  const root = gitRepoRoot(HERE);
  if (root === null) return corpusWriteVerdict(null, []);
  return corpusWriteVerdict(gitPorcelain(HERE), corpusWritablePaths(root));
}

// ------------------------------------------- re-baseline state-diff summary
//
// The third clause of the policy — "reviewed as a state diff" — was prose with
// nothing behind it: the run wrote eleven files and said nothing about what
// moved, leaving a reviewer to eyeball a minified 1.6 MB JSON line. This
// summarises the move instead, and it is a RETURNED VALUE first and a printout
// second so it can be asserted on without running a re-baseline.

export interface StreamStateDiff {
  /** Index into `corpus.streams`. */
  index: number;
  config: string;
  seed: number;
  /** Indices into `stream.states` whose recorded JSON moved. */
  changedSteps: number[];
  /** Distinct TOP-LEVEL state keys that moved, across this stream's steps. */
  changedStateKeys: string[];
  outcomeMoved: boolean;
  summaryMoved: boolean;
  deltasMoved: boolean;
  /** Must always be false — a re-baseline keeps the recorded ledger. */
  eventsMoved: boolean;
}

export interface CorpusStateDiff {
  key: string;
  /** Only the streams that actually moved. */
  streams: StreamStateDiff[];
  changedStreams: number;
  changedStates: number;
  /** Distinct top-level state keys that moved anywhere in the corpus. */
  changedStateKeys: string[];
  /** True if any recorded event moved, or the stream count did. Always a bug. */
  eventsMoved: boolean;
}

/** Sentinel key for a state that is not a JSON object, so a diff of one is
 *  reported rather than silently contributing no key at all. */
const OPAQUE_STATE_KEY = "(state is not a JSON object)";

/** Top-level keys whose recorded value text differs between two states. */
function changedTopLevelKeys(before: string, after: string): string[] {
  const a = jsonObjectMembers(before);
  const b = jsonObjectMembers(after);
  if (a === null || b === null) return [OPAQUE_STATE_KEY];
  const byKey = (members: JsonMember[]) => new Map(members.map((m) => [m.key, m.rawValue]));
  const left = byKey(a);
  const right = byKey(b);
  const keys = new Set([...left.keys(), ...right.keys()]);
  return [...keys].filter((key) => left.get(key) !== right.get(key)).sort();
}

/** What a re-baseline moved, per module and per stream. */
export function corpusStateDiff(before: GoldenCorpus, after: GoldenCorpus): CorpusStateDiff {
  const streams: StreamStateDiff[] = [];
  let eventsMoved = after.streams.length !== before.streams.length;
  const allKeys = new Set<string>();
  let changedStates = 0;

  const shared = Math.min(before.streams.length, after.streams.length);
  for (let i = 0; i < shared; i++) {
    const was = before.streams[i] as GoldenStream;
    const now = after.streams[i] as GoldenStream;
    const changedSteps: number[] = [];
    const keys = new Set<string>();
    const steps = Math.max(was.states.length, now.states.length);
    for (let step = 0; step < steps; step++) {
      const oldState = was.states[step];
      const newState = now.states[step];
      if (oldState === newState) continue;
      changedSteps.push(step);
      for (const key of changedTopLevelKeys(oldState ?? "", newState ?? "")) keys.add(key);
    }
    const streamEventsMoved = JSON.stringify(was.events) !== JSON.stringify(now.events);
    if (streamEventsMoved) eventsMoved = true;
    const diff: StreamStateDiff = {
      index: i,
      config: now.config,
      seed: now.seed,
      changedSteps,
      changedStateKeys: [...keys].sort(),
      outcomeMoved: was.outcome !== now.outcome,
      summaryMoved: was.summary !== now.summary,
      deltasMoved: was.deltas !== now.deltas,
      eventsMoved: streamEventsMoved,
    };
    if (
      changedSteps.length > 0 ||
      diff.outcomeMoved ||
      diff.summaryMoved ||
      diff.deltasMoved ||
      streamEventsMoved
    ) {
      streams.push(diff);
      changedStates += changedSteps.length;
      for (const key of keys) allKeys.add(key);
    }
  }

  return {
    key: after.key,
    streams,
    changedStreams: streams.length,
    changedStates,
    changedStateKeys: [...allKeys].sort(),
    eventsMoved,
  };
}

/** The summary a reviewer reads. One line per moved stream; the distinct set of
 *  moved state keys last, because that is the minimality claim. */
export function formatCorpusStateDiff(diff: CorpusStateDiff): string {
  if (diff.streams.length === 0 && !diff.eventsMoved) {
    return `[rebaseline] ${diff.key}: nothing moved`;
  }
  const lines = [
    `[rebaseline] ${diff.key}: ${diff.changedStreams} stream(s), ` +
      `${diff.changedStates} state(s) moved`,
  ];
  for (const stream of diff.streams) {
    const moved = [
      stream.outcomeMoved ? "outcome" : null,
      stream.summaryMoved ? "summary" : null,
      stream.deltasMoved ? "deltas" : null,
      stream.eventsMoved ? "EVENTS(!)" : null,
    ].filter((part) => part !== null);
    lines.push(
      `  #${stream.index} config=${stream.config} seed=${stream.seed} ` +
        `steps=[${stream.changedSteps.join(",")}] ` +
        `keys=[${stream.changedStateKeys.join(",")}]` +
        (moved.length > 0 ? ` moved=${moved.join("+")}` : ""),
    );
  }
  lines.push(`  state keys moved: ${diff.changedStateKeys.join(", ") || "(none)"}`);
  if (diff.eventsMoved) {
    lines.push(`  !! RECORDED EVENTS MOVED — this is not a re-baseline, it is a re-record`);
  }
  return lines.join("\n");
}

// ------------------------------------------------------------- comparison
//
// W4 (#407) — the recorded state carries the module's parsed `cfg` inside it,
// so comparing the two JSON strings byte-for-byte made the harness reject a
// change it exists to bless: adding an OPTIONAL config knob with a zod
// `.default()` shifts the resolved cfg and would red every stream for that
// module, though it cannot change a single fold. That once pushed the period
// family into a compile-time preset field instead of a config field; with the
// subset rule below in place the workaround was unwound, and the set-piece
// kinds are `cfg.setPieceKinds` again (W4 review item 4).
//
// So `cfg` is compared as a SUBSET: every key the golden recorded must still be
// present with an identical value, while new keys are allowed. Everything else
// — key order included — stays exact string equality, because that is the fold
// itself.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ------------------------------------------------ JSON source-text splitting
//
// #429 scope item 4. `JSON.parse` DOES NOT PRESERVE KEY ORDER: a JS object puts
// array-index-like own keys first, in ascending numeric order, whatever order
// they appeared in the text. So a state recorded as `{"2":…,"1":…}` parses to
// `{"1":…,"2":…}`, and any comparison that parses BOTH sides and re-serialises
// them normalises the two identically — a genuine order change between the
// recorded and replayed state comes out equal. That is a false GREEN on the
// exact-equality half of the golden comparison, which is the half that carries
// the whole fold.
//
// No corpus has an integer-like state key today. That is the reason to fix it
// now rather than a reason not to: cricket keys innings by `r1`/`r2` and
// several modules key maps by entrant id, so one module numbering a map by
// period, over or board number is all it takes, and the failure mode is a gate
// that reports success.
//
// The fix is to drop the round-trip, not to sort after it: sorting picks A
// canonical order, and the comparison needs THE RECORDED one.

export interface JsonMember {
  /** The key's exact source text, quotes and escapes included. */
  rawKey: string;
  /** The decoded key. */
  key: string;
  /** The value's exact source text. */
  rawValue: string;
}

/** Top-level members of a JSON object's SOURCE TEXT, in serialised order, each
 *  value kept as its exact bytes. `null` when the text is not a JSON object.
 *  Nested values are never parsed — they stay opaque strings, which is exactly
 *  what an exact comparison of the non-config half of a state wants. */
export function jsonObjectMembers(json: string): JsonMember[] | null {
  let i = 0;
  const skipWs = (): void => {
    while (i < json.length && " \t\n\r".includes(json[i] as string)) i++;
  };
  const skipString = (): boolean => {
    if (json[i] !== `"`) return false;
    i++;
    while (i < json.length) {
      const ch = json[i] as string;
      if (ch === "\\") i += 2;
      else if (ch === `"`) {
        i++;
        return true;
      } else i++;
    }
    return false;
  };
  const skipValue = (): boolean => {
    const ch = json[i];
    if (ch === `"`) return skipString();
    if (ch === "{" || ch === "[") {
      let depth = 0;
      while (i < json.length) {
        const cur = json[i] as string;
        if (cur === `"`) {
          if (!skipString()) return false;
          continue;
        }
        if (cur === "{" || cur === "[") depth++;
        else if (cur === "}" || cur === "]") {
          depth--;
          i++;
          if (depth === 0) return true;
          continue;
        }
        i++;
      }
      return false;
    }
    // A scalar: number, true, false or null. Runs to the next structural char.
    const start = i;
    while (i < json.length && !",}]".includes(json[i] as string)) i++;
    return i > start;
  };

  skipWs();
  if (json[i] !== "{") return null;
  i++;
  const out: JsonMember[] = [];
  skipWs();
  if (json[i] === "}") {
    i++;
    skipWs();
    return i === json.length ? out : null;
  }
  for (;;) {
    skipWs();
    const keyStart = i;
    if (!skipString()) return null;
    const rawKey = json.slice(keyStart, i);
    skipWs();
    if (json[i] !== ":") return null;
    i++;
    skipWs();
    const valueStart = i;
    if (!skipValue()) return null;
    let key: string;
    try {
      key = JSON.parse(rawKey) as string;
    } catch {
      return null;
    }
    out.push({ rawKey, key, rawValue: json.slice(valueStart, i) });
    skipWs();
    if (json[i] === ",") {
      i++;
      continue;
    }
    if (json[i] === "}") {
      i++;
      skipWs();
      return i === json.length ? out : null;
    }
    return null;
  }
}

/** First path at which `expected` is not reproduced by `actual`, or null.
 *  Objects are subsets (extra keys in `actual` are fine); arrays must match
 *  element for element; leaves must be identical. */
function subsetMismatch(actual: unknown, expected: unknown, path: string): string | null {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path}: expected an array, got ${JSON.stringify(actual)}`;
    if (actual.length !== expected.length) {
      return `${path}: expected ${expected.length} entries, got ${actual.length}`;
    }
    for (let i = 0; i < expected.length; i++) {
      const hit = subsetMismatch(actual[i], expected[i], `${path}[${i}]`);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return `${path}: expected an object, got ${JSON.stringify(actual)}`;
    for (const [key, value] of Object.entries(expected)) {
      if (!Object.hasOwn(actual, key)) return `${path}.${key}: recorded key is gone`;
      const hit = subsetMismatch(actual[key], value, `${path}.${key}`);
      if (hit !== null) return hit;
    }
    return null;
  }
  return Object.is(actual, expected)
    ? null
    : `${path}: recorded ${JSON.stringify(expected)}, replayed ${JSON.stringify(actual)}`;
}

/** Everything but the module's config, kept as the exact bytes the corpus
 *  recorded and in the order it recorded them — so the non-config half of the
 *  state stays a genuine string comparison.
 *
 *  This used to take the PARSED state and re-serialise it, which quietly made
 *  the comparison order-INSENSITIVE for integer-like keys (see the
 *  `jsonObjectMembers` note): both sides went through the same normalisation,
 *  so a real order change compared equal. Splitting the source text keeps the
 *  recorded bytes, which is what "exact" was always supposed to mean. */
function withoutConfig(members: readonly JsonMember[], configKey: string): string {
  return members
    .map(
      (member) =>
        `${member.rawKey}:${member.key === configKey ? CONFIG_PLACEHOLDER : member.rawValue}`,
    )
    .join(",");
}

/** Stands in for the config's VALUE so its POSITION in key order still compares.
 *  Dropping the entry entirely would let a module move its config from the first
 *  key to the last with the non-config half reported identical. */
const CONFIG_PLACEHOLDER = "<config compared as a subset>";

/** The top-level state key a module embeds its parsed config under.
 *
 *  #429 scope item 4: NOT a name match. `stateMismatch` used to give the subset
 *  tolerance to whatever was literally called `cfg`, which is wrong in both
 *  directions — a module storing its config as `settings` silently loses the
 *  tolerance (so an additive knob reds its corpus, the exact failure the subset
 *  rule exists to prevent), and the rule stops being about the config at all
 *  and becomes about a spelling. The config's location is a fact about the
 *  module, so ask the module: `init` is handed the parsed cfg, and the state
 *  entry that IS that object is where it lives. Identity first, serialised
 *  equality as the fallback for a module that copies rather than stores.
 *
 *  `null` means the module embeds no config in its state, and then the whole
 *  state is compared exactly — there is nothing to be tolerant about. */
export function configStateKey(
  module: AnySportModule,
  rawConfig: unknown,
  recordedLineups?: LineupPair,
): string | null {
  let cfg: unknown;
  let state: unknown;
  try {
    cfg = module.configSchema.parse(rawConfig);
    state = module.init(cfg, recordedLineups ?? defaultLineupPair(resolvePositions(module, cfg)));
  } catch {
    // A module that cannot be initialised has no locatable config. Falling back
    // to "cfg" here would let the name match in through the back door.
    return null;
  }
  if (!isPlainObject(state)) return null;
  // Identity: `init` was handed this exact object, and every builtin files it
  // straight into the state it returns.
  const stored = Object.entries(state).find(([, value]) => value === cfg);
  if (stored !== undefined) return stored[0];
  // Fallback for a module that copies its config in. TOP-LEVEL ONLY, always: a
  // nested object that happens to be spelled `cfg` is part of the fold, and
  // handing it the subset tolerance would blind the corpus to a real change.
  const target = JSON.stringify(cfg);
  const copied = Object.entries(state).find(
    ([, value]) => isPlainObject(value) && JSON.stringify(value) === target,
  );
  return copied?.[0] ?? null;
}

/** Why a replayed state differs from the recorded one, or null if it does not.
 *  Exact everywhere except the module's embedded config, which is compared as a
 *  subset (see the note above). `configKey` says where that config lives —
 *  `configStateKey` derives it from the module; `null` means the state carries
 *  no config and every byte is exact. */
export function stateMismatch(
  actual: string,
  expected: string,
  configKey: string | null,
): string | null {
  if (actual === expected) return null;

  try {
    JSON.parse(actual);
    JSON.parse(expected);
  } catch {
    return `state is not JSON: recorded ${expected}, replayed ${actual}`;
  }
  // No embedded config means no tolerance to apply: the state is a plain fold
  // and must reproduce byte for byte.
  if (configKey === null) return `recorded ${expected}, replayed ${actual}`;

  const actualMembers = jsonObjectMembers(actual);
  const expectedMembers = jsonObjectMembers(expected);
  if (actualMembers === null || expectedMembers === null) {
    return `recorded ${expected}, replayed ${actual}`;
  }
  const expectedConfig = expectedMembers.find((member) => member.key === configKey);
  const actualConfig = actualMembers.find((member) => member.key === configKey);
  // Only a state that RECORDED a config gets the subset rule; a module gaining
  // or losing one in its state IS a fold change and must red either way.
  if (expectedConfig === undefined) return `recorded ${expected}, replayed ${actual}`;
  if (actualConfig === undefined) return `${configKey}: recorded key is gone`;

  const rest = withoutConfig(actualMembers, configKey);
  const expectedRest = withoutConfig(expectedMembers, configKey);
  if (rest !== expectedRest) {
    return `state outside ${configKey}: recorded ${expectedRest}, replayed ${rest}`;
  }

  let actualConfigValue: unknown;
  let expectedConfigValue: unknown;
  try {
    actualConfigValue = JSON.parse(actualConfig.rawValue);
    expectedConfigValue = JSON.parse(expectedConfig.rawValue);
  } catch {
    return `state is not JSON: recorded ${expected}, replayed ${actual}`;
  }
  return subsetMismatch(actualConfigValue, expectedConfigValue, configKey);
}

// ------------------------------------------------- additive-only tripwire
//
// W4 review item 2. The tripwire used to re-parse each recorded payload
// against the whole permissive `module.eventSchema`, which is a `z.union` of
// branches that carry no discriminator — the ENVELOPE's `type` string is the
// discriminator, and `apply` is where it is read. So a union parse succeeds
// whenever ANY sibling branch happens to accept the payload, and a branch can
// be tightened with the tripwire none the wiser: adding a required field to
// `PeriodSuspensionEnd` left this green for hockey AND icehockey, because
// `PeriodSuspensionStart` accepts the same `{by, person, class}` shape.
//
// So ask `apply` instead. Every module parses the selected branch through its
// own `parsePayload`, which throws INVALID_EVENT with the message
// `invalid <type> payload` and the zod issues attached — a signature no other
// refusal on the path produces. Anything else the fold throws (WRONG_PHASE, a
// lineup rejection, a domain refusal) means the payload parsed and the replay
// test owns the difference.

export interface PayloadParseFailure {
  index: number;
  type: string;
  issues: unknown;
}

/** Recorded payloads that no longer parse against the branch `apply` selects
 *  for their event type. Stops at the first event the fold cannot get past:
 *  after that the states diverge and every later verdict is about a different
 *  match, not about a schema. */
export function payloadParseFailures(
  module: AnySportModule,
  rawConfig: unknown,
  events: readonly GoldenEvent[],
  recordedLineups?: LineupPair,
): PayloadParseFailure[] {
  const cfg = module.configSchema.parse(rawConfig);
  const lineups = recordedLineups ?? defaultLineupPair(resolvePositions(module, cfg));
  const envelopes: EventEnvelope[] = events.map((event, i) => makeEnvelope(i, event));
  const out: PayloadParseFailure[] = [];

  for (let i = 0; i < envelopes.length; i++) {
    const type = (envelopes[i] as EventEnvelope).type;
    try {
      foldMatch(module, cfg, lineups, envelopes.slice(0, i + 1), STRICT_ALL);
    } catch (error) {
      if (EngineError.is(error, "INVALID_EVENT") && error.message === `invalid ${type} payload`) {
        out.push({ index: i, type, issues: (error.data as { issues?: unknown })?.issues });
      }
      return out;
    }
  }
  return out;
}

/** Every non-core payload in the corpus, for the additive-only tripwire. */
export function sportPayloads(corpus: GoldenCorpus): { type: string; payload: unknown }[] {
  return corpus.streams
    .flatMap((stream) => stream.events)
    .filter((event) => !isCoreEventType(event.type) && !event.type.startsWith("core."));
}

/** Distinct event-type literals the corpus exercises (core.* included). */
export function eventTypesIn(corpus: GoldenCorpus): string[] {
  return [...new Set(corpus.streams.flatMap((s) => s.events.map((e) => e.type)))].sort();
}
