// v4 Task 17 — AI model fixture server.
//
// A tiny HTTP stand-in for the Anthropic Messages API so the AI Schedule
// Architect e2e never touches a real model. The Next server under test is
// pointed at it via SCHEDULING_AI_BASE_URL (see playwright.config.ts's
// webServer.env and the local run recipe in the spec); anthropicClient() in
// schedule-ai.ts then POSTs `${baseURL}/v1/messages` here.
//
// How the SDK derives `parsed_output` (node_modules/@anthropic-ai/sdk/lib/
// parser.mjs → zodOutputFormat.parse): it JSON.parses the FIRST text content
// block's `.text` and runs the caller's zod schema over it. So a canned response
// is just a normal Messages envelope whose content is one text block carrying the
// JSON-stringified plan. A `stop_reason: "refusal"` (with no text block) drives
// the model-refusal error path.
//
// The plan is derived from the request itself: the runner sends the whole
// deterministic context pack as the first user message (JSON.stringify(pack)),
// and the pack already carries a `draft` — an engine-legal greedy solution over
// every movable fixture. Echoing that draft as the assignments yields a plan the
// server-side engine verifier passes as CLEAN, over whatever ids the seed minted.
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

export async function startAiFixtureServer(port = AI_FIXTURE_PORT): Promise<AiFixtureServer> {
  const calls: FixtureCall[] = [];
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || !(req.url ?? "").includes("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" }).end("{}");
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const refusal = raw.includes(FIXTURE_REFUSE);
      let phase: FixtureCall["phase"] = "unknown";
      let model = "claude-sonnet-5";
      let plan: unknown = null;
      let movable = 0;
      try {
        const body = JSON.parse(raw) as { model?: string; messages?: { content?: unknown }[] };
        model = body.model ?? model;
        const first = body.messages?.[0]?.content;
        const pack = JSON.parse(typeof first === "string" ? first : "{}");
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
      const planLike = plan as { assignments?: unknown[] } | null;
      calls.push({ phase, refusal, movable, assignments: planLike?.assignments?.length ?? 0 });
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
