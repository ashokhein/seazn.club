// #383 — the officials step must not spend a credit before the organiser has
// seen a price.
//
// The console used to auto-fire the solver draft the moment the officials step
// mounted. That run charges 1 credit (`freeDraftQuote` is a price CAP, not
// zero: "free" means free of MODEL cost), so the organiser was billed before
// any confirm surface rendered — the one credit-spending path in the product
// with no pre-spend surface, and the one they could not decline.
//
// TWO HALVES, and both are needed. The CALLBACK half is driven through the
// shared hook harness: arriving at the step must make no POST, and the run must
// happen when — and only when — the organiser asks for it. The JSX half is a
// static render: the pre-run card has to carry the flat 1-credit price and an
// enabled button, or "they can press it" is a claim about a button nobody can
// reach.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import type { AiOfficialsPlanResponse, AiPlanResponse } from "@/server/api-v1/schemas";

const net = vi.hoisted(() => ({
  calls: [] as { url: string; method?: string; json?: unknown }[],
  handler: null as
    | null
    | ((url: string, options?: { method?: string; json?: unknown }) => Promise<unknown>),
}));

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

// #385: the console prices on the config the board's RSC resolved. The harness
// has no provider tree and this context has no default on purpose, so the hook
// is replaced with the server-resolved defaults here.
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

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/o/riverside/divisions/d1",
}));

import type { Dict } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
import { RungConfigProvider } from "../rung-config-provider";
import { resolveRungConfig } from "@/lib/ai-rung";
import en from "@/dictionaries/en/ui.json";
import { AiConsole, OfficialsStep } from "../ai-console";
import { initialAiConsoleState, type AiConsoleState } from "../ai-console-state";

const DIVISION = "00000000-0000-4000-8000-000000000001";
const OFFICIALS_URL = `/api/v1/divisions/${DIVISION}/officials/ai-plan`;

const dict = en as unknown as Dict;
const enText = en as unknown as Record<string, string>;

const SCHEDULE_PLAN = {
  proposal: [
    { fixture_id: "f0", scheduled_at: "2026-08-01T10:00:00.000Z", court_label: "Court 1" },
  ],
  unschedulable: [],
  warnings: [],
  blocking: [],
  diff: { moved: [], placed: [], unscheduled: [], unchanged: [] },
  explanations: [],
  summary: "ok",
  assumptions: [],
  usage: { input_tokens: 0, output_tokens: 0, repair_rounds: 0 },
  repair: { engine: "none", solver_ran: false },
  officials_coverage: null,
} as unknown as AiPlanResponse;

const OFFICIALS_PLAN = {
  assignments: [{ fixtureId: "f0", officialId: "o1", roleKey: "referee" }],
  conflicts: [],
  diff: { changed: [], unchanged: ["f0"], unfilled: [] },
  lazy_unfilled: [],
  explanations: [],
  summary: "drafted",
  usage: { input_tokens: 0, output_tokens: 0, repair_rounds: 0 },
  credits: 1,
} as unknown as AiOfficialsPlanResponse;

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
    movableFixtures: [{ id: "f0", scheduled_at: "2026-08-01T10:00:00.000Z", court_label: "Court 1" }],
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

const mountAnswers: Record<string, unknown> = { "/api/v1/officials": [] };

function serve(post: (url: string, body: unknown) => Promise<unknown>) {
  net.handler = (url, options) => {
    if (options?.method === "POST") return post(url, options.json);
    if (url in mountAnswers) return Promise.resolve(mountAnswers[url]);
    return Promise.reject(new Error(`unanswered GET ${url}`));
  };
}

const officialsPosts = () => net.calls.filter((c) => c.method === "POST" && c.url === OFFICIALS_URL);

type Dispatch = (action: Record<string, unknown>) => void;

/** The step element carrying `onReplan` — the officials step and nothing else.
 *  The harness renders one level deep, so this IS the console's own wiring. */
function officialsStep(tree: ReactElement[]): ReactElement {
  const el = tree.find((e) => typeof propsOf(e).onReplan === "function");
  if (!el) throw new Error("officials step not rendered");
  return el;
}

/** Any element with a `dispatch` — every step is handed the console's. */
function anyDispatch(tree: ReactElement[]): Dispatch {
  const el = tree.find((e) => typeof propsOf(e).dispatch === "function");
  if (!el) throw new Error("nothing rendered with a dispatch");
  return propsOf(el).dispatch as Dispatch;
}

/** Walk the console to the officials step WITHOUT running anything: a schedule
 *  plan is dispatched straight in, exactly as a completed Phase A would. */
function atOfficialsStep() {
  const island = renderIsland(AiConsole, props);
  const dispatch = anyDispatch(island.tree());
  dispatch({ type: "RUN_DONE", plan: SCHEDULE_PLAN });
  dispatch({ type: "GOTO_STEP", step: "officials" });
  return island;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("AiConsole — the officials draft asks before it spends (#383)", () => {
  beforeEach(() => {
    net.calls = [];
    net.handler = null;
  });

  it("does not spend a credit before the organiser has seen a price", async () => {
    serve(async (url) => {
      throw new Error(`the console POSTed ${url} on arriving at the officials step`);
    });
    const island = atOfficialsStep();
    await flush();

    expect(officialsPosts()).toHaveLength(0);
    // And the step really is mounted — otherwise "no POST" is satisfied by a
    // console that never got there.
    expect(() => officialsStep(island.tree())).not.toThrow();
  });

  it("runs the draft when the organiser asks for it", async () => {
    // The positive discriminator: a console that can never draft at all would
    // pass the test above and be a worse bug than the one being fixed.
    serve(async () => OFFICIALS_PLAN);
    const island = atOfficialsStep();
    await flush();

    await (propsOf(officialsStep(island.tree())).onReplan as () => Promise<void>)();
    expect(officialsPosts()).toHaveLength(1);
    // The free draft: an empty instruction is the server's OWN predicate for
    // the zero-token solver pass and its flat 1-credit price.
    expect((officialsPosts()[0]!.json as { instruction: string }).instruction).toBe("");
  });

  it("a second press while the first run is in flight spends nothing extra", async () => {
    // The double-submit class. `busy` guards `runOfficials` at the request site,
    // not only on the button's `disabled` attribute — a disabled prop is a hint
    // to a pointer and the money is spent by the fetch.
    let release: (v: unknown) => void = () => {};
    serve(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const island = atOfficialsStep();
    await flush();

    const first = (propsOf(officialsStep(island.tree())).onReplan as () => Promise<void>)();
    await flush();
    expect(officialsPosts()).toHaveLength(1);

    await (propsOf(officialsStep(island.tree())).onReplan as () => Promise<void>)();
    expect(officialsPosts()).toHaveLength(1);

    release(OFFICIALS_PLAN);
    await first;
    await flush();
    expect(officialsPosts()).toHaveLength(1);
  });

  it("leaving and re-entering the step does not re-draft, and does not re-charge", async () => {
    serve(async () => OFFICIALS_PLAN);
    const island = atOfficialsStep();
    await flush();
    await (propsOf(officialsStep(island.tree())).onReplan as () => Promise<void>)();
    expect(officialsPosts()).toHaveLength(1);

    const dispatch = anyDispatch(island.tree());
    dispatch({ type: "GOTO_STEP", step: "schedule" });
    await flush();
    dispatch({ type: "GOTO_STEP", step: "officials" });
    await flush();

    expect(officialsPosts()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The JSX half. `renderToStaticMarkup`, the repo's client-component convention.
// ---------------------------------------------------------------------------

function tEn(key: string, vars?: Record<string, string | number>): string {
  const raw = enText[key] ?? key;
  return vars ? raw.replace(/\{(\w+)\}/g, (m, n) => (n in vars ? String(vars[n]) : m)) : raw;
}

function renderStep(over: Partial<AiConsoleState> = {}, busy = false): string {
  return renderToStaticMarkup(
    <RungConfigProvider value={resolveRungConfig()}>
      <DictProvider dict={dict} locale="en">
        {OfficialsStep({
          state: {
            ...initialAiConsoleState,
            step: "officials",
            schedulePlan: SCHEDULE_PLAN,
            ...over,
          } as AiConsoleState,
          dispatch: () => {},
          currency: "usd",
          fixtures: [],
          roster: [],
          policyRoles: ["referee"],
          hadPrior: false,
          busy,
          traceNonce: 0,
          wishes: [],
          onWishes: () => {},
          onReplan: () => {},
          onAdopt: () => {},
          onPulse: () => {},
        })}
      </DictProvider>
    </RungConfigProvider>,
  );
}

/**
 * The run button's own markup — it carries the `.ai-run` class.
 *
 * Cut at its OWN closing tag, not a fixed window: the step-navigation
 * "Continue to apply" button a few hundred characters later is legitimately
 * `disabled` with no plan, and a wider slice makes every disabled-state
 * assertion here pass for the wrong element.
 */
function runButton(html: string): string {
  const marker = html.indexOf("ai-run");
  expect(marker, "the officials step rendered no run button").toBeGreaterThan(-1);
  // From the OPENING TAG: React emits attributes in JSX order, so `disabled`
  // sits before `className` and a slice anchored on the class name cannot see
  // it at all.
  const start = html.lastIndexOf("<button", marker);
  const end = html.indexOf("</button>", marker);
  expect(start, "no opening tag before the run button's class").toBeGreaterThan(-1);
  expect(end, "the run button never closed").toBeGreaterThan(marker);
  return html.slice(start, end);
}

describe("the officials pre-run surface (#383)", () => {
  it("shows the flat 1-credit price before anything has run", () => {
    const html = renderStep();
    // `freeDraftQuote`'s price, unchanged: this task moved the surface, not the
    // arithmetic.
    expect(html).toContain('data-ai-credits="1"');
    expect(html).toContain(tEn("board.ai.quote.freeDraft"));
  });

  it("offers a button the organiser can actually press", () => {
    const btn = runButton(renderStep());
    expect(btn).toContain(tEn("board.ai.officials.run"));
    // The whole point: before #383 this button was `disabled` until a plan
    // existed, and the only thing that produced one was the auto-run.
    //
    // Anchored on the ATTRIBUTE, not the word: the button's class list carries
    // `disabled:cursor-not-allowed disabled:opacity-50`, so a bare substring
    // check passes in both states and pins nothing.
    expect(btn).not.toContain('disabled=""');
  });

  it("disables the button while a run is in flight", () => {
    expect(runButton(renderStep({}, true))).toContain('disabled=""');
  });

  it("goes back to naming the re-plan once a draft exists", () => {
    // The pre-run label belongs to the pre-run state only — an organiser
    // looking at a drafted grid is refining it, not drafting it.
    const btn = runButton(renderStep({ officialsPlan: OFFICIALS_PLAN }));
    expect(btn).not.toContain(tEn("board.ai.officials.run"));
    expect(btn).toContain(tEn("board.ai.officials.replan"));
  });

  it("carries the button label in all four locales", async () => {
    for (const locale of ["en", "es", "fr", "nl"] as const) {
      const d = (await import(`@/dictionaries/${locale}/ui.json`)).default as Record<string, string>;
      expect(d["board.ai.officials.run"], locale).toBeTruthy();
      if (locale !== "en") {
        expect(d["board.ai.officials.run"], locale).not.toBe(enText["board.ai.officials.run"]);
      }
    }
  });
});
