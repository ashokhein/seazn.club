import "server-only";
// Stage-1 of the AI schedule pipeline (#398): the organiser's free text becomes
// typed constraints the referee can actually check.
//
// Two rules govern this file.
//
// 1. THE MODEL NEVER RESOLVES A DATE. It emits symbolic references —
//    {kind:'tomorrow'}, {kind:'weekday',weekday:'FRI'} — and `resolveParsed`
//    below turns them into real days against W2's Clock. Quiet off-by-one
//    calendar arithmetic is exactly the class of error that survives review, and
//    a date word that reaches the architect prompt uncompiled means this whole
//    wave failed regardless of what the tests say.
//
// 2. WORDING NOBODY CAN COMPILE IS NEVER INVENTED INTO A RULE. It goes verbatim
//    into `unparsed` and is shown to a human. Presenting a rule as enforced
//    while nothing enforces it is worse than having no rule.
//
// Credits: this round runs OUTSIDE `spendCredit`, as free pre-flight, on its own
// small meter (design §5.1). A credit buys a token BUDGET, not a number of
// rounds, so extra LLM rounds must never mint credits — and the confirm step W5
// adds is only genuinely free to walk away from if this round is unpriced.
import { z } from "zod";
import { ymdAddDays, zonedTimeToUtc, type Clock, type HardConstraint } from "@seazn/engine/scheduling";
import { createTokenMeter } from "@/lib/ai-rung";
import { resolveProvider } from "@/server/ai/select-provider";
import type { AiProvider, AiTurn } from "@/server/ai/provider";

// ---------------------------------------------------------------------------
// The symbolic schema the model answers in
// ---------------------------------------------------------------------------

const Weekday = z.enum(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);

/** The model's ONLY way to talk about a date. It has no calendar and the prompt
 *  says so; `resolveParsed` is what owns the arithmetic. */
const DateRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("today") }),
  z.object({ kind: z.literal("tomorrow") }),
  z.object({ kind: z.literal("weekday"), weekday: Weekday }),
  z.object({ kind: z.literal("date"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
]);

/** Deliberately NARROWER than the engine's `ConstraintScope`, which also carries
 *  `entrant`, `person` and `pool`. Those bind fine when a durable config states
 *  them by id (the API path), but this parser is only ever handed division ids —
 *  so a model asked for an entrant scope has no choice but to invent an id, and
 *  an invented id matches no fixture. That is a rule the organiser is told was
 *  compiled while nothing enforces it, which rule 2 of this file forbids. A
 *  narrower instruction goes to `unparsed` and is shown to a human instead. */
const Scope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("competition") }),
  z.object({ kind: z.literal("division"), divisionId: z.string().min(1) }),
]);

/** No `round`, no `id`: the model addresses fixtures by terminal-ness or by an
 *  ext_key it was actually shown. Round numbers are display labels. */
const Selector = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("terminal") }),
  z.object({
    kind: z.literal("ext_key"),
    extKey: z.string().min(1),
    divisionId: z.string().min(1).optional(),
  }),
]);

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const RawHard = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("min_rest_minutes"),
    minutes: z.number().int().positive(),
    rest_scope: z.enum(["per_person", "feeder_to_dependent", "both"]),
    scope: Scope,
  }),
  z.object({ type: z.literal("max_fixtures_per_day"), count: z.number().int().positive(), scope: Scope }),
  z.object({ type: z.literal("fixture_on_weekday"), selector: Selector, weekday: Weekday, scope: Scope }),
  z.object({ type: z.literal("fixture_on_date"), selector: Selector, date: DateRef, scope: Scope }),
  z.object({ type: z.literal("not_before"), time: HHMM, scope: Scope }),
  z.object({ type: z.literal("not_after"), time: HHMM, scope: Scope }),
  /** Symbolic only, and the ONE member that never becomes a HardConstraint:
   *  `resolveParsed` turns it into the pack's calendar window, which the
   *  verifier already checks. */
  z.object({ type: z.literal("window"), start: DateRef, end: DateRef, scope: Scope }),
]);

export const RawParsed = z.object({
  hard: z.array(RawHard).default([]),
  soft: z
    .array(
      z.object({
        note: z.string(),
        weight: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      }),
    )
    .default([]),
  unparsed: z.array(z.string()).default([]),
});
export type RawParsed = z.infer<typeof RawParsed>;
export type RawHardConstraint = z.infer<typeof RawHard>;
export type DateRef = z.infer<typeof DateRef>;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const PARSER_PROMPT = `You compile a tournament organiser's free-text scheduling instruction into typed
constraints. You receive the instruction plus a small context: the id and name of
every division in this run, and nothing else. Answer with a JSON object matching
the schema below.

Schema:
{
  "hard": [
    { "type": "min_rest_minutes", "minutes": int, "rest_scope": "per_person"|"feeder_to_dependent"|"both", "scope": Scope },
    { "type": "max_fixtures_per_day", "count": int, "scope": Scope },
    { "type": "fixture_on_weekday", "selector": Selector, "weekday": "MON".."SUN", "scope": Scope },
    { "type": "fixture_on_date", "selector": Selector, "date": DateRef, "scope": Scope },
    { "type": "not_before" | "not_after", "time": "HH:mm", "scope": Scope },
    { "type": "window", "start": DateRef, "end": DateRef, "scope": Scope }
  ],
  "soft": [ { "note": string, "weight": 1|2|3 } ],
  "unparsed": [ string ]
}
Scope: {"kind":"competition"} | {"kind":"division","divisionId":id}
Selector: {"kind":"terminal"} | {"kind":"ext_key","extKey":key}
DateRef: {"kind":"today"} | {"kind":"tomorrow"} |
         {"kind":"weekday","weekday":"MON".."SUN"} | {"kind":"date","date":"YYYY-MM-DD"}

Rules:
1. NEVER resolve dates yourself. "tomorrow" stays {"kind":"tomorrow"}; "friday"
   stays {"kind":"weekday","weekday":"FRI"}. You have no calendar.
2. "at least N minutes" is a LOWER BOUND -> min_rest_minutes N. Only explicit
   "exactly" / "no more than" language means anything else.
3. When rest wording is ambiguous about whether it means between a player's own
   matches or between a match and the round it feeds (e.g. "gap for each player
   in the next round"), use rest_scope "both".
4. "the final" / "the grand final" -> selector {"kind":"terminal"}. If a division
   is named, scope to it; otherwise scope {"kind":"competition"} (= every
   division's terminal fixture). Never address a fixture by round number.
5. not_before / not_after take a wall-clock "HH:mm" only, never a date or an
   instant. A date range is a "window".
6. Preferences that are not checkable placement rules ("keep mornings relaxed")
   go to soft with a weight. Wording you cannot map at all goes VERBATIM into
   unparsed. Never invent a constraint that is not clearly stated.
7. Tolerate typos and broken grammar; compile the evident intent.
8. A scope is ONLY the whole competition or a division id you were given. There
   is no scope for one team, one player or one pool. In particular a PER-PLAYER
   cap ("no player plays more than 2 matches a day", "each team twice a day")
   is NOT max_fixtures_per_day, which counts the whole scope's fixtures on a
   day. Put per-player and per-team caps in unparsed VERBATIM. Only a cap on
   how many fixtures RUN in a day is max_fixtures_per_day.

Example A
instruction: "schedule two matches per day and hav a gap 45 mins at at least and
run a whole matches from tomorrow till Friday."
output:
{"hard":[
  {"type":"max_fixtures_per_day","count":2,"scope":{"kind":"competition"}},
  {"type":"min_rest_minutes","minutes":45,"rest_scope":"both","scope":{"kind":"competition"}},
  {"type":"window","start":{"kind":"tomorrow"},"end":{"kind":"weekday","weekday":"FRI"},"scope":{"kind":"competition"}}],
 "soft":[],"unparsed":[]}

Example B
instruction: "at least have 40 mins gap for each player in the next round and
schedule final on friday."
output:
{"hard":[
  {"type":"min_rest_minutes","minutes":40,"rest_scope":"both","scope":{"kind":"competition"}},
  {"type":"fixture_on_weekday","selector":{"kind":"terminal"},"weekday":"FRI","scope":{"kind":"competition"}}],
 "soft":[],"unparsed":[]}`;

const RETRY_SUFFIX =
  "Your previous answer did not match the schema. Return a corrected JSON object only.";

/** The pre-flight's own ceiling. A compiled instruction is a small JSON object —
 *  a few hundred output tokens — and this round is unpriced, so it gets a hard
 *  bound of its own rather than a share of the run's budget. */
export const PARSE_TOKEN_CEILING = 2_000;

/** Per-attempt cap. It must be STRICTLY under half the ceiling or the corrective
 *  retry is unreachable exactly when it is needed: a first attempt that missed
 *  the schema by truncating has spent the whole ceiling, `clampRound` returns 0,
 *  and the loop breaks before retrying. */
export const PARSE_TOKENS_PER_ATTEMPT = 1_000;

const PARSE_TIMEOUT_MS = 60_000;

/** Cheap and fast: the compile is a small extraction, and the referee checks
 *  every rule it produces regardless of which model produced it. */
export function parserAiModel(): string {
  return process.env.SCHEDULING_PARSE_MODEL ?? "claude-haiku-4-5-20251001";
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/** Everything the model is shown. Divisions ONLY, matching `Scope` — a context
 *  field the scope vocabulary cannot express is an invitation to invent ids. */
export interface ParserContext {
  divisions: { id: string; name: string }[];
}

export interface ParseOutcome {
  raw: RawParsed | null;
  /** True when nothing could be compiled. NOT an error: the run continues with
   *  no compiled rules, and the preview (W5, #400) offers "run it as a
   *  preference instead?". Silent fallback to a soft reading is refused. */
  failed: boolean;
  /** Output tokens this pre-flight spent, charged to its OWN meter and sitting
   *  outside `quote.budget`. It needs its own ledger line or the spend is
   *  invisible — the exact reconciliation complaint #387 makes. */
  tokens: number;
  servedModel: string | null;
}

/**
 * Compile `instruction` into symbolic constraints. One retry on a schema miss,
 * then a soft failure — never a throw. A parse problem must not take down a run
 * the organiser is paying for.
 */
export async function parseInstruction(
  instruction: string,
  ctx: ParserContext,
  opts: { provider?: AiProvider; model?: string } = {},
): Promise<ParseOutcome> {
  const model = opts.model ?? parserAiModel();
  // Resolve from the MODEL, not from the global AI_PROVIDER. `parserAiModel()`
  // returns a bare Anthropic id, and under AI_PROVIDER=openrouter a bare id is a
  // 404 that this function's own catch swallows — every run would silently
  // compile to no rules. Same slug test the model ladder uses (schedule-ai.ts).
  const provider = opts.provider ?? resolveProvider(model.includes("/") ? "openrouter" : "anthropic");
  const meter = createTokenMeter(PARSE_TOKEN_CEILING);

  // Refuse before the call, not inside it: an unconfigured provider is a 503 on
  // the paid path, but here it is simply "no compiled rules".
  if (!provider.isConfigured()) return { raw: null, failed: true, tokens: 0, servedModel: null };

  const messages: AiTurn[] = [{ role: "user", content: JSON.stringify({ instruction, context: ctx }) }];
  let servedModel: string | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const maxTokens = meter.clampRound(PARSE_TOKENS_PER_ATTEMPT);
    if (maxTokens <= 0) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PARSE_TIMEOUT_MS);
    try {
      const res = await provider.chat({
        model,
        system: PARSER_PROMPT,
        messages,
        maxTokens,
        // No thinking: this is an extraction, and the ceiling is 1K.
        reasoning: { kind: "none" },
        schema: { name: "instruction_constraints", zod: RawParsed },
        signal: controller.signal,
        timeoutMs: PARSE_TIMEOUT_MS,
      });
      if (res === null) continue;
      // Meter on EVERY path, hit or miss — an un-metered round is a budget leak,
      // and this meter is the only ceiling the pre-flight has.
      meter.add(res.usage.outputTokens);
      servedModel = res.servedModel;
      // A refusal is not a schema miss: it fails fast and spends no retry.
      if (res.refused) break;
      if (res.parsed !== null) return { raw: res.parsed, failed: false, tokens: meter.spent, servedModel };
      // Schema miss. Hand the retry the answer it got wrong, as a real turn:
      // RETRY_SUFFIX says "your previous answer", and with the correction only
      // in the system prompt there is no previous answer to refer to.
      messages.push(res.assistantTurn, { role: "user", content: RETRY_SUFFIX });
    } catch {
      // Transport, timeout, provider outage. Best-effort pre-flight: give up
      // quietly and let the architect run proceed without compiled rules.
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  return { raw: null, failed: true, tokens: meter.spent, servedModel };
}

// ---------------------------------------------------------------------------
// Deterministic resolution — everything the model is bad at
// ---------------------------------------------------------------------------

export interface ResolvedParse {
  hard: HardConstraint[];
  soft: RawParsed["soft"];
  unparsed: string[];
  /** Every interpretive choice made here, in the organiser's language. The
   *  organiser should SEE the reading we picked rather than suffer it. */
  assumptions: string[];
  /** The window the instruction stated, as epoch ms, or null when it stated
   *  none. Epoch ms rather than ISO on purpose: the pack builder owns window
   *  RENDERING (it writes zoned offsets, not "Z"), and two renderers would
   *  drift. `to` is the last whole second of the final day, matching what
   *  `windowBounds` expects. */
  windowMs: { from: number; to: number } | null;
}

const resolveDateRef = (ref: DateRef, clock: Clock): string =>
  ref.kind === "today"
    ? clock.today
    : ref.kind === "tomorrow"
      ? clock.tomorrow
      : ref.kind === "weekday"
        ? clock.nextWeekday[ref.weekday]
        : ref.date;

const MS_PER_DAY = 86_400_000;

/**
 * Symbolic parse → concrete constraints plus the pack's calendar window.
 *
 * `raw === null` is a first-class input, not an error path: there was no
 * instruction, or the compile failed. The default window stands, no rules are
 * compiled, and nothing is assumed on the organiser's behalf.
 */
export function resolveParsed(
  raw: RawParsed | null,
  clock: Clock,
  tz: string,
  hints: { fixtureCount?: number } = {},
): ResolvedParse {
  const assumptions: string[] = [];
  const hard: HardConstraint[] = [];
  if (raw === null) {
    return { hard, soft: [], unparsed: [], assumptions, windowMs: null };
  }

  let windowMs: { from: number; to: number } | null = null;
  let ymd: { start: string; end: string } | null = null;

  // The end is the last whole SECOND of the final day — the shape W2's pack
  // builder emits and the form `windowBounds` expects. Built from wall-clock day
  // boundaries in ONE zone, never by adding 86_400_000, because a DST day is 23
  // or 25 hours long.
  const setWindow = (start: string, end: string): void => {
    ymd = { start, end };
    windowMs = {
      from: zonedTimeToUtc(start, "00:00", tz),
      to: zonedTimeToUtc(ymdAddDays(end, 1), "00:00", tz) - 1_000,
    };
  };

  const unparsed = [...raw.unparsed];

  for (const h of raw.hard) {
    if (h.type === "window") {
      // A window is the run's calendar, and the pack has exactly one. A
      // division-scoped window would silently clamp every other division, so it
      // is refused rather than applied to the wrong thing.
      if (h.scope.kind !== "competition") {
        unparsed.push(`a date range for one division only is not supported — state it for the whole run`);
        continue;
      }
      // Second and later windows are refused, not merged: "last wins" would
      // discard a range whose assumption line the organiser has already read.
      if (ymd !== null) {
        unparsed.push(`more than one date range was stated — only the first was used`);
        continue;
      }
      const start = resolveDateRef(h.start, clock);
      let end = resolveDateRef(h.end, clock);
      if (end < start) {
        // Roll whole weeks until the range is non-empty. A single +7 still lands
        // before the start whenever the start is an explicit far-future date.
        // Bounded so a nonsense pair becomes `unparsed` instead of looping.
        let rolls = 0;
        while (end < start && rolls < 53) {
          end = ymdAddDays(end, 7);
          rolls++;
        }
        if (end < start) {
          unparsed.push(`a date range ending before it starts could not be read`);
          continue;
        }
        assumptions.push(`window end resolved before its start — read as the following week (${end})`);
      }
      setWindow(start, end);
      assumptions.push(`instruction window resolved to ${start}..${end} (${tz})`);
    } else if (h.type === "fixture_on_date") {
      hard.push({ ...h, date: resolveDateRef(h.date, clock) });
    } else if (h.type === "fixture_on_weekday") {
      // The rule itself stays symbolic: the verifier compares the weekday of the
      // day a fixture landed on, so ANY matching weekday satisfies it. The date
      // is named only so the organiser can sanity-check which week we are in.
      assumptions.push(
        `'${h.weekday}' read as any ${h.weekday} in the run — the next one is ${clock.nextWeekday[h.weekday]}`,
      );
      hard.push(h);
    } else {
      hard.push(h);
    }
  }

  // Feasibility-aware reading. "from tomorrow till Friday" when tomorrow IS
  // Friday literally means one day; if a per-day cap cannot hold the fixture
  // count in that many days, take the next weekly reading — and SAY SO, so the
  // organiser sees the judgement instead of an unexplained extra week.
  if (ymd !== null) {
    const w = ymd as { start: string; end: string };
    // COMPETITION-scoped caps only. A division-scoped 1/day bounds that
    // division, not the run, and using it here would extend everybody's window
    // by a week on the strength of a rule most fixtures are not subject to.
    const cap = raw.hard.reduce<number | null>(
      (m, h) =>
        h.type === "max_fixtures_per_day" && h.scope.kind === "competition"
          ? Math.min(m ?? Infinity, h.count)
          : m,
      null,
    );
    const count = hints.fixtureCount ?? 0;
    if (count > 0 && cap !== null) {
      const days =
        Math.round((Date.parse(`${w.end}T00:00:00Z`) - Date.parse(`${w.start}T00:00:00Z`)) / MS_PER_DAY) + 1;
      if (days * cap < count) {
        const extended = ymdAddDays(w.end, 7);
        assumptions.push(
          `window ${w.start}..${w.end} holds only ${days * cap} of ${count} fixtures under the ${cap}/day cap — read the end as the following week (${extended})`,
        );
        setWindow(w.start, extended);
      }
    }
  }

  return { hard, soft: raw.soft, unparsed, assumptions, windowMs };
}
