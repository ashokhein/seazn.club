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
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EngineError } from "../core/errors.ts";
import { foldMatch, isCoreEventType, type EventEnvelope } from "../core/events.ts";
import type { LineupPair, StageCtx } from "../core/types.ts";
import { resolvePositions } from "../sport/catalog.ts";
import type { AnySportModule } from "../sport/module.ts";
import { buildStream, defaultLineupPair, makeEnvelope } from "./helpers.ts";
import { fieldPresent, optionalFieldPaths } from "./schema-fields.ts";

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

/** What a stream contributes to coverage: the event types it records AND the
 *  declared optional fields it writes, in one tagged namespace so `extendCorpus`
 *  can go on picking the stream that brings in the most of what is missing. */
export function coverageTokens(
  module: AnySportModule,
  events: readonly GoldenEvent[],
): string[] {
  const out = new Set<string>();
  for (const event of events) out.add(`type:${event.type}`);
  for (const path of writtenFields(module, events)) out.add(`field:${path}`);
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

/** Everything the corpus is short of: event types it never records AND optional
 *  payload fields it never writes. One namespace so the greedy pick below can
 *  trade the two off against each other — a single appended stream routinely
 *  brings in a missing type and four missing fields at once. */
export function uncoveredCoverageTokens(module: AnySportModule, corpus: GoldenCorpus): string[] {
  return [
    ...uncoveredTierTypes(module, corpus).map((type) => `type:${type}`),
    ...uncoveredTierFields(module, corpus).map((path) => `field:${path}`),
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
  const hitsOf = (events: readonly GoldenEvent[]): string[] =>
    coverageTokens(module, events).filter((token) => wanted.has(token));

  const candidates = coverageCandidates(module, existing);
  const used = new Set(existing.streams.map((s) => `${s.config}:${s.seed}`));

  while (wanted.size > 0) {
    let best: { name: string; raw: unknown; seed: number; hits: string[] } | null = null;
    for (const [name, raw] of candidates) {
      const cfg = module.configSchema.parse(raw);
      const lineups = benchedLineups(module, cfg) ?? defaultLineupPair(resolvePositions(module, cfg));
      for (let seed = 1; seed <= COVERAGE_SEED_SCAN; seed++) {
        if (used.has(`${name}:${seed}`)) continue;
        let events: EventEnvelope[];
        try {
          events = buildStream(module, cfg, lineups, seed, COVERAGE_MAX_EVENTS);
        } catch {
          continue;
        }
        const hits = hitsOf(events);
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
      const fresh = recomputeStream(
        module,
        existing.configs[stream.config],
        stream.events,
        stream.lineups,
      );
      return {
        ...stream,
        ...fresh,
        states: fresh.states.map((state, i) => keepRecordedCfg(state, stream.states[i] as string)),
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
function keepRecordedCfg(recomputed: string, recorded: string): string {
  let fresh: unknown;
  let old: unknown;
  try {
    fresh = JSON.parse(recomputed);
    old = JSON.parse(recorded);
  } catch {
    return recomputed;
  }
  if (!isPlainObject(fresh) || !isPlainObject(old)) return recomputed;
  if (!Object.hasOwn(fresh, "cfg") || !Object.hasOwn(old, "cfg")) return recomputed;
  return JSON.stringify({ ...fresh, cfg: old.cfg });
}

export function readCorpus(key: string): GoldenCorpus {
  return JSON.parse(readFileSync(goldenPath(key), "utf8")) as GoldenCorpus;
}

export function writeCorpus(corpus: GoldenCorpus): void {
  writeFileSync(goldenPath(corpus.key), `${JSON.stringify(corpus, null, 0)}\n`);
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

/** Everything but `cfg`, re-serialised in the order it was parsed — so the
 *  non-config half of the state stays an exact string comparison. */
function withoutCfg(state: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(state).filter(([k]) => k !== "cfg")));
}

/** Why a replayed state differs from the recorded one, or null if it does not.
 *  Exact everywhere except `cfg`, which is a subset (see the note above). */
export function stateMismatch(actual: string, expected: string): string | null {
  if (actual === expected) return null;

  let parsedActual: unknown;
  let parsedExpected: unknown;
  try {
    parsedActual = JSON.parse(actual);
    parsedExpected = JSON.parse(expected);
  } catch {
    return `state is not JSON: recorded ${expected}, replayed ${actual}`;
  }
  // Only a state that RECORDED a cfg gets the subset rule; anything else is a
  // plain fold and must reproduce byte for byte.
  if (
    !isPlainObject(parsedActual) ||
    !isPlainObject(parsedExpected) ||
    !Object.hasOwn(parsedExpected, "cfg")
  ) {
    return `recorded ${expected}, replayed ${actual}`;
  }

  const rest = withoutCfg(parsedActual);
  const expectedRest = withoutCfg(parsedExpected);
  if (rest !== expectedRest) return `state outside cfg: recorded ${expectedRest}, replayed ${rest}`;

  return subsetMismatch(parsedActual.cfg, parsedExpected.cfg, "cfg");
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
