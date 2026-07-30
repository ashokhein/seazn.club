// Phase B (officials) was spending credits with NO pre-spend surface: the
// Re-plan button carried no quote, no count and no rung control, and the console
// never sent `rung` even though `AiOfficialsPlanRequest.rung` has existed since
// #348. This is the same confirm card at single-line scale — but it must be
// priced with the OFFICIALS weights and it must know about the free draft.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Dict } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
import {
  officialsRungWeights,
  quoteRun,
  schedulingRungWeights,
  type RungInput,
} from "@/lib/ai-rung";
import en from "@/dictionaries/en/ui.json";
import type { AiOfficialsPlanResponse } from "@/server/api-v1/schemas";
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

/** A server plan. `tokens` is the whole point: it is the server's own record
 *  of whether the last run called the model, and therefore of whether the
 *  brief the adopt path will replay is chargeable. */
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
  over: { instruction?: string; rung?: number | null; plan?: AiOfficialsPlanResponse | null } = {},
): string {
  return renderToStaticMarkup(
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
        onInstruction={() => {}}
        wishes={[]}
        onWishes={() => {}}
        onReplan={() => {}}
        onAdopt={() => {}}
        onBack={() => {}}
        onContinue={() => {}}
        onPulse={() => {}}
      />
    </DictProvider>,
  );
}

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

  it("names the credit count on the Re-plan button", () => {
    const html = render();
    const btn = html.slice(html.lastIndexOf("ai-run"));
    expect(btn).toContain("1 credit");
    expect(btn).toContain(enText["board.ai.officials.replan"]);
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
    // The per-cell adopt re-runs the brief that produced the current proposal —
    // NOT the textarea. Clear the box after a paid run and a card keyed only on
    // the textarea reads "flat 1 credit" for a run the server prices: the one
    // direction that bills more than the surface promised.
    //
    // The signal is the PLAN's own token usage. It is the server's record of
    // what it did, so unlike a client-side copy of the instruction it cannot
    // drift from the charge — the previous version of this guard was satisfied
    // by an echo the console recorded, and stayed green when that recording was
    // deleted.
    const cleared = render({ instruction: "", plan: planWith(4200) });
    expect(creditsShown(cleared)).toBe(1); // this pack is rung 1…
    expect(cardOnly(cleared)).not.toContain(enText["board.ai.quote.freeDraft"]);
    expect(cardOnly(cleared)).toContain('role="radiogroup"');

    // A prior run that spent no tokens means the adopt path is free too, so an
    // empty box legitimately shows the free-draft state.
    const afterDraft = render({ instruction: "", plan: planWith(0) });
    expect(cardOnly(afterDraft)).toContain(enText["board.ai.quote.freeDraft"]);
    // …as does the very first entry, before any run at all.
    expect(cardOnly(render({ instruction: "", plan: null }))).toContain(
      enText["board.ai.quote.freeDraft"],
    );
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
          onInstruction={() => {}}
          wishes={[]}
          onWishes={() => {}}
          onReplan={() => {}}
          onAdopt={() => {}}
          onBack={() => {}}
          onContinue={() => {}}
          onPulse={() => {}}
        />
      </DictProvider>,
    );
    expect(creditsShown(html)).toBe(1);
    expect(html).toContain(enText["board.ai.quote.underfunded"]);
  });
});
