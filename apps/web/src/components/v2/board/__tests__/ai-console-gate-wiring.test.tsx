// W5 (#400) Task 6b — the confirm gate where the REQUEST is made.
//
// The wave's headline guarantee is that a run cannot be POSTed until the
// organiser has read what their sentence compiles to and agreed to it. That
// guarantee has two halves, and only one of them was pinned:
//
//   * the JSX half — the brief step renders the receipt card instead of the run
//     button — which `ai-console-preview-gate.test.ts` covers through `canRun`;
//   * the CALLBACK half — `run()` re-checks `canRun` before it calls the api,
//     because a `disabled` attribute is a hint and the money is spent by the
//     fetch, not by the button.
//
// Deleting the second one left all 47 tests of this feature green: the reducer
// suite never calls `run`, and no static render can. So this drives the real
// console through the shared hook harness and reads the network it touched.
//
// The assertion is on POSTs only. The console GETs its roster, its last run and
// its schedule settings on mount, and those are free — it is the chargeable
// verb that must not fire.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import type { AiParsePreviewResponse } from "@/server/api-v1/schemas";

/** Every api call the console made, in order, and the answer it gets next. */
const net = vi.hoisted(() => ({
  calls: [] as { url: string; method?: string; json?: unknown }[],
  handler: null as
    | null
    | ((url: string, options?: { method?: string; json?: unknown }) => Promise<unknown>),
}));

// Mocking the module rather than injecting an `api` prop keeps the production
// call sites exactly as they ship — a seam the test supplies is a seam the bug
// could hide behind. `ApiV1Error` stays the REAL class: `instanceof` is how a
// 402 becomes the top-up block rather than a red line.
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string; json?: unknown }) => {
      net.calls.push({ url, method: options?.method, json: options?.json });
      if (!net.handler) return Promise.reject(new Error(`no handler for ${url}`));
      return net.handler(url, options);
    },
  };
});

// `usePlural` THROWS outside a DictProvider and the harness has no provider
// tree. The real runtime over the real English catalog is the same fallback
// `useMsg` already takes there, so the copy stays the shipped copy.
// #385: the console prices on the rung config the board's RSC resolved, read
// through `useRungConfig`. The hookless harness has no provider tree — its
// `useContext` returns the context DEFAULT, and this context has none on
// purpose — so the hook is replaced with the server-resolved defaults. The
// production guarantee (a missing provider throws) is pinned by
// rung-config-provider.test.tsx, not weakened here.
vi.mock("../rung-config-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../rung-config-provider")>();
  const { resolveRungConfig } = await import("@/lib/ai-rung");
  const config = resolveRungConfig();
  return { ...actual, useRungConfig: () => config };
});

vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  const { plural } = await import("@/lib/i18n-runtime");
  const { messages } = await import("@/lib/messages");
  return {
    ...actual,
    usePlural:
      () => (key: string, count: number, vars?: Record<string, string | number>) =>
        plural(messages, key, count, "en", vars),
  };
});

// `usePathname` is built on React's `use()`, which the harness does not supply
// — and adding it would mean shimming a router context to answer a question the
// console only asks to build two tab hrefs. Neither href is on the path under
// test, so the route is simply stated.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/o/riverside/divisions/d1",
}));

// Static, not dynamic: vitest hoists the `vi.mock` calls above every import.
import { AiConsole } from "../ai-console";

const DIVISION = "00000000-0000-4000-8000-000000000001";
const INSTRUCTION = "at most 2 matches a day";

const PREVIEW: AiParsePreviewResponse = {
  preview_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  failed: false,
  compiled: {
    hard: [{ type: "max_fixtures_per_day", count: 2, scope: { kind: "competition" } }],
    soft: [],
    unparsed: [],
    assumptions: [],
  },
  window: null,
  expires_at: "2026-08-10T12:00:00.000Z",
};

const props: Parameters<typeof AiConsole>[0] = {
  divisionId: DIVISION,
  expectedSeq: 1,
  aiAllowed: true,
  currency: "usd",
  brief: {
    courts: ["Court 1", "Court 2"],
    windows: 1,
    blackouts: 0,
    constraintsSet: false,
    movableFixtures: Array.from({ length: 4 }, (_, i) => ({
      id: `f${i}`,
      scheduled_at: "2026-08-01T10:00:00.000Z",
      court_label: "Court 1",
    })),
    pinned: 0,
    entrants: [
      { id: "e1", name: "Team A" },
      { id: "e2", name: "Team B" },
    ],
    activeEntrants: 2,
    officialsWithBlackout: 0,
  },
  fixtures: [],
  scheduleFrozen: false,
  onClose: () => {},
};

/** The mount GETs, answered so the console settles; every POST is the test's
 *  own business and is answered per case. */
const mountAnswers: Record<string, unknown> = {
  "/api/v1/officials": [],
};

function serve(post: (url: string, body: unknown) => Promise<unknown>) {
  net.handler = (url, options) => {
    if (options?.method === "POST") return post(url, options.json);
    if (url in mountAnswers) return Promise.resolve(mountAnswers[url]);
    return Promise.reject(new Error(`unanswered GET ${url}`));
  };
}

const posts = () => net.calls.filter((c) => c.method === "POST");

/** The brief step, found by the two callbacks only it is handed. The harness
 *  renders one level deep, so this is the ELEMENT — its props are the console's
 *  own wiring, which is exactly what is under test. */
function briefStep(tree: ReactElement[]): ReactElement {
  const el = tree.find(
    (e) => typeof propsOf(e).run === "function" && typeof propsOf(e).preview === "function",
  );
  if (!el) throw new Error("brief step not rendered — the console did not mount");
  return el;
}

type Dispatch = (action: Record<string, unknown>) => void;

describe("AiConsole — the gate at the request site (#400 Task 6b)", () => {
  beforeEach(() => {
    net.calls = [];
    net.handler = null;
  });

  it("makes no POST at all when run() is called before the compile is confirmed", async () => {
    serve(async (url) => {
      throw new Error(`the console POSTed ${url} without a confirmed compile`);
    });
    const island = renderIsland(AiConsole, props);
    const dispatch = propsOf(briefStep(island.tree())).dispatch as Dispatch;
    dispatch({ type: "SET_INSTRUCTION", value: INSTRUCTION });

    // The instruction is long enough and the board is not frozen, so every
    // guard except the confirm is satisfied — this is the confirm's own test.
    await (propsOf(briefStep(island.tree())).run as () => Promise<void>)();

    expect(posts()).toHaveLength(0);
    // Belt and braces on the ONE verb that costs money, in case a future call
    // site reaches the plan route by another method.
    expect(net.calls.map((c) => c.url)).not.toContain(
      `/api/v1/divisions/${DIVISION}/schedule/ai-plan`,
    );
  });

  it("POSTs the plan once the compile has been previewed and confirmed", async () => {
    // The positive discriminator. Without it the test above is satisfied by a
    // console that can never run at all, which would be a far worse bug.
    serve(async (url) => {
      if (url.endsWith("/schedule/ai-preview")) return PREVIEW;
      return { proposal: [], conflicts: [], assumptions: [], credits_spent: 1 };
    });
    const island = renderIsland(AiConsole, props);
    const dispatch = propsOf(briefStep(island.tree())).dispatch as Dispatch;
    dispatch({ type: "SET_INSTRUCTION", value: INSTRUCTION });

    await (propsOf(briefStep(island.tree())).preview as () => Promise<void>)();
    expect(posts().map((c) => c.url)).toEqual([
      `/api/v1/divisions/${DIVISION}/schedule/ai-preview`,
    ]);

    await (propsOf(briefStep(island.tree())).run as () => Promise<void>)();
    const plan = posts().at(-1)!;
    expect(plan.url).toBe(`/api/v1/divisions/${DIVISION}/schedule/ai-plan`);
    // …carrying the id of the compile the organiser actually read, so the
    // server reuses that parse rather than compiling a fresh one inline.
    expect((plan.json as { preview_id?: string }).preview_id).toBe(PREVIEW.preview_id);
  });

  it("makes no POST when the confirmed compile was for a DIFFERENT sentence", async () => {
    // Editing the brief after confirming must not carry the agreement across.
    serve(async (url) => {
      if (url.endsWith("/schedule/ai-preview")) return PREVIEW;
      throw new Error(`the console POSTed ${url} for a sentence nobody confirmed`);
    });
    const island = renderIsland(AiConsole, props);
    const dispatch = propsOf(briefStep(island.tree())).dispatch as Dispatch;
    dispatch({ type: "SET_INSTRUCTION", value: INSTRUCTION });
    await (propsOf(briefStep(island.tree())).preview as () => Promise<void>)();

    dispatch({ type: "SET_INSTRUCTION", value: "nothing before 09:00" });
    await (propsOf(briefStep(island.tree())).run as () => Promise<void>)();

    expect(posts().map((c) => c.url)).toEqual([
      `/api/v1/divisions/${DIVISION}/schedule/ai-preview`,
    ]);
  });

  // The compile itself is free but not weightless: it takes a rate-limit slot
  // and an affordability check against a run that a frozen board will refuse.
  // `preview()` guarded on length and busy but not on the freeze — only the
  // button's `disabled` attribute stopped it, and that is a hint, not a
  // guarantee (#400 Task 6b).
  it("makes no POST when the board is frozen, even if the compile is requested", async () => {
    serve(async (url) => {
      throw new Error(`the console POSTed ${url} on a frozen board`);
    });
    const island = renderIsland(AiConsole, { ...props, scheduleFrozen: true });
    const dispatch = propsOf(briefStep(island.tree())).dispatch as Dispatch;
    dispatch({ type: "SET_INSTRUCTION", value: INSTRUCTION });

    await (propsOf(briefStep(island.tree())).preview as () => Promise<void>)();
    await (propsOf(briefStep(island.tree())).run as () => Promise<void>)();

    expect(posts()).toHaveLength(0);
  });
});
