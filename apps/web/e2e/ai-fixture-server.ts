// v4 Task 17 — AI model fixture server. Task 10 (openrouter-provider) added a
// second dialect on the same server.
//
// A tiny HTTP stand-in for both the Anthropic Messages API and OpenRouter's
// OpenAI-shaped chat completions API, so the AI Schedule Architect e2e never
// touches a real model on EITHER provider path. The Next server under test is
// pointed at it via SCHEDULING_AI_BASE_URL (Anthropic dialect) or
// OPENROUTER_BASE_URL (OpenRouter dialect) — see playwright.config.ts's
// webServer.env and the local run recipe in the spec. anthropicClient() in
// schedule-ai.ts POSTs `${baseURL}/v1/messages`; openRouterProvider() in
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
import { createServer, type Server } from "node:http";

/** Fixed port so the Next server (booted before the spec) and the spec agree on
 *  the fixture URL without dynamic discovery. Kept off the app's dev ports and
 *  away from 3013/3014. */
export const AI_FIXTURE_PORT = Number(process.env.AI_FIXTURE_PORT ?? 4319);
export const AI_FIXTURE_URL =
  process.env.SCHEDULING_AI_BASE_URL ?? `http://127.0.0.1:${AI_FIXTURE_PORT}`;

/** The magic instruction substring that forces a model refusal (error path). */
export const FIXTURE_REFUSE = "FIXTURE_REFUSE";

export interface FixtureCall {
  phase: "schedule" | "officials" | "unknown";
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

function buildSchedulePlan(pack: SchedulePackLite): unknown {
  const draft = Array.isArray(pack.draft) ? pack.draft : [];
  const assignments = draft.map((d) => ({
    fixture_id: d.fixture_id,
    scheduled_at: d.scheduled_at,
    court_label: d.court_label,
  }));
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
    } else {
      phase = "schedule";
      movable = pack.fixtures?.movable?.length ?? 0;
      plan = buildSchedulePlan(pack as SchedulePackLite);
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
      const { phase, model, plan, movable } = generatePlan(
        body,
        isAnthropic ? "claude-sonnet-5" : "anthropic/claude-sonnet-5",
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
