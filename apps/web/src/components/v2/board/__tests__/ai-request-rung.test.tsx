// THE MONEY SEAM: the rung the organiser confirmed on the card has to be the
// rung the request carries.
//
// Everything else about the confirm card is provable through the render. This
// is not: the card can show "2 credits" while the body omits `rung` entirely,
// or carries Phase A's rung on a Phase B request, and no static-markup
// assertion would notice. Four mutations of exactly that shape were green
// before this file existed.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Dict } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
import en from "@/dictionaries/en/ui.json";
import type { AiOfficialsPlanResponse } from "@/server/api-v1/schemas";
import {
  aiConsoleReducer,
  initialAiConsoleState,
  type AiConsoleState,
} from "../ai-console-state";
import { OfficialsStep, officialsPlanBody, rungField, schedulePlanBody } from "../ai-console";
import { AiOfficialsReview } from "../ai-officials-review";

const dict = en as unknown as Dict;
const POLICY = {
  roles: ["referee"],
  poolLock: false,
  blockStay: true,
  fairness: "tournament" as const,
  teamRefKeepDivision: false,
  restMinMinutes: 0,
  blockGapMinutes: 30,
};

describe("rungField — the one line where a confirmed price becomes a sent price", () => {
  it("sends 1|2|3 and omits everything else", () => {
    expect(rungField(1)).toEqual({ rung: 1 });
    expect(rungField(2)).toEqual({ rung: 2 });
    expect(rungField(3)).toEqual({ rung: 3 });
  });

  it("sends NO rung when the organiser left the recommendation alone", () => {
    // `{}` and `{ rung: undefined }` are not the same over the wire, so assert
    // the KEY is absent rather than that the value is falsy.
    expect("rung" in rungField(null)).toBe(false);
  });

  it("drops a value that is not a rung rather than forwarding it", () => {
    // The reducer's field is a plain `number`; this is the boundary filter.
    for (const junk of [0, 4, -1, 1.5, Number.NaN]) {
      expect("rung" in rungField(junk), String(junk)).toBe(false);
    }
  });
});

/** A console state with the two phases' rungs set DIFFERENTLY, so a body that
 *  reaches for the wrong field is visible rather than coincidentally right. */
const stateWith = (over: Partial<AiConsoleState> = {}): AiConsoleState => ({
  ...initialAiConsoleState,
  rung: 3,
  officialsRung: 1,
  ...over,
});

/** `OfficialsStep`'s props, with the console state as the only interesting
 *  input — everything the step DERIVES from that state (which action it
 *  dispatches, which instruction it prices on) is then observable by calling
 *  the component as a function and reading the element it returns. */
function officialsStepProps(
  state: Partial<AiConsoleState> = {},
  over: Partial<Parameters<typeof OfficialsStep>[0]> = {},
): Parameters<typeof OfficialsStep>[0] {
  return {
    state: {
      ...initialAiConsoleState,
      step: "officials",
      schedulePlan: { proposal: [] } as unknown as AiConsoleState["schedulePlan"],
      ...state,
    },
    dispatch: () => {},
    currency: "usd",
    fixtures: [],
    roster: [],
    policyRoles: ["referee"],
    hadPrior: false,
    busy: false,
    traceNonce: 0,
    wishes: [],
    onWishes: () => {},
    onReplan: () => {},
    onAdopt: () => {},
    onPulse: () => {},
    ...over,
  };
}

describe("schedulePlanBody (Phase A)", () => {
  const base = { instruction: "Finish by 6pm", mode: "generate" as const };

  it("carries Phase A's rung — not Phase B's", () => {
    expect(schedulePlanBody(stateWith(), base).rung).toBe(3);
  });

  it("omits rung when following the prediction", () => {
    expect("rung" in schedulePlanBody(stateWith({ rung: null }), base)).toBe(false);
  });

  it("keeps the rest of the body intact", () => {
    const body = schedulePlanBody(stateWith({ scope: { courts: ["Court 1"] }, rung: 2 }), {
      ...base,
      mode: "repair",
      officialsPolicy: POLICY,
      prior: { instruction: "before", assignments: [] },
    });
    expect(body).toEqual({
      instruction: "Finish by 6pm",
      mode: "repair",
      scope: { courts: ["Court 1"] },
      rung: 2,
      officials_policy: POLICY,
      prior: { instruction: "before", assignments: [] },
    });
  });
});

describe("officialsPlanBody (Phase B)", () => {
  const base = { instruction: "Senior ref on the final", schedule: [], policy: POLICY };

  it("carries Phase B's rung — not Phase A's", () => {
    // The state says rung 3 / officialsRung 1. A body that read `rung` would
    // charge the organiser 3 credits for a run they confirmed at 1.
    expect(officialsPlanBody(stateWith(), base).rung).toBe(1);
  });

  it("omits rung when following the prediction", () => {
    expect("rung" in officialsPlanBody(stateWith({ officialsRung: null }), base)).toBe(false);
  });

  it("omits an empty schedule but keeps a populated one", () => {
    expect("schedule" in officialsPlanBody(stateWith(), base)).toBe(false);
    const withSchedule = officialsPlanBody(stateWith(), {
      ...base,
      schedule: [
        { fixture_id: "f1", scheduled_at: "2026-08-01T10:00:00.000Z", court_label: "Court 1" },
      ],
    });
    expect(withSchedule.schedule).toHaveLength(1);
  });
});

describe("the two phases keep their rungs apart", () => {
  it("SET_RUNG moves only Phase A, SET_OFFICIALS_RUNG only Phase B", () => {
    const a = aiConsoleReducer(initialAiConsoleState, { type: "SET_RUNG", rung: 3 });
    expect([a.rung, a.officialsRung]).toEqual([3, null]);
    const b = aiConsoleReducer(a, { type: "SET_OFFICIALS_RUNG", rung: 1 });
    expect([b.rung, b.officialsRung]).toEqual([3, 1]);
    // …and back to the recommendation independently.
    const c = aiConsoleReducer(b, { type: "SET_OFFICIALS_RUNG", rung: null });
    expect([c.rung, c.officialsRung]).toEqual([3, null]);
  });

  it("the officials rung control dispatches SET_OFFICIALS_RUNG, not SET_RUNG", () => {
    // Separate action TYPES make an omitted flag a compile error, but they do
    // nothing about SUBSTITUTION: writing `{ type: "SET_RUNG", rung }` at this
    // call site typechecks, and until this test it ran green — Phase B's
    // control silently writing Phase A's rung.
    //
    // Reading which action is sent needs the actual callback, not the markup,
    // so call the component as the plain function it is and read the element it
    // returns. A reducer test cannot do this: it proves what an action MEANS,
    // never which one was dispatched.
    const sent: unknown[] = [];
    const el = OfficialsStep(officialsStepProps({}, { dispatch: (a) => sent.push(a) }));
    expect(el.type).toBe(AiOfficialsReview); // guards the props read below
    const { onRung } = el.props as { onRung: (r: number | null) => void };
    onRung(2);
    onRung(null); // "back to the recommendation" is the same action
    expect(sent).toEqual([
      { type: "SET_OFFICIALS_RUNG", rung: 2 },
      { type: "SET_OFFICIALS_RUNG", rung: null },
    ]);
  });

  it("the request's prior carries the brief those assignments were produced under", () => {
    // Both halves of `prior` come from one place: the assignments from the
    // caller, the instruction from state. Passing them separately let the two
    // describe different runs.
    const body = officialsPlanBody(
      stateWith({ officialsPriorInstruction: "Senior ref on the final." }),
      {
        instruction: "Swap the 3pm referee.",
        schedule: [],
        policy: POLICY,
        priorAssignments: [
          { fixtureId: "f1", officialId: "o1", roleKey: "referee", locked: false },
        ],
      },
    );
    expect(body.prior).toEqual({
      instruction: "Senior ref on the final.",
      assignments: [{ fixtureId: "f1", officialId: "o1", roleKey: "referee", locked: false }],
    });
    // No round-tripped assignments -> no prior at all.
    expect(
      "prior" in
        officialsPlanBody(stateWith({ officialsPriorInstruction: "x" }), {
          instruction: "y",
          schedule: [],
          policy: POLICY,
        }),
    ).toBe(false);
  });

  it("OFFICIALS_DONE records the brief that produced the plan", () => {
    // One action records the plan AND the brief, so the instruction the adopt
    // path replays cannot drift from the proposal it belongs to.
    const done = aiConsoleReducer(initialAiConsoleState, {
      type: "OFFICIALS_DONE",
      plan: { assignments: [] } as unknown as AiOfficialsPlanResponse,
      instruction: "Spread the load.",
    });
    expect(done.officialsPriorInstruction).toBe("Spread the load.");
    // A free draft records the EMPTY brief — that is what lets the next card
    // legitimately show its free-draft state instead of a price.
    const draft = aiConsoleReducer(done, {
      type: "OFFICIALS_DONE",
      plan: { assignments: [] } as unknown as AiOfficialsPlanResponse,
      instruction: "",
    });
    expect(draft.officialsPriorInstruction).toBe("");
  });

  it("the officials step spends Phase B's rung, never Phase A's", () => {
    // The two are set DIFFERENTLY, so a card reading `state.rung` renders a
    // different control than one reading `state.officialsRung`. Phase A is 3,
    // Phase B is 1 — the card must show 1 checked.
    const html = renderToStaticMarkup(
      <DictProvider dict={dict} locale="en">
        {OfficialsStep(
          officialsStepProps({
            // Non-empty, or the card renders its free-draft state and offers no
            // control at all — which would make the assertion below vacuous.
            officialsInstruction: "Senior ref on the final.",
            rung: 3,
            officialsRung: 1,
          }),
        )}
      </DictProvider>,
    );
    const checked = [...html.matchAll(/<button[^>]*role="radio"[^>]*>/g)]
      .filter((m) => /aria-checked="true"/.test(m[0]))
      .map((m) => /data-rung="(\d)"/.exec(m[0])?.[1]);
    expect(checked).toEqual(["1"]);
  });
});
