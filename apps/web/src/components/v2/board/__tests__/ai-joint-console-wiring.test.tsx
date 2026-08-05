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

// Static, not dynamic: vitest hoists the `vi.mock` calls above every import in
// the file, so these already see the mocked modules.
import { ApiV1Error } from "@/lib/client-v1";
import type { AiParsePreviewResponse } from "@/server/api-v1/schemas";
import { AiCompetitionConsole, JointReviewStep, type JointDivision } from "../ai-competition-console";
import { AiInstructionPreview } from "../ai-instruction-preview";
import { jointPreviewBody, jointRunBody } from "../ai-joint-run";
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
const PREVIEW_URL = "/api/v1/competitions/c1/schedule/ai-preview";
const APPLY_URL = "/api/v1/competitions/c1/schedule/apply";
const RESTORE_URL = "/api/v1/competitions/c1/schedule/restore";

/** What stage 1 gives back: the rules the organiser is asked to confirm, and
 *  the token that makes those rules the ones the run enforces. */
const PREVIEW_ID = "0f3a1c26-9f21-4c2e-8f0e-2b7c1f2d4a55";
const COMPILED = {
  preview_id: PREVIEW_ID,
  failed: false,
  compiled: {
    hard: [{ type: "max_fixtures_per_day", count: 2, scope: { kind: "competition" } }],
    soft: [],
    unparsed: [],
    assumptions: [],
  },
  window: null,
  expires_at: "2026-08-03T18:00:00.000Z",
} as unknown as AiParsePreviewResponse;

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
  // W5 (#400) — the card is only on screen once a compile has landed, so
  // `card()` throwing IS the assertion that the gate is closed.
  const card = () => propsOf(typed(island.tree(), AiInstructionPreview));
  const cardShown = () => island.tree().some((node) => node.type === AiInstructionPreview);
  /** The two-stage gate, walked the way an organiser walks it: compile, read,
   *  confirm. Anything that clicks straight through to a charge is not this. */
  const confirm = async () => {
    click("data-ai-joint-run");
    await flush();
    (card().onConfirm as () => void)();
    await flush();
  };
  return { island, type, pickRung, click, creditsOnCta, card, cardShown, confirm };
}

/** Answer the compile with a usable preview, everything else with the plan.
 *  URL-keyed because the console now makes TWO different POSTs for one run. */
const twoStage = (plan: AiCompetitionPlanResponse = PLAN, preview = COMPILED) => {
  net.handler = async (url: string) => (url === PREVIEW_URL ? preview : plan);
};

describe("what the CTA sends is what the receipt priced", () => {
  it("posts the divisions the receipt priced, at the rungs the organiser picked", async () => {
    // THE money assertion. Both halves of the surviving mutation are here: the
    // board has FOUR divisions and only two are in the receipt, and d2 has been
    // moved off its predicted rung. A request built from `divisions` instead of
    // `selected` runs two divisions nobody was quoted for; a request that drops
    // `rungs` sizes d2 from the server's own prediction while the card shows
    // the down-picked number. Both are charged from the request.
    const { type, pickRung, creditsOnCta, confirm } = briefed();
    twoStage();

    type(BRIEF);
    const quoted = creditsOnCta();
    pickRung("d2", 3);
    // The pick reached the PRICE first — otherwise the body below could match
    // a receipt that never moved, and the two would agree about nothing.
    const repriced = creditsOnCta();
    expect(repriced).not.toBe(quoted);

    await confirm();

    // Two calls now, and only the second one spends: the compile, then the run
    // the organiser confirmed off the back of it.
    expect(net.calls).toHaveLength(2);
    expect(net.calls[1].url).toBe(PLAN_URL);
    expect(net.calls[1].method).toBe("POST");
    expect(net.calls[1].json).toEqual(
      jointRunBody({
        competitionId: "c1",
        selected: ["d1", "d2"],
        instruction: BRIEF,
        rungs: { d2: 3 },
        previewId: PREVIEW_ID,
        // #387: the number the CTA is showing, read off the CTA itself rather
        // than restated — the whole point of the field is that the server can
        // compare the charge against what this organiser was actually shown.
        quotedCredits: repriced as number,
      }),
    );
    // Spelled out, so a change to jointRunBody cannot make both sides agree on
    // something wrong.
    expect(net.calls[1].json).toMatchObject({
      division_ids: ["d1", "d2"],
      instruction: BRIEF,
      mode: "generate",
      rung_overrides: { d2: 3 },
      preview_id: PREVIEW_ID,
      quoted_credits: repriced,
    });
  });

  it("sends the competition the console was mounted on", async () => {
    const { type, confirm } = briefed();
    twoStage();
    type(BRIEF);
    await confirm();
    expect(net.calls.map((c) => c.url)).toEqual([PREVIEW_URL, PLAN_URL]);
  });

  it("compiles before it charges, and the first click is the compile", async () => {
    // THE gate, at the wire. One click on a fully valid brief used to be one
    // chargeable run; it is now a stage-1 compile that spends nothing, and the
    // plan endpoint is not touched until the organiser confirms the card.
    const { type, click, cardShown } = briefed();
    twoStage();
    type(BRIEF);

    click("data-ai-joint-run");
    await flush();

    expect(net.calls.map((c) => c.url)).toEqual([PREVIEW_URL]);
    expect(net.calls[0].method).toBe("POST");
    expect(cardShown()).toBe(true);
  });

  it("compiles against the divisions the picker selected, not the whole board", async () => {
    // The resolved WINDOW depends on which divisions are in scope, and Task 2b
    // made a preview minted for a different set a 409 PREVIEW_STALE on the run.
    // So a compile posted without them — or with all four of the board's
    // divisions instead of the two that can run — is a receipt for a different
    // run, and the confirm it invites is one the server will refuse.
    const { type, click, pickRung } = briefed();
    twoStage();
    type(BRIEF);
    pickRung("d2", 3);

    click("data-ai-joint-run");
    await flush();

    // Shape only, and knowingly a tautology: both sides recompute from
    // `jointPreviewBody`, so dropping a field from it drops it from BOTH and
    // this still passes. It pins that the console hands the builder the right
    // ARGUMENTS. The literal below is what pins the fields — do not delete it
    // as redundant, it is the only half of this pair with teeth.
    expect(net.calls[0].json).toEqual(
      jointPreviewBody({
        competitionId: "c1",
        selected: ["d1", "d2"],
        instruction: BRIEF,
        rungs: { d2: 3 },
      }),
    );
    // Spelled out: the board has FOUR divisions and d3/d4 cannot join a run.
    expect(net.calls[0].json).toMatchObject({
      division_ids: ["d1", "d2"],
      instruction: BRIEF,
      rung_overrides: { d2: 3 },
    });
  });

  it("declining the compile fires no request and keeps the brief", async () => {
    // The point of the whole wave: reading what an instruction compiles to and
    // deciding against it costs nothing. Declining is a client action — there
    // is no request to make, so there is nothing to charge for.
    const { island, type, click, card, cardShown } = briefed();
    twoStage();
    type(BRIEF);
    click("data-ai-joint-run");
    await flush();
    net.calls.length = 0;

    (card().onDismiss as () => void)();
    await flush();

    expect(net.calls).toHaveLength(0);
    expect(cardShown()).toBe(false);
    // The sentence they wrote is still on screen, and the CTA has gone back to
    // offering the compile rather than a run nobody confirmed.
    expect(propsOf(typed(island.tree(), "textarea")).value).toBe(BRIEF);
    expect(propsOf(marked(island.tree(), "data-ai-joint-run"))["data-ai-joint-stage"]).toBe("check");
  });

  it("runs unenforced only when the organiser explicitly asks for it", async () => {
    // A compile that failed schema twice carries no reusable token. The card
    // offers the preference fallback and the console must never take it on its
    // own — the run then posts WITHOUT a preview_id, so the server compiles
    // inline and nothing pretends the sentence is enforced.
    const failed = { ...COMPILED, preview_id: undefined, failed: true } as AiParsePreviewResponse;
    const { type, click, card, island } = briefed();
    twoStage(PLAN, failed);
    type(BRIEF);
    click("data-ai-joint-run");
    await flush();

    // Not runnable yet, and there is no run button behind the card to press:
    // the card owns the step until it is answered.
    expect(island.tree().some((n) => propsOf(n)["data-ai-joint-run"] !== undefined)).toBe(false);

    (card().onAsPreference as () => void)();
    await flush();
    expect(net.calls.map((c) => c.url)).toEqual([PREVIEW_URL]);
    // Answering it is what makes the run reachable, and the CTA says which
    // stage it is now on.
    expect(propsOf(marked(island.tree(), "data-ai-joint-run"))["data-ai-joint-stage"]).toBe("run");

    (propsOf(marked(island.tree(), "data-ai-joint-run")).onClick as () => void)();
    await flush();
    expect(net.calls.map((c) => c.url)).toEqual([PREVIEW_URL, PLAN_URL]);
    expect(net.calls[1].json).not.toHaveProperty("preview_id");
  });

  it("refuses to charge on a confirm the gate does not sanction", async () => {
    // The gate has to live in the CALLBACK, not in what the JSX happens to
    // render. `preview_id` is optional on the wire and the card decides which
    // buttons to draw from `failed` — two different fields deciding one
    // question — so a schema-valid `{ failed: false, preview_id: undefined }`
    // reaches a confirm the gate refuses, and `run()` charged for it. That the
    // server always pairs the two today is a server invariant propping up a
    // client guarantee, which is the shape of bug this wave exists to remove.
    //
    // Driven through the card's own `onConfirm` prop rather than a rendered
    // button, so no change to what the card draws can make this vacuous.
    const noId = { ...COMPILED, preview_id: undefined } as AiParsePreviewResponse;
    const { type, click, card } = briefed();
    twoStage(PLAN, noId);
    type(BRIEF);
    click("data-ai-joint-run");
    await flush();

    (card().onConfirm as () => void)();
    await flush();

    expect(net.calls.map((c) => c.url)).toEqual([PREVIEW_URL]);
  });

  it("does not offer a confirm for rules compiled over other divisions", async () => {
    // The client half of PREVIEW_STALE. A compile taken over d1+d2 says nothing
    // about a run over d1 alone, so changing the picker withdraws the card
    // rather than leaving a confirm up for a receipt that no longer applies.
    const { island, type, click, cardShown } = briefed();
    twoStage();
    type(BRIEF);
    click("data-ai-joint-run");
    await flush();
    expect(cardShown()).toBe(true);

    const picker = island.tree().find((n) => propsOf(n).divisions !== undefined);
    (propsOf(picker!).onChange as (ids: string[]) => void)(["d1"]);

    expect(cardShown()).toBe(false);
    expect(net.calls).toHaveLength(1);
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
    twoStage();
    ctx.type(BRIEF);
    await ctx.confirm();
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

  /** Applied over d1 and d2, sitting on the confirmation with both anchors and
   *  a restore handler the caller supplies. */
  async function applied(restore: (json: unknown) => unknown) {
    const ctx = await planned();
    net.handler = async (url, options) => {
      if (url.endsWith("/checkpoints")) return { id: `cp-${url.split("/")[4]}` };
      if (url === APPLY_URL) return { applied: 2, conflicts: [] };
      if (url === RESTORE_URL) return restore(options?.json);
      throw new Error(`unexpected ${url}`);
    };
    (propsOf(typed(ctx.island.tree(), JointReviewStep)).onApply as () => void)();
    await flush();
    expect(propsOf(typed(ctx.island.tree(), JointReviewStep)).outcome).toMatchObject({
      status: "applied",
    });
    net.calls.length = 0;
    const undo = () => (propsOf(typed(ctx.island.tree(), JointReviewStep)).onUndo as () => void)();
    const step = () => propsOf(typed(ctx.island.tree(), JointReviewStep));
    return { ...ctx, undo, step };
  }

  it("names the divisions a partial undo could not revert", async () => {
    // The step renders these ids as division NAMES. An empty array at the mount
    // turns the amber panel's list into nothing, with no test to notice.
    const { undo, step } = await applied(() => ({
      restored: [{ division_id: "d1", watermark: 3, steps: 1 }],
      failed: [{ division_id: "d2", reason: "no such checkpoint" }],
      ok: false,
    }));

    undo();
    await flush();
    expect(step().undone).toBe("partial");
    expect(step().undoFailed).toEqual(["d2"]);
  });

  it("undoes through ONE competition-scoped call, whatever the organiser clicks", async () => {
    // Two assertions in one, and both are regressions the console can cause on
    // its own however correct `undoJointApply` is:
    //
    //   THE LOOP. A second restore url here means the client is back to
    //   restoring per division, which is what let a closed tab leave the board
    //   half-restored.
    //   THE DOUBLE CLICK. `undoing` is state, so a second press inside the same
    //   tick reads it as false and fires again — and the second request races
    //   the first's rewind. The server's competition lock is the backstop for
    //   that; this is the defence, and it must be a ref to work.
    const { undo, step } = await applied(() => ({
      restored: [
        { division_id: "d1", watermark: 3, steps: 1 },
        { division_id: "d2", watermark: 9, steps: 2 },
      ],
      failed: [],
      ok: true,
    }));

    undo();
    undo();
    await flush();

    expect(net.calls.map((c) => c.url)).toEqual([RESTORE_URL]);
    expect(step().undone).toBe("full");
  });

  it("retries with the FULL division set, because a subset is a 422", async () => {
    // The retry used to send back only the divisions that failed, which was
    // right while restore was per division. The competition-scoped endpoint
    // validates the named set against the apply event and refuses a subset, so
    // the old shape is now the one request that CANNOT work — and it would fail
    // as a 422 on the retry only, long after any test of the first attempt.
    let attempt = 0;
    const { undo, step } = await applied(() => {
      attempt += 1;
      return attempt === 1
        ? {
            restored: [{ division_id: "d1", watermark: 3, steps: 1 }],
            failed: [{ division_id: "d2", reason: "boom" }],
            ok: false,
          }
        : {
            restored: [
              { division_id: "d1", watermark: 3, steps: 0 },
              { division_id: "d2", watermark: 9, steps: 2 },
            ],
            failed: [],
            ok: true,
          };
    });

    undo();
    await flush();
    expect(step().undoFailed).toEqual(["d2"]);

    undo();
    await flush();
    const body = net.calls[1].json as { checkpoints: { division_id: string }[] };
    expect(body.checkpoints.map((c) => c.division_id)).toEqual(["d1", "d2"]);
    expect(step().undone).toBe("full");
  });

  it("offers a retry when an undo is ALREADY running, and claims nothing was reverted", async () => {
    // The 409 the competition lock raises. Folded into the generic failure path
    // this reads as "no division was reverted" — which sends the organiser off
    // to undo by hand the very divisions the first undo is mid-rewind on.
    const { undo, step } = await applied(() => {
      throw new ApiV1Error("busy", 409, "SCHEDULE_APPLY_RESTORE_IN_PROGRESS");
    });

    undo();
    await flush();
    expect(step().undoRefusal).toBe("retry");
    // Nothing ran, so the applied board is untouched and no division is named.
    expect(step().undone).toBe("no");
    expect(step().undoFailed).toEqual([]);
  });

  it("tells a stale division set and a missing apply apart from a failed undo", async () => {
    for (const [status, refusal] of [
      [422, "changed"],
      [404, "gone"],
    ] as const) {
      const { undo, step } = await applied(() => {
        throw new ApiV1Error("nope", status, "");
      });
      undo();
      await flush();
      expect(step().undoRefusal).toBe(refusal);
      expect(step().undone).toBe("no");
    }
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
    twoStage();
    ctx.type(BRIEF);
    await ctx.confirm();
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
