// The JOINT console's WIRING — the arguments, not the functions.
//
// `jointRunBody` and `runJointPlan` are both pinned by their own suite, and
// `JointReviewStep` is pinned by rendering it with raw inputs. None of that
// touches the two lines where the console hands those functions their
// arguments, and that is where the money bug lives:
//
//     runJointPlan({ competitionId, selected, instruction, rungs, prior }, …)
//
// Replacing `selected` with every division on the board and `rungs` with `{}`
// left the whole suite green — the receipt prices two divisions at the picked
// rungs while the request runs four at the server's own prediction, and the
// server charges from the request. A test that is HANDED `selected` and `rungs`
// cannot see it; only one that makes the console compute them can.
//
// So this drives the real component: pick a rung on the receipt, type a brief,
// click the CTA, and read the body that reached the api. Same for the review
// step's props — `error`, `running` and `undoFailed` were all inert-able green
// at the mount, so C-1's affordance, I-1's disclosure and I-5's naming could
// each be unwired without a single red.
//
// There is no DOM here (vitest `environment: "node"`, no jsdom), so the clicks
// go through the shared hook harness — see components/__tests__/_hook-harness.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import type { AiCompetitionPlanResponse } from "@/server/api-v1/schemas";

/** Every api call the console made, in order, and the answer it gets next. */
const net = vi.hoisted(() => ({
  calls: [] as { url: string; method?: string; json?: unknown }[],
  handler: null as
    | null
    | ((url: string, options?: { method?: string; json?: unknown }) => Promise<unknown>),
}));

// The console reaches the network through `runJointPlan`/`applyJointPlan`,
// which default their injected api seam to `apiV1`. Mocking the module rather
// than adding a prop keeps the production call sites exactly as they ship —
// a seam the test supplies is a seam the mutation could be hidden behind.
// `ApiV1Error` stays the REAL class: `instanceof` is how a 402 becomes the
// top-up block rather than a red line.
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

// `usePlural` THROWS outside a DictProvider, and the harness renders one
// component with no provider tree. This is the same fallback `useMsg` already
// takes there — the real runtime over the real English catalog — so the copy
// the console builds is still the shipped copy.
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

// Static, not dynamic: vitest hoists the `vi.mock` calls above every import in
// the file, so these already see the mocked modules.
import { ApiV1Error } from "@/lib/client-v1";
import { AiCompetitionConsole, JointReviewStep, type JointDivision } from "../ai-competition-console";
import { jointRunBody } from "../ai-joint-run";
import { AiQuoteCard } from "../ai-quote-card";

/**
 * Four divisions, of which exactly TWO can join a run. The gap is the point:
 * `selected` (d1, d2) is a strict subset of `divisions` (d1..d4), so a request
 * widened to the whole board is visible in the body rather than identical to it.
 */
const DIVISIONS: JointDivision[] = [
  {
    id: "d1",
    name: "Under 12s",
    seq: 4,
    scheduleLocked: false,
    courts: ["Court 1", "Court 2"],
    tz: "Europe/London",
    personClashBlocks: false,
    movableFixtures: 8,
    activeEntrants: 6,
  },
  {
    id: "d2",
    name: "Under 14s",
    seq: 11,
    scheduleLocked: false,
    courts: ["Court 1", "Court 3"],
    tz: "Europe/London",
    personClashBlocks: true,
    movableFixtures: 120,
    activeEntrants: 40,
  },
  // Nothing to place.
  {
    id: "d3",
    name: "Under 16s",
    seq: 2,
    scheduleLocked: false,
    courts: ["Court 1"],
    tz: "Europe/London",
    personClashBlocks: false,
    movableFixtures: 0,
    activeEntrants: 12,
  },
  // Frozen.
  {
    id: "d4",
    name: "Masters",
    seq: 9,
    scheduleLocked: true,
    courts: ["Court 1"],
    tz: "Europe/London",
    personClashBlocks: false,
    movableFixtures: 30,
    activeEntrants: 10,
  },
];

const BRIEF = "Finish every division by 6pm.";

const PLAN = {
  proposal: [
    {
      fixture_id: "f1",
      scheduled_at: "2026-08-01T09:00:00.000Z",
      court_label: "Court 1",
      division_id: "d1",
    },
    {
      fixture_id: "f2",
      scheduled_at: "2026-08-01T10:00:00.000Z",
      court_label: "Court 1",
      division_id: "d2",
    },
  ],
  unschedulable: [],
  warnings: [],
  blocking: [],
  diff: { moved: [], placed: ["f1", "f2"], unscheduled: [], unchanged: [] },
  explanations: [],
  summary: "Two divisions placed on shared courts.",
  divergent_courts: [],
  skipped_divisions: [],
  usage: { input_tokens: 10, output_tokens: 20, repair_rounds: 0 },
  credits: 2,
  divisions: [],
} as unknown as AiCompetitionPlanResponse;

const PLAN_URL = "/api/v1/competitions/c1/schedule/ai-plan";
const APPLY_URL = "/api/v1/competitions/c1/schedule/apply";

/** Let the console's awaited `run`/`doApply`/`undo` chains settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

type ConsoleProps = Parameters<typeof AiCompetitionConsole>[0];

function mount(divisions: JointDivision[] = DIVISIONS, extra: Partial<ConsoleProps> = {}) {
  return renderIsland(AiCompetitionConsole, {
    competitionId: "c1",
    divisions,
    aiAllowed: true,
    currency: "usd" as const,
    fixtures: [],
    onClose: () => {},
    ...extra,
  } as ConsoleProps);
}

/** The element carrying `marker` as a prop — `data-ai-joint-run`, etc. */
const marked = (tree: ReactElement[], marker: string): ReactElement => {
  const el = tree.find((node) => propsOf(node)[marker] !== undefined);
  if (!el) throw new Error(`nothing rendered with ${marker}`);
  return el;
};

const typed = <T,>(tree: ReactElement[], type: T): ReactElement => {
  const el = tree.find((node) => node.type === type);
  if (!el) throw new Error("that component did not render");
  return el;
};

beforeEach(() => {
  net.calls.length = 0;
  net.handler = null;
});

/**
 * A console with a brief typed and d2 down-picked to rung 3 — the two pieces of
 * state the request has to carry, both entered the way an organiser enters
 * them, through the children's own callbacks.
 */
function briefed(extra: Partial<ConsoleProps> = {}) {
  const island = mount(DIVISIONS, extra);
  const type = (value: string) =>
    (
      propsOf(typed(island.tree(), "textarea")).onChange as (e: {
        target: { value: string };
      }) => void
    )({ target: { value } });
  const pickRung = (key: string, rung: number | null) =>
    (propsOf(typed(island.tree(), AiQuoteCard)).onChange as (k: string, r: number | null) => void)(
      key,
      rung,
    );
  const click = (marker: string) => (propsOf(marked(island.tree(), marker)).onClick as () => void)();
  const creditsOnCta = () =>
    propsOf(marked(island.tree(), "data-ai-joint-run"))["data-ai-joint-cta-credits"];
  return { island, type, pickRung, click, creditsOnCta };
}

describe("what the CTA sends is what the receipt priced", () => {
  it("posts the divisions the receipt priced, at the rungs the organiser picked", async () => {
    // THE money assertion. Both halves of the surviving mutation are here: the
    // board has FOUR divisions and only two are in the receipt, and d2 has been
    // moved off its predicted rung. A request built from `divisions` instead of
    // `selected` runs two divisions nobody was quoted for; a request that drops
    // `rungs` sizes d2 from the server's own prediction while the card shows
    // the down-picked number. Both are charged from the request.
    const { type, pickRung, click, creditsOnCta } = briefed();
    net.handler = async () => PLAN;

    type(BRIEF);
    const quoted = creditsOnCta();
    pickRung("d2", 3);
    // The pick reached the PRICE first — otherwise the body below could match
    // a receipt that never moved, and the two would agree about nothing.
    expect(creditsOnCta()).not.toBe(quoted);

    click("data-ai-joint-run");
    await flush();

    expect(net.calls).toHaveLength(1);
    expect(net.calls[0].url).toBe(PLAN_URL);
    expect(net.calls[0].method).toBe("POST");
    expect(net.calls[0].json).toEqual(
      jointRunBody({
        competitionId: "c1",
        selected: ["d1", "d2"],
        instruction: BRIEF,
        rungs: { d2: 3 },
      }),
    );
    // Spelled out, so a change to jointRunBody cannot make both sides agree on
    // something wrong.
    expect(net.calls[0].json).toMatchObject({
      division_ids: ["d1", "d2"],
      instruction: BRIEF,
      mode: "generate",
      rung_overrides: { d2: 3 },
    });
  });

  it("sends the competition the console was mounted on", async () => {
    const { type, click } = briefed();
    net.handler = async () => PLAN;
    type(BRIEF);
    click("data-ai-joint-run");
    await flush();
    expect(net.calls[0].url).toBe(PLAN_URL);
  });

  it("does not send a run the CTA is still refusing", async () => {
    // The gate and the send are the same intent: with no brief typed the CTA
    // is disabled, and nothing has been spent.
    const { island, creditsOnCta } = briefed();
    expect(propsOf(marked(island.tree(), "data-ai-joint-run")).disabled).toBe(true);
    expect(creditsOnCta()).toBe(2);
    expect(net.calls).toHaveLength(0);
  });
});

describe("the review step is wired to the console's own state", () => {
  /** Run once, successfully, so the review step is on screen. */
  async function planned() {
    const ctx = briefed();
    net.handler = async () => PLAN;
    ctx.type(BRIEF);
    ctx.click("data-ai-joint-run");
    await flush();
    net.calls.length = 0;
    return ctx;
  }

  it("hands it the divisions that were run, not every division on the board", async () => {
    const { island } = await planned();
    const step = propsOf(typed(island.tree(), JointReviewStep));
    expect(step.selected).toEqual(["d1", "d2"]);
    expect(step.plan).toBe(PLAN);
  });

  it("tells it a re-run is in flight, which is the whole affordance against a second charge", async () => {
    const { island } = await planned();
    let settle: ((v: unknown) => void) | null = null;
    net.handler = () => new Promise((resolve) => (settle = resolve as (v: unknown) => void));

    (propsOf(typed(island.tree(), JointReviewStep)).onReRun as () => void)();
    await flush();
    // Still open: the button must be showing a spinner, not an idle "re-run".
    expect(propsOf(typed(island.tree(), JointReviewStep)).running).toBe(true);
    expect(net.calls).toHaveLength(1);

    (settle as unknown as (v: unknown) => void)(PLAN);
    await flush();
    expect(propsOf(typed(island.tree(), JointReviewStep)).running).toBe(false);
  });

  it("re-runs as a REFINE over the proposal on screen", async () => {
    // The stale-board recovery is the only path that passes a prior, and it has
    // to be the plan the organiser is looking at — a generate here throws away
    // the work being recovered and charges full price for it.
    const { island } = await planned();
    net.handler = async () => PLAN;
    (propsOf(typed(island.tree(), JointReviewStep)).onReRun as () => void)();
    await flush();
    expect(net.calls[0].json).toMatchObject({
      mode: "refine",
      prior: {
        instruction: BRIEF,
        assignments: [
          {
            fixture_id: "f1",
            scheduled_at: "2026-08-01T09:00:00.000Z",
            court_label: "Court 1",
            division_id: "d1",
          },
          {
            fixture_id: "f2",
            scheduled_at: "2026-08-01T10:00:00.000Z",
            court_label: "Court 1",
            division_id: "d2",
          },
        ],
      },
    });
  });

  it("hands it the error a failed re-run produced, so the refusal is not silent", async () => {
    // `run()` leaves the plan in place on failure, so without this prop reaching
    // the step a 429 changed nothing on screen and the old proposal went on
    // looking successful.
    const { island } = await planned();
    net.handler = async () => {
      throw new ApiV1Error("nope", 429, "RATE_LIMITED");
    };
    (propsOf(typed(island.tree(), JointReviewStep)).onReRun as () => void)();
    await flush();

    const step = propsOf(typed(island.tree(), JointReviewStep));
    expect(step.error).toEqual({
      key: "board.ai.error.rateLimited",
      message: expect.any(String),
    });
    expect((step.error as { message: string }).message).not.toBe("board.ai.error.rateLimited");
    // The plan is still there — this is a failed re-run, not a discarded one.
    expect(step.plan).toBe(PLAN);
  });

  it("names the divisions a partial undo could not revert", async () => {
    // The step renders these ids as division NAMES and retries exactly them.
    // An empty array at the mount turns the amber panel's list into nothing and
    // the retry into a no-op, with no test to notice.
    const { island } = await planned();
    net.handler = async (url) => {
      if (url.endsWith("/checkpoints")) return { id: `cp-${url.split("/")[4]}` };
      if (url === APPLY_URL) return { applied: 2, conflicts: [] };
      // d2's restore refuses; d1's succeeds.
      if (url === "/api/v1/divisions/d2/restore") throw new ApiV1Error("no", 500, "SERVER_ERROR");
      return {};
    };

    (propsOf(typed(island.tree(), JointReviewStep)).onApply as () => void)();
    await flush();
    expect(propsOf(typed(island.tree(), JointReviewStep)).outcome).toMatchObject({
      status: "applied",
    });

    (propsOf(typed(island.tree(), JointReviewStep)).onUndo as () => void)();
    await flush();
    const step = propsOf(typed(island.tree(), JointReviewStep));
    expect(step.undone).toBe("partial");
    expect(step.undoFailed).toEqual(["d2"]);
  });
});

describe("a stale board is pulled before the recovery button can charge for it again", () => {
  // C-1. `doApply` derives `expected_seq` from the `divisions` PROP. The only
  // thing that re-reads it is a board refresh, and the only trigger for one was
  // `onApplied`, which fires on success alone. So a stale board refused the
  // apply, the review step offered its re-run button, that button SPENT, and the
  // apply that followed re-sent the very same stale seq — 409, again, for money,
  // until the organiser happened to reload the page.
  //
  // The refresh has to arrive between the refusal and the next apply, which is
  // why `onRefetch` here does the thing the real parent does (`router.refresh()`
  // → new `divisions` prop) rather than merely counting calls: a test that
  // re-rendered with fresh seqs by itself would pass with the callback unwired.

  /** The same board, one edit later — d1 and d2 have both moved on. */
  const FRESH: JointDivision[] = DIVISIONS.map((d) =>
    d.id === "d1" ? { ...d, seq: 5 } : d.id === "d2" ? { ...d, seq: 12 } : d,
  );

  /** Checkpoints succeed, the atomic write refuses on a stale seq. */
  function staleBoard() {
    net.handler = async (url) => {
      if (url.endsWith("/checkpoints")) return { id: `cp-${url.split("/")[4]}` };
      if (url === APPLY_URL) throw new ApiV1Error("stale", 409, "SEQ_CONFLICT");
      return PLAN;
    };
  }

  /** A console that has planned once and is sitting on the review step. */
  async function planned(extra: Partial<ConsoleProps> = {}) {
    const ctx = briefed(extra);
    net.handler = async () => PLAN;
    ctx.type(BRIEF);
    ctx.click("data-ai-joint-run");
    await flush();
    net.calls.length = 0;
    return ctx;
  }

  const step = (island: { tree: () => ReactElement[] }) =>
    propsOf(typed(island.tree(), JointReviewStep));

  const seqsSent = (json: unknown) =>
    (json as { divisions: { division_id: string; expected_seq: number }[] }).divisions.map(
      (d) => [d.division_id, d.expected_seq] as const,
    );

  it("refetches the board when the apply is refused as stale", async () => {
    const onRefetch = vi.fn();
    const onApplied = vi.fn();
    const { island } = await planned({ onRefetch, onApplied });
    staleBoard();

    (step(island).onApply as () => void)();
    await flush();

    expect(step(island).outcome).toMatchObject({ status: "seq_conflict" });
    expect(onRefetch).toHaveBeenCalledTimes(1);
    // Not the success path: `onApplied` is what the applied board uses, and
    // firing it here would tell the page a write landed that never did.
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("leaves the board alone when the apply lands", async () => {
    // The other side of the same wire. Without this, `onRefetch?.()` moved up
    // out of the branch and fired on every outcome would still be green above.
    const onRefetch = vi.fn();
    const onApplied = vi.fn();
    const { island } = await planned({ onRefetch, onApplied });
    net.handler = async (url) => {
      if (url.endsWith("/checkpoints")) return { id: `cp-${url.split("/")[4]}` };
      return { applied: 2, conflicts: [] };
    };

    (step(island).onApply as () => void)();
    await flush();

    expect(step(island).outcome).toMatchObject({ status: "applied" });
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onRefetch).not.toHaveBeenCalled();
  });

  it("does not refetch on a real court clash, which no refresh can fix", async () => {
    const onRefetch = vi.fn();
    const { island } = await planned({ onRefetch });
    net.handler = async (url) => {
      if (url.endsWith("/checkpoints")) return { id: `cp-${url.split("/")[4]}` };
      throw new ApiV1Error("clash", 409, "SCHEDULE_CONFLICT");
    };

    (step(island).onApply as () => void)();
    await flush();

    expect(step(island).outcome).toMatchObject({ status: "conflict" });
    expect(onRefetch).not.toHaveBeenCalled();
  });

  it("re-sends the SEQ the refresh delivered, so the paid recovery loop terminates", async () => {
    // THE money assertion. Apply → 409 → re-run (charged) → apply. If the
    // refusal did not pull the board, the second apply carries the same stale
    // seq as the first and 409s identically — the organiser can go round this
    // three times before the rate limit stops them, paying `max(1, Σ−1)`
    // credits a lap for a plan that cannot land.
    let island: ReturnType<typeof mount> | null = null;
    const onRefetch = vi.fn(() => island?.rerender({
      competitionId: "c1",
      divisions: FRESH,
      aiAllowed: true,
      currency: "usd" as const,
      fixtures: [],
      onClose: () => {},
      onRefetch,
    } as ConsoleProps));

    const ctx = await planned({ onRefetch });
    island = ctx.island;
    staleBoard();

    (step(ctx.island).onApply as () => void)();
    await flush();
    const first = net.calls.find((c) => c.url === APPLY_URL);
    expect(first).toBeDefined();
    expect(seqsSent(first!.json)).toEqual([
      ["d1", 4],
      ["d2", 11],
    ]);

    // The recovery button the review step offers — a fully priced joint run.
    net.calls.length = 0;
    net.handler = async () => PLAN;
    (step(ctx.island).onReRun as () => void)();
    await flush();

    staleBoard();
    (step(ctx.island).onApply as () => void)();
    await flush();
    const second = net.calls.find((c) => c.url === APPLY_URL);
    expect(second).toBeDefined();
    expect(seqsSent(second!.json)).toEqual([
      ["d1", 5],
      ["d2", 12],
    ]);
  });
});
