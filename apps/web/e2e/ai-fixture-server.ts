// v4 Task 17 — AI model fixture server. Task 10 (openrouter-provider) added a
// second dialect on the same server.
//
// A tiny HTTP stand-in for both the Anthropic Messages API and OpenRouter's
// OpenAI-shaped chat completions API, so the AI Schedule Architect e2e never
// touches a real model on EITHER provider path. The Next server under test is
// pointed at it via SCHEDULING_AI_BASE_URL (Anthropic dialect) or
// OPENROUTER_BASE_URL (OpenRouter dialect) — see playwright.config.ts's
// webServer.env and the local run recipe in the spec. anthropicProvider() in
// anthropic-provider.ts POSTs `${baseURL}/v1/messages`; openRouterProvider() in
// openrouter-provider.ts POSTs `${baseURL}/chat/completions`. Which dialect
// the app actually speaks is chosen by AI_PROVIDER, not by anything this
// server does — both routes are always live here.
//
// How the SDK derives `parsed_output` (node_modules/@anthropic-ai/sdk/lib/
// parser.mjs → zodOutputFormat.parse): it JSON.parses the FIRST text content
// block's `.text` and runs the caller's zod schema over it. So a canned response
// is just a normal Messages envelope whose content is one text block carrying the
// JSON-stringified plan. A `stop_reason: "refusal"` (with no text block) drives
// the model-refusal error path.
//
// openRouterProvider() parses `choices[0].message.content` as a JSON string
// and validates it against the zod schema directly (no SDK helper), so the
// OpenRouter dialect below serialises the same plan into that string field.
// Its refusal signal is `choices[0].finish_reason === "content_filter"` OR a
// string `message.refusal` (see openrouter-provider.ts); this fixture drives
// the former, since that's the one confirmed live against a real refusal.
//
// The plan is derived from the request itself: the runner sends the whole
// deterministic context pack as a user message (JSON.stringify(pack)) — the
// first message on the Anthropic dialect, or the first non-system message on
// the OpenRouter dialect (whose body prepends a system message carrying the
// cache breakpoint; see openrouter-request.ts) — and the pack already carries
// a `draft` — an engine-legal greedy solution over every movable fixture.
// Echoing that draft as the assignments yields a plan the server-side engine
// verifier passes as CLEAN, over whatever ids the seed minted.
//
// #398 (W3) added a THIRD request shape on this same dialect/endpoint: the
// stage-1 instruction compile, sent ahead of the schedule/joint-schedule call
// whenever the organiser's textarea is non-empty. It has neither `draft` nor
// `fixtures`, so it is recognised by its own `{instruction, context}` shape
// and tagged phase "parse" (see `ParseRequestLite` below) rather than falling
// through to "schedule" — the parse call always fires first, so leaving it
// misclassified would make it shadow the real schedule call under
// `calls.find(c => c.phase === "schedule")`.
import { createServer, type Server } from "node:http";

/** Fixed port so the Next server (booted before the spec) and the spec agree on
 *  the fixture URL without dynamic discovery. Kept off the app's dev ports and
 *  away from 3013/3014. */
export const AI_FIXTURE_PORT = Number(process.env.AI_FIXTURE_PORT ?? 4319);
export const AI_FIXTURE_URL =
  process.env.SCHEDULING_AI_BASE_URL ?? `http://127.0.0.1:${AI_FIXTURE_PORT}`;

/** The magic instruction substring that forces a model refusal (error path). */
export const FIXTURE_REFUSE = "FIXTURE_REFUSE";

/**
 * W6 (#401): forces the canned plan to double-book a court.
 *
 * The model is the only thing this server pretends to be, so the only way to
 * exercise the constraint solver end-to-end is to hand the runner a plan that
 * genuinely breaks a rule. The second draft card is moved onto the first card's
 * court AND time, which `validateAssignments` scores as a blocking `court`
 * conflict — the exact shape the solver was built to repair, and the one an
 * organiser would otherwise have had to fix by hand or by spending another LLM
 * round.
 *
 * Deliberately a REAL conflict rather than a hand-written repair report: a
 * fixture that fakes the report proves the panel renders, while this proves the
 * runner detected a clash, the solver was reached, and the repair came back
 * verifier-clean.
 */
export const FIXTURE_CLASH = "FIXTURE_CLASH";

/**
 * #452 — the same clash, on a board whose OTHER cards sit off the minute.
 *
 * Every instant the deterministic draft produces is minute-aligned, so
 * `FIXTURE_CLASH` can only ever build a board on which the repair encoder's
 * minutes and `validateAssignments`'s milliseconds agree by construction. That
 * is precisely the blind spot #457 lived in: an obstacle ending at 10:00:20
 * rounded DOWN to 10:00, so z3 permitted a start that overlapped it by twenty
 * seconds and the verifier rejected the board the solver had just proved clean.
 * No minute-aligned board can express that disagreement.
 *
 * WHAT IS OFFSET, AND WHY IT IS NOT THE CLASH PAIR. The clash stays byte-for-byte
 * what `FIXTURE_CLASH` produces; every draft card FROM THE THIRD ON is shifted
 * instead. Two reasons, both measured rather than assumed:
 *
 *   * The cards that are not in the clash have no reason to move, so they are
 *     what the solver has to route the repaired card AROUND — the obstacle
 *     rounding that #457 was actually about. They also come out the far end
 *     still carrying their seconds, which is what makes the spec's assertion on
 *     the applied board deterministic rather than a coin flip on which of two
 *     interchangeable cards z3 picked.
 *   * Offsetting the clash pair itself was tried first and is worse in a way
 *     worth recording: the board then repairs with `data-moved="2"` and
 *     `data-minimality="upper_bound"` (both clash cards land in the free tail
 *     of the day, minute-aligned, and no sub-minute value survives at all),
 *     where the whole-minute clash proves a single move. So that variant tests
 *     neither minimal repair nor sub-minute survival.
 *
 * Sub-minute instants are reachable from the product, not invented here:
 * `AddFixture.scheduled_at` is a client-supplied RFC-3339 string with no
 * seconds restriction, the single-move PATCH stores it verbatim, and the AI
 * usecase feeds `Date.parse` straight into `Assignment.startAt`.
 *
 * The sentinel deliberately CONTAINS `FIXTURE_CLASH`, so a body carrying it
 * takes the clash path too; the offset is the only difference.
 */
export const FIXTURE_CLASH_SECONDS = `${FIXTURE_CLASH}_SECONDS`;

/** How far off the minute `FIXTURE_CLASH_SECONDS` pushes the non-clashing cards.
 *  Small enough that it moves no minute bucket, weekday or day boundary — the
 *  only thing under test is the sub-minute remainder itself. */
export const FIXTURE_CLASH_OFFSET_MS = 20_000;

/** The first draft index `FIXTURE_CLASH_OFFSET_MS` applies to. 0 and 1 are the
 *  clash pair and are left exactly where `FIXTURE_CLASH` puts them. */
const CLASH_OFFSET_FROM_INDEX = 2;

/**
 * W5 (#400) — the one brief this server actually COMPILES.
 *
 * Stage 1 is a model call like any other, so against the canned `{}` below
 * every preview card renders "nothing in this instruction can be enforced" —
 * and the gate's whole point is the rules it shows before a credit moves. This
 * brief is therefore compiled for real: a per-day cap, a weekday rule on the
 * final, a date range, a wish we only pass on, and a clause we admit we could
 * not use. Every one of those five is a sentence the organiser actually typed,
 * because the card quotes `unparsed` verbatim and a fixture that invented the
 * words would be testing a lie.
 *
 * Matched by the distinctive `at most 2 matches a day` substring and NOTHING
 * else. Any other instruction still compiles to `{}`, which is what keeps a
 * real constraint out of the happy-path runs: a compiled rule is reused by the
 * confirmed run and enforced by the verifier, so a fixture that compiled
 * "finish by 6pm" for everybody could turn a CLEAN schedule red.
 */
export const FIXTURE_COMPILE_BRIEF =
  "between today and Friday, at most 2 matches a day, final on Friday, " +
  "keep the show court busy, and make it feel fair";
/** The clause `FIXTURE_COMPILE_BRIEF` compiles to a passed-on wish. */
export const FIXTURE_COMPILE_SOFT = "keep the show court busy";
/** The clause `FIXTURE_COMPILE_BRIEF` compiles to nothing at all. */
export const FIXTURE_COMPILE_UNPARSED = "and make it feel fair";

export interface FixtureCall {
  phase: "schedule" | "officials" | "parse" | "unknown";
  refusal: boolean;
  /** Movable fixtures the pack asked to place (schedule phase). */
  movable: number;
  /** Assignments returned in the canned plan. */
  assignments: number;
}

export interface AiFixtureServer {
  url: string;
  /** Every /v1/messages request the server has served since the last reset. */
  calls: FixtureCall[];
  reset(): void;
  close(): Promise<void>;
}

interface SchedulePackLite {
  draft?: { fixture_id: string; scheduled_at: string; court_label: string }[];
  fixtures?: { movable?: { id: string }[] } | unknown[];
}
interface OfficialsPackLite {
  draft?: { fixture_id: string; official_id: string; role_key: string }[];
  fixtures?: unknown[];
}
/** #398's stage-1 compile: `{instruction, context: {divisions}}`, sent on the
 *  SAME dialect/endpoint ahead of the schedule (or joint-schedule) call
 *  whenever the organiser's textarea is non-empty. It carries neither `draft`
 *  nor `fixtures`, so without a dedicated check it falls through to the
 *  schedule branch below and — since it fires first — shadows the real
 *  schedule call for any `.find(c => c.phase === "schedule")`. */
interface ParseRequestLite {
  instruction?: string;
  context?: { divisions?: unknown[] };
}

function buildSchedulePlan(pack: SchedulePackLite, clashOffsetMs: number | null = null): unknown {
  const draft = Array.isArray(pack.draft) ? pack.draft : [];
  const assignments = draft.map((d) => ({
    fixture_id: d.fixture_id,
    scheduled_at: d.scheduled_at,
    court_label: d.court_label,
  }));
  // W6 (#401): put the second card exactly where the first one is. One blocking
  // `court` conflict, on a board whose remaining slots are free — so the minimal
  // repair is a single move, and a solver that moved more than one fixture is
  // visibly wrong rather than merely slower.
  //
  if (clashOffsetMs !== null && assignments.length >= 2) {
    assignments[1] = {
      ...assignments[1]!,
      scheduled_at: assignments[0]!.scheduled_at,
      court_label: assignments[0]!.court_label,
    };
    // #452: the rest of the board goes off the minute, leaving the clash exactly
    // where it was. See `FIXTURE_CLASH_SECONDS` for why it is these cards and
    // not the clashing pair. `clashOffsetMs === 0` touches nothing, so
    // `FIXTURE_CLASH` behaviour is unchanged rather than round-tripped
    // through Date.
    if (clashOffsetMs > 0) {
      for (let i = CLASH_OFFSET_FROM_INDEX; i < assignments.length; i++) {
        assignments[i] = {
          ...assignments[i]!,
          scheduled_at: new Date(Date.parse(assignments[i]!.scheduled_at) + clashOffsetMs).toISOString(),
        };
      }
    }
  }
  const placed = new Set(assignments.map((a) => a.fixture_id));
  const movable = !Array.isArray(pack.fixtures) && pack.fixtures?.movable ? pack.fixtures.movable : [];
  // Structural completeness: every movable id must appear exactly once. Anything
  // the draft could not place is declared unschedulable so the verifier gate
  // never rejects the plan before it reaches CLEAN.
  const unschedulable = movable
    .filter((f) => !placed.has(f.id))
    .map((f) => ({ fixture_id: f.id, reason: "no legal slot in the fixture-server draft" }));
  return {
    assignments,
    unschedulable,
    explanations: [],
    summary: "Fixture-server canned plan echoing the deterministic draft.",
  };
}

/** Every field of `RawParsed` (schedule-ai-parse.ts) defaults, so `{}` is a
 *  schema-valid "nothing compiled" answer under both dialects' zod validation
 *  — the fixture doesn't need to actually honor free-text wishes as hard
 *  constraints to keep the schedule/officials phases deterministic.
 *
 *  W5 (#400): except for `FIXTURE_COMPILE_BRIEF`, which compiles for real so
 *  the preview card has rules to show. Symbolic, exactly as the prompt demands
 *  — `resolveParsed` owns the calendar, and a fixture that resolved dates
 *  itself would skip the half of stage 1 the assumptions come from. */
function buildParsePlan(instruction: string): unknown {
  if (!instruction.includes("at most 2 matches a day")) return {};
  return {
    hard: [
      { type: "window", start: { kind: "today" }, end: { kind: "weekday", weekday: "FRI" }, scope: { kind: "competition" } },
      { type: "max_fixtures_per_day", count: 2, scope: { kind: "competition" } },
      { type: "fixture_on_weekday", selector: { kind: "terminal" }, weekday: "FRI", scope: { kind: "competition" } },
    ],
    soft: [{ note: FIXTURE_COMPILE_SOFT, weight: 2 }],
    unparsed: [FIXTURE_COMPILE_UNPARSED],
  };
}

function buildOfficialsPlan(pack: OfficialsPackLite): unknown {
  const draft = Array.isArray(pack.draft) ? pack.draft : [];
  return {
    assignments: draft.map((d) => ({
      fixture_id: d.fixture_id,
      official_id: d.official_id,
      role_key: d.role_key,
    })),
    unfilled: [],
    explanations: [],
    summary: "Fixture-server canned officials plan.",
  };
}

function envelope(model: string, content: unknown[], stopReason: string): unknown {
  return {
    id: "msg_e2e_fixture",
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 600 },
  };
}

interface GeneratedPlan {
  phase: FixtureCall["phase"];
  model: string;
  plan: unknown;
  movable: number;
}

/** Shared across both dialects: find the user turn carrying the pack (index 0
 *  on Anthropic, first non-system message on OpenRouter), derive the phase
 *  from its shape, and echo its `draft` back as an engine-legal plan. */
function generatePlan(
  body: { model?: string; messages?: { role?: string; content?: unknown }[] },
  fallbackModel: string,
  /** null = no clash; 0 = the whole-minute clash; >0 = that many ms off the
   *  minute (#452). */
  clashOffsetMs: number | null = null,
): GeneratedPlan {
  let phase: FixtureCall["phase"] = "unknown";
  const model = body.model ?? fallbackModel;
  let plan: unknown = null;
  let movable = 0;
  try {
    const packTurn = body.messages?.find((m) => m.role !== "system") ?? body.messages?.[0];
    const content = packTurn?.content;
    const pack = JSON.parse(typeof content === "string" ? content : "{}");
    if (Array.isArray(pack.fixtures)) {
      phase = "officials";
      plan = buildOfficialsPlan(pack as OfficialsPackLite);
    } else if (
      typeof (pack as ParseRequestLite).instruction === "string" &&
      Array.isArray((pack as ParseRequestLite).context?.divisions)
    ) {
      phase = "parse";
      plan = buildParsePlan((pack as ParseRequestLite).instruction ?? "");
    } else {
      phase = "schedule";
      movable = pack.fixtures?.movable?.length ?? 0;
      plan = buildSchedulePlan(pack as SchedulePackLite, clashOffsetMs);
    }
  } catch {
    /* leave defaults; a malformed pack becomes an empty-plan response */
  }
  return { phase, model, plan, movable };
}

export async function startAiFixtureServer(port = AI_FIXTURE_PORT): Promise<AiFixtureServer> {
  const calls: FixtureCall[] = [];
  const server: Server = createServer((req, res) => {
    const url = req.url ?? "";
    const isAnthropic = url.includes("/v1/messages");
    // OpenRouter mode: same fixture plan, different envelope. Selected by
    // pointing OPENROUTER_BASE_URL at this server instead of
    // SCHEDULING_AI_BASE_URL.
    const isOpenRouter = url.includes("/chat/completions");
    if (req.method !== "POST" || (!isAnthropic && !isOpenRouter)) {
      res.writeHead(404, { "content-type": "application/json" }).end("{}");
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const refusal = raw.includes(FIXTURE_REFUSE);
      let body: { model?: string; messages?: { role?: string; content?: unknown }[] } = {};
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        /* malformed body becomes an empty-plan response, same as before */
      }
      // Order matters: `FIXTURE_CLASH_SECONDS` contains `FIXTURE_CLASH`, so the
      // more specific sentinel has to be tested first or every off-minute run
      // silently degrades to the whole-minute clash and passes for the wrong
      // reason.
      const clashOffsetMs = raw.includes(FIXTURE_CLASH_SECONDS)
        ? FIXTURE_CLASH_OFFSET_MS
        : raw.includes(FIXTURE_CLASH)
          ? 0
          : null;
      const { phase, model, plan, movable } = generatePlan(
        body,
        isAnthropic ? "claude-sonnet-5" : "anthropic/claude-sonnet-5",
        clashOffsetMs,
      );
      const planLike = plan as { assignments?: unknown[] } | null;
      calls.push({ phase, refusal, movable, assignments: planLike?.assignments?.length ?? 0 });

      if (isOpenRouter) {
        const message = refusal
          ? { role: "assistant", content: null }
          : { role: "assistant", content: JSON.stringify(plan) };
        const response = {
          model,
          choices: [
            {
              finish_reason: refusal ? "content_filter" : "stop",
              message,
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
        };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(response));
        return;
      }

      const message = refusal
        ? envelope(model, [], "refusal")
        : envelope(model, [{ type: "text", text: JSON.stringify(plan) }], "end_turn");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    reset() {
      calls.length = 0;
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
