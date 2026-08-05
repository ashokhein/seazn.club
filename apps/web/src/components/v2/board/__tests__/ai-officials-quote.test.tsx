// Phase B (officials) was spending credits with NO pre-spend surface: the
// Re-plan button carried no quote, no count and no rung control, and the console
// never sent `rung` even though `AiOfficialsPlanRequest.rung` has existed since
// #348. This is the same confirm card at single-line scale — but it must be
// priced with the OFFICIALS weights and it must know about the free draft.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Dict } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
// #385: every surface that prices a run now reads its rung weights and token
// budgets from the provider the board's RSC seeds — a client module cannot
// resolve AI_RUNG_* for itself. Server-resolved DEFAULTS here: these suites are
// about copy and wiring, and rung-config-provider.test.tsx owns the assertion
// that an override actually reaches the card.
import { RungConfigProvider } from "../rung-config-provider";
import { resolveRungConfig } from "@/lib/ai-rung";
import {
  officialsRungWeights,
  quoteRun,
  schedulingRungWeights,
  type RungInput,
} from "@/lib/ai-rung";
import en from "@/dictionaries/en/ui.json";
import type { AiOfficialsPlanResponse } from "@/server/api-v1/schemas";
import { initialAiConsoleState, type AiConsoleState } from "../ai-console-state";
import { OfficialsStep } from "../ai-console";
import { AiOfficialsReview } from "../ai-officials-review";
import { quoteFor } from "../ai-quote-card";

const dict = en as unknown as Dict;
const enText = en as unknown as Record<string, string>;

// Sized to SEPARATE the two weight tables. Officials weights are lighter
// (entrant 0.25 / court 1, s1 120) than scheduling's (0.5 / 2, s1 60):
//   officials  : 100 + 0.25*24 + 1*4  = 110  <= 120  -> rung 1
//   scheduling : 100 + 0.5*24  + 2*4  = 120  >  60   -> rung 2
// So a card that reached for the default weights costs twice as much.
const PACK: RungInput = { movableFixtures: 100, entrants: 24, courts: 4 };

/** A server plan. `tokens` is its REPORTED usage — deliberately not a price
 *  input any more: both providers default a missing usage block to 0
 *  (`anthropic-provider.ts` `response.usage?.input_tokens ?? 0`,
 *  `openrouter-provider.ts` `usage.prompt_tokens ?? 0`), so a priced run whose
 *  provider omits the block is indistinguishable from the solver draft. */
function planWith(tokens: number): AiOfficialsPlanResponse {
  return {
    assignments: [],
    conflicts: [],
    diff: { changed: [], unchanged: [], unfilled: [] },
    lazy_unfilled: [],
    explanations: [],
    summary: "",
    usage: { input_tokens: tokens, output_tokens: tokens, repair_rounds: 0 },
  } as unknown as AiOfficialsPlanResponse;
}

function render(
  over: {
    instruction?: string;
    /** The brief the per-cell adopt would re-run — the second spend path's
     *  own input to the server's price. */
    adoptInstruction?: string;
    rung?: number | null;
    plan?: AiOfficialsPlanResponse | null;
  } = {},
): string {
  return renderToStaticMarkup(
    <RungConfigProvider value={resolveRungConfig()}>
    <DictProvider dict={dict} locale="en">
      <AiOfficialsReview
        plan={over.plan ?? null}
        placements={[]}
        quoteInput={PACK}
        rung={over.rung ?? null}
        onRung={() => {}}
        currency="usd"
        fixtures={[]}
        roster={[]}
        roles={["referee"]}
        hasPrior={false}
        busy={false}
        traceNonce={0}
        error={null}
        instruction={over.instruction ?? "Give the final to the senior referee."}
        adoptInstruction={over.adoptInstruction ?? ""}
        onInstruction={() => {}}
        wishes={[]}
        onWishes={() => {}}
        onReplan={() => {}}
        onAdopt={() => {}}
        onBack={() => {}}
        onContinue={() => {}}
        onPulse={() => {}}
      />
    </DictProvider>
    </RungConfigProvider>,
  );
}

/** The same card reached through `OfficialsStep`, i.e. driven by CONSOLE STATE
 *  rather than by props. Handing the card the value whose derivation is under
 *  test would be one boundary too low: it would prove the card reads a prop,
 *  never that the step feeds it the string the adopt path actually sends. */
function stepHtml(state: Partial<AiConsoleState>): string {
  return renderToStaticMarkup(
    <RungConfigProvider value={resolveRungConfig()}>
    <DictProvider dict={dict} locale="en">
      {OfficialsStep({
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
      })}
    </DictProvider>
    </RungConfigProvider>,
  );
}

const FREE = enText["board.ai.quote.freeDraft"];

const creditsShown = (html: string): number => Number(/data-ai-credits="(\d+)"/.exec(html)?.[1]);

/** Just the quote card — the review page around it talks about tokens too. */
function cardOnly(html: string): string {
  const start = html.indexOf(`<section aria-label="${enText["board.ai.quote.aria"]}"`);
  expect(start, "quote card not rendered").toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</section>", start));
}

describe("officials confirm card", () => {
  it("prices the run with the OFFICIALS weights, not the scheduling ones", () => {
    const officials = quoteRun([{ key: "o", input: PACK }], officialsRungWeights()).credits;
    const scheduling = quoteRun([{ key: "o", input: PACK }], schedulingRungWeights()).credits;
    // The fixture has to separate them, or this test proves nothing.
    expect(officials).toBe(1);
    expect(scheduling).toBe(2);
    expect(creditsShown(render())).toBe(officials);
  });

  it("names the credit count on the run button", () => {
    // #383: with no plan yet this button DRAFTS — the step no longer auto-fires
    // one, so "re-plan" would name work that has not happened. The subject of
    // this test is unchanged: the CTA names what the run costs.
    const btn = (html: string) => html.slice(html.lastIndexOf("ai-run"));
    const drafting = btn(render());
    expect(drafting).toContain("1 credit");
    expect(drafting).toContain(enText["board.ai.officials.run"]);

    // Once a draft exists the same button refines it, and says so.
    const refining = btn(render({ plan: planWith(0) }));
    expect(refining).toContain("1 credit");
    expect(refining).toContain(enText["board.ai.officials.replan"]);
  });

  it("quotes the empty-instruction draft at a flat 1 credit, with no rung control", () => {
    // The solver draft makes no model call and is quoted by `freeDraftQuote`
    // server-side. Sizing it would charge a large division 2-3 credits for a
    // run that spends nothing — and offering a rung control would imply a
    // budget choice that has no effect.
    const big: RungInput = { movableFixtures: 500, entrants: 100, courts: 8 };
    expect(quoteRun([{ key: "o", input: big }], officialsRungWeights()).credits).toBe(3);
    expect(quoteFor([{ key: "o", label: null, input: big, chosen: null }], {
      weights: officialsRungWeights(),
      freeDraft: true,
    }).credits).toBe(1);

    const html = render({ instruction: "   " });
    expect(creditsShown(html)).toBe(1);
    expect(html).toContain(enText["board.ai.quote.freeDraft"]);
    expect(html).not.toContain('role="radiogroup"');
    // No token estimate and no "credits buy a thinking budget" line: this run
    // does no thinking, so both would describe something that never happens.
    // Assert the COPY, not the substring "tokens" — that also appears in the
    // `data-ai-line-tokens` attribute name, so a bare contains() would pass on
    // markup and prove nothing about what is on screen.
    const card = cardOnly(html);
    expect(card).toContain("100 fixtures · 4 courts");
    expect(card).not.toContain("~0 tokens");
    expect(card).not.toContain("Credits buy a thinking budget");
    // …while a priced re-plan carries both.
    const priced = cardOnly(render());
    expect(priced).toContain("~9K tokens"); // officials curve: score 110 -> ~9.2K
    expect(priced).toContain("Credits buy a thinking budget");
  });

  it("does not claim 'free' while the adopt path would be charged", () => {
    // The screen has TWO spend paths and the server prices each one on the
    // instruction that request carries (`officials-ai.ts:1104` —
    // `input.instruction.trim() === ""` picks `freeDraftQuote`, nothing else
    // does): Re-plan sends the textarea, the per-cell adopt sends the brief
    // that produced the proposal on screen. So the card may claim "flat 1
    // credit" only when BOTH of those strings are empty — otherwise clearing
    // the box after a paid run bills 2-3 for a run the surface confirmed at 1.
    //
    // The credit COUNT cannot discriminate here (`freeDraftQuote` is also 1
    // credit, and this pack is rung 1), so the free-draft copy and the rung
    // control are the assertions with teeth.
    const priced = (html: string) => {
      expect(cardOnly(html)).not.toContain(FREE);
      expect(cardOnly(html)).toContain('role="radiogroup"');
    };

    // Empty box, chargeable adopt brief — priced, whatever the plan reports.
    priced(render({ instruction: "", adoptInstruction: "Senior ref.", plan: planWith(4200) }));
    // …INCLUDING when the plan reports no tokens at all. That is not proof the
    // last run was the solver draft: both providers default a missing usage
    // block to 0, so a real priced run whose provider omitted usage lands here.
    // Keying the guard on usage failed OPEN in exactly this cell.
    priced(render({ instruction: "", adoptInstruction: "Senior ref.", plan: planWith(0) }));
    // A non-empty textarea is priced on its own, with nothing to adopt.
    priced(render({ instruction: "Spread the load.", adoptInstruction: "", plan: null }));

    // Both briefs empty: every run reachable from this screen sends an empty
    // instruction, so the server charges 1 for each and the claim is exact.
    expect(cardOnly(render({ instruction: "", adoptInstruction: "", plan: null }))).toContain(FREE);
    expect(cardOnly(render({ instruction: "", adoptInstruction: "", plan: planWith(0) }))).toContain(
      FREE,
    );
    // …and reported usage does not overrule it. A plan that spent tokens under
    // an empty brief is not reachable server-side, but if it were, the adopt it
    // enables still sends "" and is still charged 1 — quoting 2-3 there would
    // over-quote for no reason, and would put a provider-omittable field back
    // on the money path.
    expect(
      cardOnly(render({ instruction: "", adoptInstruction: "", plan: planWith(4200) })),
    ).toContain(FREE);
  });

  it("prices the officials step on the brief the ADOPT path will re-run", () => {
    // The card can only be as right as the string the step hands it. This is
    // the wiring — `state.officialsPriorInstruction`, the very field
    // `onAdopt` sends as the next run's `instruction` — so it is asserted
    // through `OfficialsStep` from console state, not by handing the card the
    // answer. Passing `""` here is the whole defect, and it is a one-token edit.
    const chargeable = stepHtml({
      officialsInstruction: "", // box cleared…
      officialsPriorInstruction: "Senior ref on the final.", // …after a paid run
      officialsPlan: planWith(0), // provider reported no usage
    });
    expect(chargeable).not.toContain(FREE);
    expect(chargeable).toContain('role="radiogroup"');

    // Contrast: same state, empty brief — the auto-run solver draft. Without
    // this the assertion above is satisfied by a card that never claims free.
    const draft = stepHtml({
      officialsInstruction: "",
      officialsPriorInstruction: "",
      officialsPlan: planWith(0),
    });
    expect(draft).toContain(FREE);
    expect(draft).not.toContain('role="radiogroup"');
  });

  it("offers the rung control once there is an instruction to spend on", () => {
    const html = render();
    expect(html).toContain('role="radiogroup"');
    expect(html).not.toContain(enText["board.ai.quote.freeDraft"]);
  });

  it("honours a rung picked below the officials prediction", () => {
    // Nothing below rung 1, so drive it from a pack the officials weights put
    // on rung 2: 300 + 0.25*40 + 1*10 = 320 -> rung 2.
    const html = renderToStaticMarkup(
      <RungConfigProvider value={resolveRungConfig()}>
    <DictProvider dict={dict} locale="en">
        <AiOfficialsReview
          plan={null}
          placements={[]}
          quoteInput={{ movableFixtures: 300, entrants: 40, courts: 10 }}
          rung={1}
          onRung={() => {}}
          currency="usd"
          fixtures={[]}
          roster={[]}
          roles={["referee"]}
          hasPrior={false}
          busy={false}
          traceNonce={0}
          error={null}
          instruction="Spread the load."
          adoptInstruction=""
          onInstruction={() => {}}
          wishes={[]}
          onWishes={() => {}}
          onReplan={() => {}}
          onAdopt={() => {}}
          onBack={() => {}}
          onContinue={() => {}}
          onPulse={() => {}}
        />
      </DictProvider>
    </RungConfigProvider>,
    );
    expect(creditsShown(html)).toBe(1);
    expect(html).toContain(enText["board.ai.quote.underfunded"]);
  });
});
