// The JOINT run — the half that SPENDS.
//
// Two things live here that a static render can never see, and both were
// unpinned when the console shipped:
//
//   1. THE GUARD. `POST /schedule/ai-plan` calls `spendCredit` with no
//      idempotency key, a joint plan takes tens of seconds, and the review
//      step's re-run button offered no in-flight state — so a second click was
//      the expected user behaviour, and it charged twice for one intent. A
//      `disabled` attribute is the AFFORDANCE; the guard below is the
//      protection, and it has to hold for a click that beats the re-render.
//   2. THE BODY. The card is priced from `selected` + `rungs`; the REQUEST is
//      what the server charges from. Three mutations of this expression left a
//      fully green suite, the worst of them dropping the organiser's rung picks
//      so the card showed a down-picked price and the server charged its own
//      prediction.
import { describe, expect, it } from "vitest";
import { ApiV1Error } from "@/lib/client-v1";
import type { AiCompetitionPlanResponse } from "@/server/api-v1/schemas";
import {
  jointRunBody,
  runJointPlan,
  rungOverrides,
  type JointApi,
  type JointRunInput,
} from "../ai-joint-run";

const PLAN = { summary: "planned", proposal: [] } as unknown as AiCompetitionPlanResponse;
const URL = "/api/v1/competitions/c1/schedule/ai-plan";

const input = (over: Partial<JointRunInput> = {}): JointRunInput => ({
  competitionId: "c1",
  selected: ["d1", "d2"],
  instruction: "  Finish every division by 6pm.  ",
  rungs: {},
  prior: null,
  ...over,
});

describe("rungOverrides — where a confirmed price becomes a sent price", () => {
  it("sends only the rungs the organiser picked, for divisions actually in the run", () => {
    // A per-division `chosen: null` means "server, size this one yourself", and
    // must send NO entry — sending the client's guess freezes a stale estimate
    // into the charge. An entry for a division that was deselected after being
    // adjusted would price a division the run does not cover.
    expect(rungOverrides({ d1: 3, d2: null, d3: 2 }, ["d1", "d2"])).toEqual({
      rung_overrides: { d1: 3 },
    });
  });

  it("omits the field entirely when every line follows the prediction", () => {
    // `{}` and an absent key are not the same over the wire.
    expect("rung_overrides" in rungOverrides({ d1: null, d2: null }, ["d1", "d2"])).toBe(false);
    expect("rung_overrides" in rungOverrides({}, ["d1", "d2"])).toBe(false);
  });

  it("drops a value that is not a rung rather than forwarding it", () => {
    for (const junk of [0, 4, -1, 1.5, Number.NaN]) {
      expect("rung_overrides" in rungOverrides({ d1: junk }, ["d1"]), String(junk)).toBe(false);
    }
  });
});

describe("jointRunBody — what the server is actually asked to charge for", () => {
  it("runs the divisions that were PRICED, not every division on the board", () => {
    // The receipt is built from `selected`. A body that widened to the whole
    // board would run — and charge for — work the organiser never saw a price
    // for.
    expect(jointRunBody(input()).division_ids).toEqual(["d1", "d2"]);
  });

  it("carries the organiser's rung picks, and only for divisions in the run", () => {
    // `d3` is the decoy: it was adjusted and then deselected. Sending its
    // override prices a division the run does not cover; DROPPING d1's is the
    // under-quote — the card would show the down-picked number while the
    // server sized the run from its own (higher) prediction and charged that.
    expect(jointRunBody(input({ rungs: { d1: 1, d2: null, d3: 3 } })).rung_overrides).toEqual({
      d1: 1,
    });
  });

  it("sends the trimmed instruction the CTA was enabled on", () => {
    expect(jointRunBody(input()).instruction).toBe("Finish every division by 6pm.");
  });

  it("is a generate run without a prior and a refine run with one", () => {
    // Only the stale-board recovery passes a prior, and it must round-trip the
    // proposal WITH its division ids — the joint prior schema requires them.
    expect(jointRunBody(input()).mode).toBe("generate");
    expect("prior" in jointRunBody(input())).toBe(false);

    const prior = {
      proposal: [
        {
          fixture_id: "f1",
          scheduled_at: "2026-08-01T09:00:00.000Z",
          court_label: "Court 1",
          division_id: "d1",
        },
      ],
    } as unknown as AiCompetitionPlanResponse;
    const refine = jointRunBody(input({ prior }));
    expect(refine.mode).toBe("refine");
    expect(refine.prior).toEqual({
      instruction: "Finish every division by 6pm.",
      assignments: [
        {
          fixture_id: "f1",
          scheduled_at: "2026-08-01T09:00:00.000Z",
          court_label: "Court 1",
          division_id: "d1",
        },
      ],
    });
  });
});

/** An api that never settles until told to, so a second call can be made while
 *  the first is genuinely still in flight. */
function deferredApi() {
  const calls: { url: string; json: unknown }[] = [];
  let settle: ((v: unknown) => void) | null = null;
  let fail: ((e: unknown) => void) | null = null;
  const api: JointApi = (<T,>(url: string, options?: { method?: string; json?: unknown }) => {
    calls.push({ url, json: options?.json });
    return new Promise<T>((resolve, reject) => {
      settle = resolve as (v: unknown) => void;
      fail = reject;
    });
  }) as JointApi;
  return {
    api,
    calls,
    settle: (v: unknown) => settle?.(v),
    fail: (e: unknown) => fail?.(e),
  };
}

describe("runJointPlan — one intent must not spend twice", () => {
  it("refuses a second run while the first is still in flight", async () => {
    // THE money assertion: exactly one POST, so exactly one `spendCredit`. The
    // second call is made with no awaits in between, which is precisely the
    // case a `disabled` attribute cannot cover — the click that beats React's
    // re-render.
    const { api, calls, settle } = deferredApi();
    const inFlight = { current: false };
    const starts: number[] = [];
    const ctl = { inFlight, onStart: () => starts.push(1) };

    const first = runJointPlan(input(), ctl, api);
    const second = await runJointPlan(input(), ctl, api);

    expect(second).toEqual({ status: "refused" });
    expect(calls).toHaveLength(1);
    // The refused call must not have started a spinner or cleared the error of
    // a run that is still going.
    expect(starts).toHaveLength(1);

    settle(PLAN);
    expect(await first).toEqual({ status: "planned", plan: PLAN });
  });

  it("releases the guard when the run answers, so a deliberate re-run still works", async () => {
    // The guard must not be a one-way latch: refine-after-refuse is the whole
    // point of the button it protects.
    const { api, calls, settle } = deferredApi();
    const inFlight = { current: false };
    const ctl = { inFlight };

    const first = runJointPlan(input(), ctl, api);
    settle(PLAN);
    await first;
    expect(inFlight.current).toBe(false);

    const second = runJointPlan(input(), ctl, api);
    settle(PLAN);
    await second;
    expect(calls).toHaveLength(2);
  });

  it("releases the guard when the run FAILS, not only when it succeeds", async () => {
    // A guard left latched by a 402 would leave the organiser unable to retry
    // after topping up — locked out by the protection.
    const { api, fail } = deferredApi();
    const inFlight = { current: false };
    const first = runJointPlan(input(), { inFlight }, api);
    fail(new ApiV1Error("nope", 402, "PAYMENT_REQUIRED", { feature_key: "ai.credits" }));
    expect(await first).toEqual({ status: "failed", httpStatus: 402, code: "ai.credits" });
    expect(inFlight.current).toBe(false);
  });

  it("prefers the paywall feature key over the generic 402 code", async () => {
    // "ai.credits" is what routes the console to the top-up block instead of
    // "upgrade to Pro" — AI is metered on every tier.
    const { api, fail } = deferredApi();
    const run = runJointPlan(input(), { inFlight: { current: false } }, api);
    fail(new ApiV1Error("plan", 402, "PAYMENT_REQUIRED", {}));
    expect(await run).toEqual({ status: "failed", httpStatus: 402, code: "PAYMENT_REQUIRED" });
  });

  it("posts the body to the competition's own plan endpoint", async () => {
    const { api, calls, settle } = deferredApi();
    const run = runJointPlan(input({ rungs: { d1: 2 } }), { inFlight: { current: false } }, api);
    settle(PLAN);
    await run;
    expect(calls[0].url).toBe(URL);
    expect(calls[0].json).toEqual(jointRunBody(input({ rungs: { d1: 2 } })));
  });
});
