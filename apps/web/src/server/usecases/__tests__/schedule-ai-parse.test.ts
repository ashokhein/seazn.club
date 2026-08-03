// #398 acceptance: the two REAL typo-bearing instructions compile to the
// expected constraint sets, symbolic dates are resolved by US and never by the
// model, an uncompilable phrase survives verbatim, and a parse that fails twice
// degrades instead of taking the paid architect run down with it.
import { describe, expect, it, vi } from "vitest";
import { makeClock } from "@seazn/engine/scheduling";
import { HardConstraint } from "@seazn/engine/scheduling";
import type { AiProvider } from "@/server/ai/provider";
import {
  PARSE_TOKEN_CEILING,
  PARSER_PROMPT,
  parseInstruction,
  resolveParsed,
  type RawParsed,
} from "../schedule-ai-parse";

const TZ = "Europe/London";
// 2026-08-03 is a Monday. From here `tomorrow` is 2026-08-04 and the next FRI
// is 2026-08-07 — both resolved by the clock, never by the model.
const NOW = Date.parse("2026-08-03T09:00:00Z");
const CLOCK = makeClock(NOW, TZ);
const WEEK = { start: "2026-08-03T00:00:00.000Z", end: "2026-08-09T22:59:59.000Z" };
const CTX = { divisions: [{ id: "d1", name: "Open Singles" }], pools: [], entrants: [] };

/** A provider that answers with a scripted body per call. `null` models the
 *  adapter's schema-invalid path, which returns null rather than throwing. */
const stub = (bodies: (unknown | null)[], outputTokens = 300): AiProvider => {
  let i = 0;
  return {
    id: "anthropic",
    isConfigured: () => true,
    chat: vi.fn(async () => {
      const body = bodies[Math.min(i, bodies.length - 1)];
      i += 1;
      return {
        parsed: body as never,
        assistantTurn: { role: "assistant" as const, content: {} },
        usage: { inputTokens: 100, outputTokens, costUsd: null },
        servedModel: "stub-model",
        refused: false,
      };
    }),
  };
};

// The expected compilation of real instruction A.
const A_OUT: RawParsed = {
  hard: [
    { type: "max_fixtures_per_day", count: 2, scope: { kind: "competition" } },
    { type: "min_rest_minutes", minutes: 45, rest_scope: "both", scope: { kind: "competition" } },
    {
      type: "window",
      start: { kind: "tomorrow" },
      end: { kind: "weekday", weekday: "FRI" },
      scope: { kind: "competition" },
    },
  ],
  soft: [],
  unparsed: [],
};

// The expected compilation of real instruction B.
const B_OUT: RawParsed = {
  hard: [
    { type: "min_rest_minutes", minutes: 40, rest_scope: "both", scope: { kind: "competition" } },
    {
      type: "fixture_on_weekday",
      selector: { kind: "terminal" },
      weekday: "FRI",
      scope: { kind: "competition" },
    },
  ],
  soft: [],
  unparsed: [],
};

describe("PARSER_PROMPT", () => {
  it("forbids the model from resolving dates and shows both real examples", () => {
    expect(PARSER_PROMPT).toContain("NEVER resolve dates yourself");
    expect(PARSER_PROMPT).toContain("You have no calendar");
    expect(PARSER_PROMPT).toContain("hav a gap 45 mins at at least");
    expect(PARSER_PROMPT).toContain("at least have 40 mins gap for each player");
  });

  it("teaches that 'at least' is a LOWER bound and that terminal means the final", () => {
    expect(PARSER_PROMPT).toContain("LOWER BOUND");
    expect(PARSER_PROMPT).toContain('"terminal"');
  });

  it("never offers the model a round-number selector", () => {
    expect(PARSER_PROMPT).not.toContain('"round"');
  });
});

describe("parseInstruction", () => {
  it("compiles real instruction A", async () => {
    const out = await parseInstruction(
      "schedule two matches per day and hav a gap 45 mins at at least and run a whole matches from tomorrow till Friday.",
      CTX,
      { provider: stub([A_OUT]) },
    );
    expect(out.failed).toBe(false);
    expect(out.raw?.hard).toEqual(A_OUT.hard);
    expect(out.tokens).toBe(300);
    expect(out.servedModel).toBe("stub-model");
  });

  it("compiles real instruction B", async () => {
    const out = await parseInstruction(
      "at least have 40 mins gap for each player in the next round and schedule final on friday.",
      CTX,
      { provider: stub([B_OUT]) },
    );
    expect(out.failed).toBe(false);
    expect(out.raw?.hard).toEqual(B_OUT.hard);
  });

  it("sends the instruction and the context, and nothing else", async () => {
    const provider = stub([B_OUT]);
    await parseInstruction("final on friday", CTX, { provider });
    const req = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: { role: string; content: unknown }[];
    };
    expect(JSON.parse(req.messages[0]!.content as string)).toEqual({
      instruction: "final on friday",
      context: CTX,
    });
  });

  it("retries ONCE on schema-invalid output, then succeeds", async () => {
    const provider = stub([null, B_OUT]);
    const out = await parseInstruction("…", CTX, { provider });
    expect(out.failed).toBe(false);
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it("fails soft after two schema misses — never throws, never guesses", async () => {
    const provider = stub([null, null]);
    const out = await parseInstruction("…", CTX, { provider });
    expect(out.failed).toBe(true);
    expect(out.raw).toBeNull();
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it("meters a failed round too — an un-metered miss is a budget leak", async () => {
    const out = await parseInstruction("…", CTX, { provider: stub([null, null], 120) });
    expect(out.tokens).toBe(240);
  });

  it("fails soft when the provider throws, so the architect run survives", async () => {
    const provider: AiProvider = {
      id: "anthropic",
      isConfigured: () => true,
      chat: vi.fn(async () => {
        throw new Error("upstream 529");
      }),
    };
    await expect(parseInstruction("…", CTX, { provider })).resolves.toMatchObject({
      failed: true,
      raw: null,
    });
  });

  it("stops on an outright refusal rather than spending the retry", async () => {
    const provider: AiProvider = {
      id: "anthropic",
      isConfigured: () => true,
      chat: vi.fn(async () => ({
        parsed: null,
        assistantTurn: { role: "assistant" as const, content: {} },
        usage: { inputTokens: 10, outputTokens: 5, costUsd: null },
        servedModel: "stub-model",
        refused: true,
      })),
    };
    const out = await parseInstruction("…", CTX, { provider });
    expect(out.failed).toBe(true);
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it("skips the call entirely when the provider is unconfigured", async () => {
    const provider: AiProvider = { id: "anthropic", isConfigured: () => false, chat: vi.fn() };
    const out = await parseInstruction("…", CTX, { provider });
    expect(out.failed).toBe(true);
    expect(out.tokens).toBe(0);
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("caps its own round at PARSE_TOKEN_CEILING", async () => {
    const provider = stub([B_OUT]);
    await parseInstruction("…", CTX, { provider });
    const req = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { maxTokens: number };
    expect(PARSE_TOKEN_CEILING).toBe(1_000);
    expect(req.maxTokens).toBeLessThanOrEqual(PARSE_TOKEN_CEILING);
  });

  it("clamps the retry to what is LEFT of its own ceiling", async () => {
    const provider = stub([null, B_OUT], 800);
    await parseInstruction("…", CTX, { provider });
    const second = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[1]![0] as { maxTokens: number };
    expect(second.maxTokens).toBe(200);
  });
});

describe("resolveParsed", () => {
  it("resolves tomorrow..FRI against the clock, not the model", () => {
    const r = resolveParsed(A_OUT, CLOCK, WEEK, TZ, { fixtureCount: 4 });
    // 2026-08-04 00:00 London is 2026-08-03T23:00Z (BST).
    expect(r.window.start).toBe("2026-08-03T23:00:00.000Z");
    expect(r.assumptions.some((a) => a.includes("2026-08-04") && a.includes("2026-08-07"))).toBe(true);
  });

  it("does NOT emit the window as a hard constraint — it IS the pack window", () => {
    const r = resolveParsed(A_OUT, CLOCK, WEEK, TZ, { fixtureCount: 4 });
    expect(r.hard.some((h) => (h as { type: string }).type === "window")).toBe(false);
    expect(r.hard.map((h) => h.type).sort()).toEqual(["max_fixtures_per_day", "min_rest_minutes"]);
  });

  it("bumps an infeasible window a week and SAYS SO", () => {
    // 2026-08-04..2026-08-07 is four days; at 2/day that holds 8, not 13.
    const r = resolveParsed(A_OUT, CLOCK, WEEK, TZ, { fixtureCount: 13 });
    expect(r.assumptions.some((a) => a.includes("13") && a.includes("2026-08-14"))).toBe(true);
    expect(r.window.end > "2026-08-13").toBe(true);
  });

  it("does NOT bump a window that already fits", () => {
    const r = resolveParsed(A_OUT, CLOCK, WEEK, TZ, { fixtureCount: 8 });
    expect(r.assumptions.some((a) => a.includes("following week"))).toBe(false);
  });

  it("does NOT bump when no per-day cap bounds the days", () => {
    const noCap: RawParsed = { ...A_OUT, hard: A_OUT.hard.filter((h) => h.type !== "max_fixtures_per_day") };
    const r = resolveParsed(noCap, CLOCK, WEEK, TZ, { fixtureCount: 500 });
    expect(r.assumptions.some((a) => a.includes("following week"))).toBe(false);
  });

  it("reads an end-before-start window as the following week", () => {
    const raw: RawParsed = {
      hard: [
        {
          type: "window",
          start: { kind: "weekday", weekday: "FRI" },
          end: { kind: "tomorrow" },
          scope: { kind: "competition" },
        },
      ],
      soft: [],
      unparsed: [],
    };
    const r = resolveParsed(raw, CLOCK, WEEK, TZ);
    expect(r.assumptions.some((a) => a.includes("following week"))).toBe(true);
  });

  it("resolves a symbolic fixture_on_date without asking the model", () => {
    const raw: RawParsed = {
      hard: [
        {
          type: "fixture_on_date",
          selector: { kind: "terminal" },
          date: { kind: "weekday", weekday: "FRI" },
          scope: { kind: "competition" },
        },
      ],
      soft: [],
      unparsed: [],
    };
    const r = resolveParsed(raw, CLOCK, WEEK, TZ);
    expect(r.hard[0]).toMatchObject({ type: "fixture_on_date", date: "2026-08-07" });
  });

  it("records the weekday reading it made for a weekday target", () => {
    const r = resolveParsed(B_OUT, CLOCK, WEEK, TZ);
    expect(r.assumptions.some((a) => a.includes("FRI") && a.includes("2026-08-07"))).toBe(true);
  });

  it("keeps uncompilable wording verbatim and invents no rule from it", () => {
    const raw: RawParsed = { hard: [], soft: [], unparsed: ["keep the mornings relaxed pls"] };
    const r = resolveParsed(raw, CLOCK, WEEK, TZ);
    expect(r.unparsed).toEqual(["keep the mornings relaxed pls"]);
    expect(r.hard).toEqual([]);
  });

  it("carries soft preferences through untouched", () => {
    const raw: RawParsed = { hard: [], soft: [{ note: "finals late", weight: 2 }], unparsed: [] };
    expect(resolveParsed(raw, CLOCK, WEEK, TZ).soft).toEqual([{ note: "finals late", weight: 2 }]);
  });

  it("falls back to the default window and assumes nothing when the parse failed", () => {
    const r = resolveParsed(null, CLOCK, WEEK, TZ);
    expect(r.window).toEqual(WEEK);
    expect(r.hard).toEqual([]);
    expect(r.assumptions).toEqual([]);
    expect(r.unparsed).toEqual([]);
  });

  it("every resolved constraint is a valid engine HardConstraint", () => {
    const r = resolveParsed(A_OUT, CLOCK, WEEK, TZ, { fixtureCount: 4 });
    expect(r.hard.length).toBeGreaterThan(0);
    for (const h of r.hard) expect(HardConstraint.safeParse(h).success).toBe(true);
  });

  it("is deterministic — same inputs, byte-identical output", () => {
    const a = resolveParsed(A_OUT, CLOCK, WEEK, TZ, { fixtureCount: 13 });
    const b = resolveParsed(A_OUT, CLOCK, WEEK, TZ, { fixtureCount: 13 });
    expect(a).toEqual(b);
  });
});
