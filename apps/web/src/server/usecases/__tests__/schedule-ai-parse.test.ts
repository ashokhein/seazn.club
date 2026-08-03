// #398 acceptance: the two REAL typo-bearing instructions compile to the
// expected constraint sets, symbolic dates are resolved by US and never by the
// model, an uncompilable phrase survives verbatim, and a parse that fails twice
// degrades instead of taking the paid architect run down with it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeClock } from "@seazn/engine/scheduling";
import { HardConstraint } from "@seazn/engine/scheduling";
import type { AiProvider } from "@/server/ai/provider";
import {
  PARSE_TOKEN_CEILING,
  PARSE_TOKENS_PER_ATTEMPT,
  PARSER_PROMPT,
  parseInstruction,
  parserAiModel,
  resolveParsed,
  RawParsed,
  type DateRef,
} from "../schedule-ai-parse";

// Every test below passes its provider in explicitly; this mock exists only so
// the ONE test that does not can see which provider the compiler asked for.
const { resolveProviderMock } = vi.hoisted(() => ({ resolveProviderMock: vi.fn() }));
vi.mock("@/server/ai/select-provider", () => ({
  resolveProvider: resolveProviderMock,
  selectProvider: () => resolveProviderMock("anthropic"),
}));

const TZ = "Europe/London";
// 2026-08-03 is a Monday. From here `tomorrow` is 2026-08-04 and the next FRI
// is 2026-08-07 — both resolved by the clock, never by the model.
const NOW = Date.parse("2026-08-03T09:00:00Z");
const CLOCK = makeClock(NOW, TZ);
// Divisions ONLY. The parser's `Scope` cannot express an entrant or a pool, so
// showing the model entrant names would only teach it to invent ids that bind
// to nothing — see the `Scope` comment in schedule-ai-parse.ts.
const CTX = { divisions: [{ id: "d1", name: "Open Singles" }] };

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

  it("caps each round at PARSE_TOKENS_PER_ATTEMPT, under the run's own ceiling", async () => {
    const provider = stub([B_OUT]);
    await parseInstruction("…", CTX, { provider });
    const req = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { maxTokens: number };
    // Strictly under half the ceiling, or a first attempt that truncated leaves
    // nothing for the retry it just proved it needs.
    expect(PARSE_TOKENS_PER_ATTEMPT * 2).toBeLessThanOrEqual(PARSE_TOKEN_CEILING);
    expect(req.maxTokens).toBeLessThanOrEqual(PARSE_TOKENS_PER_ATTEMPT);
  });

  it("clamps the retry to what is LEFT of its own ceiling", async () => {
    const provider = stub([null, B_OUT], 1_800);
    await parseInstruction("…", CTX, { provider });
    const second = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[1]![0] as { maxTokens: number };
    expect(second.maxTokens).toBe(PARSE_TOKEN_CEILING - 1_800);
  });
});

describe("resolveParsed", () => {
  it("resolves tomorrow..FRI against the clock, not the model", () => {
    const r = resolveParsed(A_OUT, CLOCK, TZ, { fixtureCount: 4 });
    // 2026-08-04 00:00 London is 2026-08-03T23:00Z (BST) — a wall-clock day
    // boundary in the org zone, never startMs + 86_400_000.
    expect(new Date(r.windowMs!.from).toISOString()).toBe("2026-08-03T23:00:00.000Z");
    // Inclusive end: the last whole second of Friday 2026-08-07.
    expect(new Date(r.windowMs!.to).toISOString()).toBe("2026-08-07T22:59:59.000Z");
    expect(r.assumptions.some((a) => a.includes("2026-08-04") && a.includes("2026-08-07"))).toBe(true);
  });

  it("does NOT emit the window as a hard constraint — it IS the pack window", () => {
    const r = resolveParsed(A_OUT, CLOCK, TZ, { fixtureCount: 4 });
    expect(r.windowMs).not.toBeNull();
    expect(r.hard.some((h) => (h as { type: string }).type === "window")).toBe(false);
    expect(r.hard.map((h) => h.type).sort()).toEqual(["max_fixtures_per_day", "min_rest_minutes"]);
  });

  it("bumps an infeasible window a week and SAYS SO", () => {
    // 2026-08-04..2026-08-07 is four days; at 2/day that holds 8, not 13.
    const r = resolveParsed(A_OUT, CLOCK, TZ, { fixtureCount: 13 });
    expect(r.assumptions.some((a) => a.includes("13") && a.includes("2026-08-14"))).toBe(true);
    expect(new Date(r.windowMs!.to).toISOString()).toBe("2026-08-14T22:59:59.000Z");
  });

  it("does NOT bump a window that already fits", () => {
    const r = resolveParsed(A_OUT, CLOCK, TZ, { fixtureCount: 8 });
    expect(r.assumptions.some((a) => a.includes("following week"))).toBe(false);
  });

  it("does NOT bump when no per-day cap bounds the days", () => {
    const noCap: RawParsed = { ...A_OUT, hard: A_OUT.hard.filter((h) => h.type !== "max_fixtures_per_day") };
    const r = resolveParsed(noCap, CLOCK, TZ, { fixtureCount: 500 });
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
    const r = resolveParsed(raw, CLOCK, TZ);
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
    const r = resolveParsed(raw, CLOCK, TZ);
    expect(r.hard[0]).toMatchObject({ type: "fixture_on_date", date: "2026-08-07" });
  });

  it("records the weekday reading it made for a weekday target", () => {
    const r = resolveParsed(B_OUT, CLOCK, TZ);
    expect(r.assumptions.some((a) => a.includes("FRI") && a.includes("2026-08-07"))).toBe(true);
  });

  it("states no window when the instruction stated none", () => {
    const raw: RawParsed = { hard: [], soft: [], unparsed: [] };
    expect(resolveParsed(raw, CLOCK, TZ).windowMs).toBeNull();
  });

  it("keeps uncompilable wording verbatim and invents no rule from it", () => {
    const raw: RawParsed = { hard: [], soft: [], unparsed: ["keep the mornings relaxed pls"] };
    const r = resolveParsed(raw, CLOCK, TZ);
    expect(r.unparsed).toEqual(["keep the mornings relaxed pls"]);
    expect(r.hard).toEqual([]);
  });

  it("carries soft preferences through untouched", () => {
    const raw: RawParsed = { hard: [], soft: [{ note: "finals late", weight: 2 }], unparsed: [] };
    expect(resolveParsed(raw, CLOCK, TZ).soft).toEqual([{ note: "finals late", weight: 2 }]);
  });

  it("states no window and assumes nothing when the parse failed", () => {
    const r = resolveParsed(null, CLOCK, TZ);
    expect(r.windowMs).toBeNull();
    expect(r.hard).toEqual([]);
    expect(r.assumptions).toEqual([]);
    expect(r.unparsed).toEqual([]);
  });

  it("every resolved constraint is a valid engine HardConstraint", () => {
    const r = resolveParsed(A_OUT, CLOCK, TZ, { fixtureCount: 4 });
    expect(r.hard.length).toBeGreaterThan(0);
    for (const h of r.hard) expect(HardConstraint.safeParse(h).success).toBe(true);
  });

  it("is deterministic — same inputs, byte-identical output", () => {
    const a = resolveParsed(A_OUT, CLOCK, TZ, { fixtureCount: 13 });
    const b = resolveParsed(A_OUT, CLOCK, TZ, { fixtureCount: 13 });
    expect(a).toEqual(b);
  });

  const win = (start: DateRef, end: DateRef, scope: RawParsed["hard"][number]["scope"]): RawParsed => ({
    hard: [{ type: "window", start, end, scope }],
    soft: [],
    unparsed: [],
  });

  it("refuses a division-scoped date range instead of clamping the whole run", () => {
    // The pack has ONE calendar. Applied as the run's window, a range meant for
    // one division silently shortens every other division's.
    const r = resolveParsed(
      win({ kind: "tomorrow" }, { kind: "weekday", weekday: "FRI" }, { kind: "division", divisionId: "d1" }),
      CLOCK,
      TZ,
    );
    expect(r.windowMs).toBeNull();
    expect(r.unparsed).toHaveLength(1);
    expect(r.unparsed[0]).toContain("one division");
  });

  it("keeps the FIRST of two date ranges and reports the rest, rather than last-wins", () => {
    const raw: RawParsed = {
      hard: [
        ...win({ kind: "tomorrow" }, { kind: "weekday", weekday: "FRI" }, { kind: "competition" }).hard,
        ...win(
          { kind: "date", date: "2026-09-01" },
          { kind: "date", date: "2026-09-30" },
          { kind: "competition" },
        ).hard,
      ],
      soft: [],
      unparsed: [],
    };
    const r = resolveParsed(raw, CLOCK, TZ);
    // 2026-08-04 (tomorrow) .. 2026-08-07 (next FRI) — the first range.
    expect(r.assumptions.some((a) => a.includes("2026-08-04..2026-08-07"))).toBe(true);
    expect(r.assumptions.some((a) => a.includes("2026-09"))).toBe(false);
    expect(r.unparsed.some((u) => u.includes("more than one date range"))).toBe(true);
  });

  it("rolls a far-future inverted range by whole weeks until it is non-empty", () => {
    // A single +7 still lands before the start when the start is months out. The
    // old behaviour produced a window whose end preceded its start.
    const r = resolveParsed(
      win({ kind: "date", date: "2026-12-01" }, { kind: "weekday", weekday: "FRI" }, { kind: "competition" }),
      CLOCK,
      TZ,
    );
    expect(r.windowMs).not.toBeNull();
    expect(r.windowMs!.to).toBeGreaterThan(r.windowMs!.from);
  });

  it("does NOT extend the run's window on a DIVISION-scoped per-day cap", () => {
    // The feasibility bump asks "can the run fit in these days?". A cap that
    // binds one division is no evidence the RUN needs another week.
    const raw: RawParsed = {
      hard: [
        { type: "max_fixtures_per_day", count: 1, scope: { kind: "division", divisionId: "d1" } },
        ...win({ kind: "tomorrow" }, { kind: "tomorrow" }, { kind: "competition" }).hard,
      ],
      soft: [],
      unparsed: [],
    };
    const r = resolveParsed(raw, CLOCK, TZ, { fixtureCount: 13 });
    expect(r.assumptions.some((a) => a.includes("holds only"))).toBe(false);
    // ...and the competition-scoped twin still does, so the bump is not simply off.
    const wide: RawParsed = {
      ...raw,
      hard: [{ type: "max_fixtures_per_day", count: 1, scope: { kind: "competition" } }, ...raw.hard.slice(1)],
    };
    expect(resolveParsed(wide, CLOCK, TZ, { fixtureCount: 13 }).assumptions.some((a) => a.includes("holds only"))).toBe(
      true,
    );
  });

  it("does not describe a weekday target as pinned to one date", () => {
    // The verifier compares the weekday of the day a fixture landed on, so ANY
    // matching weekday satisfies the rule. An assumption promising a single
    // resolved date describes a rule nothing enforces.
    const r = resolveParsed(B_OUT, CLOCK, TZ);
    const line = r.assumptions.find((a) => a.includes("FRI"));
    expect(line).toBeDefined();
    expect(line).not.toContain("resolved against the window");
  });
});

describe("pre-flight plumbing (#398)", () => {
  afterEach(() => {
    delete process.env.SCHEDULING_PARSE_MODEL;
    resolveProviderMock.mockReset();
  });

  it("picks the provider from the MODEL, not from the global AI_PROVIDER", async () => {
    // `parserAiModel()` returns a bare Anthropic id. Resolved off AI_PROVIDER,
    // that id goes to OpenRouter as a 404 under AI_PROVIDER=openrouter — and
    // this function's own catch swallows it, so every run would silently compile
    // to no rules with nothing in the logs to say why.
    resolveProviderMock.mockReturnValue(stub([B_OUT]));
    await parseInstruction("final on friday", CTX);
    expect(resolveProviderMock).toHaveBeenCalledWith("anthropic");
    expect(parserAiModel()).not.toContain("/");

    resolveProviderMock.mockClear();
    process.env.SCHEDULING_PARSE_MODEL = "google/gemini-3.6-flash";
    await parseInstruction("final on friday", CTX);
    expect(resolveProviderMock).toHaveBeenCalledWith("openrouter");
  });

  it("still has budget for the corrective retry after a first attempt that spent its cap", async () => {
    // The retry is needed exactly when the first attempt TRUNCATED — which means
    // it spent everything. Sized against a single shared ceiling, `clampRound`
    // returns 0 and the loop breaks without ever retrying.
    const provider = stub([null, B_OUT], PARSE_TOKEN_CEILING / 2);
    const out = await parseInstruction("final on friday", CTX, { provider });
    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(out.failed).toBe(false);
    expect(out.tokens).toBe(PARSE_TOKEN_CEILING);
  });

  it("shows the retry the answer it got wrong", async () => {
    // RETRY_SUFFIX says "your previous answer". With the correction only in the
    // system prompt there is no previous answer in the conversation to refer to.
    const provider = stub([null, B_OUT]);
    await parseInstruction("final on friday", CTX, { provider });
    const second = vi.mocked(provider.chat).mock.calls[1]![0];
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1]!.role).toBe("assistant");
    expect(second.messages[2]!.role).toBe("user");
    // The system prompt stays constant across attempts.
    expect(second.system).toBe(vi.mocked(provider.chat).mock.calls[0]![0].system);
  });
});

describe("parser vocabulary limits (#398)", () => {
  it("rejects an entrant-scoped rule outright — the model is never shown entrant ids", () => {
    const bad = {
      hard: [{ type: "max_fixtures_per_day", count: 2, scope: { kind: "entrant", entrantId: "e1" } }],
      soft: [],
      unparsed: [],
    };
    expect(RawParsed.safeParse(bad).success).toBe(false);
  });

  it("tells the model that a per-player cap is NOT max_fixtures_per_day", () => {
    // Without this the model's only landing spot for "no player plays more than
    // twice a day" is a board-wide cap — a drastically different, wrong rule.
    expect(PARSER_PROMPT).toMatch(/PER-PLAYER/);
    expect(PARSER_PROMPT).toMatch(/unparsed VERBATIM/);
  });

  it("does not advertise a scope it cannot be given the ids for", () => {
    expect(PARSER_PROMPT).not.toMatch(/"kind":"entrant"/);
    expect(PARSER_PROMPT).not.toMatch(/"kind":"pool"/);
  });
});
