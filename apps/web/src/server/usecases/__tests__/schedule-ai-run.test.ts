// v4/00 §3-4 + 01 §1,§5 — runAiPlan LLM call + verify/repair loop (Task 5).
// The Anthropic SDK is mocked (no network in CI): `messages.parse` is a vi.fn
// whose queued resolutions stand in for structured-output responses. Every plan
// is hand-authored against a small in-file 4-fixture pack — runAiPlan takes the
// pack as data, so no DB is needed here.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the SDK default export as a class exposing `messages.parse`. Must be
// declared before importing the module under test.
const parse = vi.fn();
const ctorOpts: unknown[] = [];
vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = { parse };
    constructor(opts: unknown) {
      ctorOpts.push(opts);
    }
  },
}));

import { runAiPlan } from "../schedule-ai";
import type { SchedulePack } from "../schedule-ai";

// --- Fixed ids -------------------------------------------------------------
const F1 = "11111111-1111-4111-8111-111111111111";
const F2 = "22222222-2222-4222-8222-222222222222";
const F3 = "33333333-3333-4333-8333-333333333333";
const F4 = "44444444-4444-4444-8444-444444444444";
const FOREIGN = "99999999-9999-4999-8999-999999999999";
const E = (n: number) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`;

// --- A small legal pack: 4 independent fixtures, 2 courts, one 09:00-18:00
//     session window, no feeds, no shared people. -------------------------
function makePack(overrides: Partial<SchedulePack> = {}): SchedulePack {
  return {
    mode: "generate",
    division: { id: "d1", name: "Open", sport: "generic", tz: "Europe/London", scheduling_mode: "timed" },
    settings: {
      matchMinutes: 30,
      gapMinutes: 0,
      courts: ["Court 1", "Court 2"],
      sessionWindows: [{ from: "2026-08-01T09:00:00+01:00", to: "2026-08-01T18:00:00+01:00" }],
      blackouts: [],
      constraints: {
        restMin: 20,
        noBackToBack: false,
        startWindows: [],
        fieldFairness: "balance",
        parallelism: "mixed",
        crossPersonClash: "hard",
      },
    },
    entrants: [],
    people: [],
    fixtures: {
      movable: [F1, F2, F3, F4].map((id, i) => ({
        id,
        ext_key: `f${i + 1}`,
        round: 1,
        seq: i,
        pool: null,
        home: E(2 * i + 1),
        away: E(2 * i + 2),
        feeds: { winner_to: null, after: [] },
        current: { at: null, court: null },
        pinned: false,
      })),
      obstacles: [],
    },
    draft: [],
    instruction: "Finish by 6pm.",
    prior: null,
    officials: [],
    ...overrides,
  };
}

const pack = makePack();
const movableIds = new Set([F1, F2, F3, F4]);

function assign(fixture_id: string, scheduled_at: string, court_label: string) {
  return { fixture_id, scheduled_at, court_label };
}

function plan(assignments: ReturnType<typeof assign>[], unschedulable: { fixture_id: string; reason: string }[] = []) {
  return { assignments, unschedulable, explanations: [], summary: "ok" };
}

// SF1+SF2 double-booked on Court 1 @ 14:00 → verifier court clash.
const clashingPlan = plan([
  assign(F1, "2026-08-01T14:00:00+01:00", "Court 1"),
  assign(F2, "2026-08-01T14:00:00+01:00", "Court 1"),
  assign(F3, "2026-08-01T14:00:00+01:00", "Court 2"),
  assign(F4, "2026-08-01T14:30:00+01:00", "Court 2"),
]);
// Repair moves F2 off Court 1 → clean.
const fixedPlan = plan([
  assign(F1, "2026-08-01T14:00:00+01:00", "Court 1"),
  assign(F2, "2026-08-01T14:00:00+01:00", "Court 2"),
  assign(F3, "2026-08-01T14:30:00+01:00", "Court 2"),
  assign(F4, "2026-08-01T14:30:00+01:00", "Court 1"),
]);
// TWO court double-books (F1+F2 on Court 1, F3+F4 on Court 2, all @14:00) →
// strictly more blocking conflicts than clashingPlan's single clash.
const twoClashPlan = plan([
  assign(F1, "2026-08-01T14:00:00+01:00", "Court 1"),
  assign(F2, "2026-08-01T14:00:00+01:00", "Court 1"),
  assign(F3, "2026-08-01T14:00:00+01:00", "Court 2"),
  assign(F4, "2026-08-01T14:00:00+01:00", "Court 2"),
]);
// Everything in the morning: legal + every match ends well before 18:00.
const finishBy18Plan = plan([
  assign(F1, "2026-08-01T09:00:00+01:00", "Court 1"),
  assign(F2, "2026-08-01T09:00:00+01:00", "Court 2"),
  assign(F3, "2026-08-01T09:30:00+01:00", "Court 1"),
  assign(F4, "2026-08-01T09:30:00+01:00", "Court 2"),
]);
// One assignment references a fixture id that is not movable.
const planWithForeignId = plan([
  assign(F1, "2026-08-01T09:00:00+01:00", "Court 1"),
  assign(F2, "2026-08-01T09:00:00+01:00", "Court 2"),
  assign(F3, "2026-08-01T09:30:00+01:00", "Court 1"),
  assign(FOREIGN, "2026-08-01T09:30:00+01:00", "Court 2"),
]);

function planResponse(p: unknown, usage: unknown = { input_tokens: 1000, output_tokens: 500 }) {
  return { parsed_output: p, stop_reason: "end_turn", usage, content: [] };
}

beforeEach(() => {
  parse.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

describe("runAiPlan (v4/00 §3-4)", () => {
  it("court clash → one repair round → clean", async () => {
    parse
      .mockResolvedValueOnce(planResponse(clashingPlan))
      .mockResolvedValueOnce(planResponse(fixedPlan));
    const out = await runAiPlan(pack, movableIds);
    expect(out.usage.repair_rounds).toBe(1);
    expect(out.blocking).toHaveLength(0);
    // usage accumulates across both rounds.
    expect(out.usage.input_tokens).toBe(2000);
    expect(out.usage.output_tokens).toBe(1000);
    // the repair user turn carried the verifier conflicts (a court clash).
    const repairMsg = parse.mock.calls[1]![0].messages.at(-1);
    expect(JSON.stringify(repairMsg)).toContain("court");
    expect(JSON.stringify(repairMsg)).toContain("verifier_conflicts");
    expect(out.proposal).toHaveLength(4);
  });

  it("clean on the first pass → zero repair rounds", async () => {
    parse.mockResolvedValueOnce(planResponse(finishBy18Plan));
    const out = await runAiPlan(pack, movableIds);
    expect(out.usage.repair_rounds).toBe(0);
    expect(out.blocking).toHaveLength(0);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("a timed-out round rides accumulated usage on the 422 (AI_PLAN_TIMEOUT is metered like AI_PLAN_FAILED)", async () => {
    // Round 1: malformed (null plan) burns tokens and triggers the corrective
    // retry; round 2: the abort fires as AI_PLAN_TIMEOUT. The earlier spend
    // must ride on the error's extra.
    const { HttpError } = await import("@/lib/errors");
    parse
      .mockResolvedValueOnce(planResponse(null, { input_tokens: 1000, output_tokens: 500 }))
      .mockRejectedValueOnce(new HttpError(422, "AI scheduling timed out; please retry", "AI_PLAN_TIMEOUT"));
    const err = await runAiPlan(pack, movableIds).then(
      () => null,
      (e: unknown) => e as { code?: string; extra?: { usage?: { input_tokens: number; output_tokens: number } } },
    );
    expect(err?.code).toBe("AI_PLAN_TIMEOUT");
    expect(err?.extra?.usage?.input_tokens).toBe(1000);
    expect(err?.extra?.usage?.output_tokens).toBe(500);
  });

  it("defaults to claude-sonnet-5 when SCHEDULING_AI_MODEL is unset (opus cannot finish a live round — 2026-07-19 measurement)", async () => {
    delete process.env.SCHEDULING_AI_MODEL;
    parse.mockResolvedValueOnce(planResponse(finishBy18Plan));
    await runAiPlan(pack, movableIds);
    const body = parse.mock.calls[0][0] as { model: string };
    expect(body.model).toBe("claude-sonnet-5");
  });

  it("client is constructed with an explicit timeout — without one the SDK refuses non-streaming max_tokens:32000 calls", async () => {
    parse.mockResolvedValueOnce(planResponse(finishBy18Plan));
    await runAiPlan(pack, movableIds);
    // Client-level: the SDK's calculateNonstreamingTimeout throws when the
    // constructor has no timeout (per-request options spread in after the check).
    const ctor = ctorOpts.at(-1) as { timeout?: number };
    expect(ctor.timeout).toBeTypeOf("number");
    expect(ctor.timeout!).toBeGreaterThan(0);
    // Per-request: the abort signal plus timeout still ride on every call.
    const opts = parse.mock.calls[0][1] as { timeout?: number; signal?: unknown };
    expect(opts.timeout).toBeTypeOf("number");
    expect(opts.signal).toBeDefined();
  });

  it("residual blocking after 2 repairs returns best-so-far with blocking marked", async () => {
    parse
      .mockResolvedValueOnce(planResponse(clashingPlan))
      .mockResolvedValueOnce(planResponse(clashingPlan))
      .mockResolvedValueOnce(planResponse(clashingPlan));
    const out = await runAiPlan(pack, movableIds);
    expect(out.usage.repair_rounds).toBe(2);
    expect(out.blocking.length).toBeGreaterThan(0);
    expect(out.blocking.every((c) => c.reason === "court")).toBe(true);
    // Exactly 3 model calls: initial + 2 repairs.
    expect(parse).toHaveBeenCalledTimes(3);
  });

  it("best-so-far: repair round 2 with MORE blocking → returns round-1's fewer-blocking plan", async () => {
    parse
      .mockResolvedValueOnce(planResponse(clashingPlan)) // round 1: one clash (fewest)
      .mockResolvedValueOnce(planResponse(twoClashPlan)) // repair 1: two clashes (worse)
      .mockResolvedValueOnce(planResponse(twoClashPlan)); // repair 2: two clashes (worse)
    const out = await runAiPlan(pack, movableIds);
    // Two repair rounds ran, but the kept plan is the earlier, fewer-blocking one.
    expect(out.usage.repair_rounds).toBe(2);
    expect(parse).toHaveBeenCalledTimes(3);
    expect(
      out.proposal.map(({ fixture_id, scheduled_at, court_label }) => ({ fixture_id, scheduled_at, court_label })),
    ).toEqual(clashingPlan.assignments);
    // clashingPlan has strictly fewer blocking conflicts than twoClashPlan.
    expect(out.blocking.length).toBeLessThan(twoClashPlan.assignments.length);
  });

  it("pinned fixture pushed into unschedulable → one corrective retry, then 422", async () => {
    const packPinnedMovable = makePack({
      fixtures: {
        movable: [F1, F2, F3, F4].map((id, i) => ({
          id,
          ext_key: `f${i + 1}`,
          round: 1,
          seq: i,
          pool: null,
          home: E(2 * i + 1),
          away: E(2 * i + 2),
          feeds: { winner_to: null, after: [] },
          // F4 is pinned AND movable — it must keep its exact current slot.
          current: id === F4 ? { at: "2026-08-01T16:00:00+01:00", court: "Court 1" } : { at: null, court: null },
          pinned: id === F4,
        })),
        obstacles: [],
      },
    });
    // The model tries to silently drop the pinned fixture as unschedulable.
    const dropsPinned = plan(
      [
        assign(F1, "2026-08-01T09:00:00+01:00", "Court 1"),
        assign(F2, "2026-08-01T09:00:00+01:00", "Court 2"),
        assign(F3, "2026-08-01T09:30:00+01:00", "Court 1"),
      ],
      [{ fixture_id: F4, reason: "no room" }],
    );
    parse
      .mockResolvedValueOnce(planResponse(dropsPinned))
      .mockResolvedValueOnce(planResponse(dropsPinned));
    await expect(runAiPlan(packPinnedMovable, movableIds)).rejects.toMatchObject({ status: 422 });
    // The corrective retry ran (structural rejection, not a coverage pass-through).
    expect(parse).toHaveBeenCalledTimes(2);
    const corrective = parse.mock.calls[1]![0].messages.at(-1);
    expect(JSON.stringify(corrective)).toContain("structural_error");
  });

  it("SDK parse throwing on schema-invalid output → corrective retry, then success", async () => {
    parse
      .mockRejectedValueOnce(new Error("could not parse structured output"))
      .mockResolvedValueOnce(planResponse(finishBy18Plan));
    const out = await runAiPlan(pack, movableIds);
    expect(out.blocking).toHaveLength(0);
    expect(out.usage.repair_rounds).toBe(0);
    // Initial (threw → normalized to null-parsed) + corrective retry.
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("refusal → 422 AI_PLAN_FAILED (code discriminant + human message; usage attached)", async () => {
    parse.mockResolvedValueOnce({ parsed_output: null, stop_reason: "refusal", usage: {}, content: [] });
    await expect(runAiPlan(pack, movableIds)).rejects.toMatchObject({
      status: 422,
      code: "AI_PLAN_FAILED",
      message: "AI scheduling could not produce a usable plan; please retry",
      extra: { usage: { input_tokens: 0, output_tokens: 0, repair_rounds: 0 } },
    });
  });

  it("missing ANTHROPIC_API_KEY → 503 before any call", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(runAiPlan(pack, movableIds)).rejects.toMatchObject({ status: 503 });
    expect(parse).not.toHaveBeenCalled();
  });

  it("foreign id → one corrective retry, then 422 (accumulated usage preserved)", async () => {
    parse.mockResolvedValueOnce(planResponse(planWithForeignId));
    // The 422 carries the tokens already spent on the first (rejected) call.
    await expect(runAiPlan(pack, movableIds)).rejects.toMatchObject({
      status: 422,
      code: "AI_PLAN_FAILED",
      extra: { usage: { input_tokens: 1000, output_tokens: 500, repair_rounds: 0 } },
    });
    // A corrective retry was attempted (a second call was made).
    expect(parse).toHaveBeenCalledTimes(2);
    const corrective = parse.mock.calls[1]![0].messages.at(-1);
    expect(JSON.stringify(corrective)).toContain("structural_error");
  });

  it("missing a movable id (coverage) is rejected", async () => {
    const incomplete = plan([
      assign(F1, "2026-08-01T09:00:00+01:00", "Court 1"),
      assign(F2, "2026-08-01T09:00:00+01:00", "Court 2"),
    ]);
    parse.mockResolvedValueOnce(planResponse(incomplete));
    await expect(runAiPlan(pack, movableIds)).rejects.toMatchObject({ status: 422 });
  });

  it("unknown court is rejected", async () => {
    const badCourt = plan([
      assign(F1, "2026-08-01T09:00:00+01:00", "Court 9"),
      assign(F2, "2026-08-01T09:00:00+01:00", "Court 2"),
      assign(F3, "2026-08-01T09:30:00+01:00", "Court 1"),
      assign(F4, "2026-08-01T09:30:00+01:00", "Court 2"),
    ]);
    parse.mockResolvedValueOnce(planResponse(badCourt));
    await expect(runAiPlan(pack, movableIds)).rejects.toMatchObject({ status: 422 });
  });

  it("pinned fixture never moves: reassigning a pinned id (absent from movableIds) is rejected as foreign", async () => {
    const packWithPinned = makePack({
      fixtures: {
        movable: [F1, F2, F3, F4].map((id, i) => ({
          id,
          ext_key: `f${i + 1}`,
          round: 1,
          seq: i,
          pool: null,
          home: E(2 * i + 1),
          away: E(2 * i + 2),
          feeds: { winner_to: null, after: [] },
          current: id === F4 ? { at: "2026-08-01T16:00:00+01:00", court: "Court 1" } : { at: null, court: null },
          pinned: id === F4,
        })),
        obstacles: [],
      },
    });
    const movableIdsWithoutPinned = new Set([F1, F2, F3]);
    const planTouchingPinnedId = plan([
      assign(F1, "2026-08-01T09:00:00+01:00", "Court 1"),
      assign(F2, "2026-08-01T09:00:00+01:00", "Court 2"),
      assign(F3, "2026-08-01T09:30:00+01:00", "Court 1"),
      assign(F4, "2026-08-01T09:30:00+01:00", "Court 2"), // moves the pinned fixture
    ]);
    parse.mockResolvedValueOnce(planResponse(planTouchingPinnedId));
    await expect(runAiPlan(packWithPinned, movableIdsWithoutPinned)).rejects.toMatchObject({ status: 422 });
  });

  it("instruction case finish-by-18:00: a compliant plan passes the verifier and ends ≤ 18:00", async () => {
    parse.mockResolvedValueOnce(planResponse(finishBy18Plan));
    const out = await runAiPlan(pack, movableIds);
    expect(out.blocking).toHaveLength(0);
    for (const a of out.proposal) {
      const endMs = new Date(a.scheduled_at).getTime() + 30 * 60_000;
      // 18:00+01:00 == 17:00Z; every match finishes before it.
      expect(endMs).toBeLessThanOrEqual(Date.parse("2026-08-01T18:00:00+01:00"));
    }
  });

  it("diff classifies placed / moved / unchanged / unscheduled against pack.current", async () => {
    const packMixed = makePack({
      fixtures: {
        movable: [
          { id: F1, ext_key: "f1", round: 1, seq: 0, pool: null, home: E(1), away: E(2), feeds: { winner_to: null, after: [] }, current: { at: null, court: null }, pinned: false },
          { id: F2, ext_key: "f2", round: 1, seq: 1, pool: null, home: E(3), away: E(4), feeds: { winner_to: null, after: [] }, current: { at: "2026-08-01T09:00:00+01:00", court: "Court 2" }, pinned: false },
          { id: F3, ext_key: "f3", round: 1, seq: 2, pool: null, home: E(5), away: E(6), feeds: { winner_to: null, after: [] }, current: { at: "2026-08-01T09:30:00+01:00", court: "Court 1" }, pinned: false },
          { id: F4, ext_key: "f4", round: 1, seq: 3, pool: null, home: E(7), away: E(8), feeds: { winner_to: null, after: [] }, current: { at: "2026-08-01T10:00:00+01:00", court: "Court 2" }, pinned: false },
        ],
        obstacles: [],
      },
    });
    const mixed = plan(
      [
        assign(F1, "2026-08-01T11:00:00+01:00", "Court 1"), // placed (had no slot)
        assign(F2, "2026-08-01T09:00:00+01:00", "Court 2"), // unchanged
        assign(F3, "2026-08-01T13:00:00+01:00", "Court 1"), // moved
      ],
      [{ fixture_id: F4, reason: "no room" }], // unscheduled
    );
    parse.mockResolvedValueOnce(planResponse(mixed));
    const out = await runAiPlan(packMixed, movableIds);
    expect(out.diff.placed).toEqual([F1]);
    expect(out.diff.unchanged).toEqual([F2]);
    expect(out.diff.moved).toEqual([F3]);
    expect(out.diff.unscheduled).toEqual([F4]);
  });
});
