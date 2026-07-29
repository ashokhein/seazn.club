// The confirm card an organiser reads BEFORE spending credits (#348 §8, #350 §7).
//
// The number on this card is money, and the server recomputes it independently
// (`quoteRun` in schedule-ai.ts / competition-schedule-ai.ts). So the one thing
// these tests exist for is that the client and the server cannot disagree: the
// card must price through the SAME pure `quoteRun`, with the same inputs, and
// display the credits it returns — never its own arithmetic.
//
// Rendering is `renderToStaticMarkup` (the repo's client-component convention —
// see ai-console-frozen.test.tsx and ai-diff-conflict-label.test.tsx); there is
// no jsdom or @testing-library in this workspace. The card is CONTROLLED — the
// console owns `chosen` and feeds it back through `onChange` — so "selecting a
// rung" is expressed as the prop the console would have set, and the keyboard
// contract is pinned on the pure `rungForKey` reducer plus the rendered ARIA.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Dict } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
import { quoteRun, schedulingRungWeights, type RungInput } from "@/lib/ai-rung";
import en from "@/dictionaries/en/ui.json";
import { AiQuoteCard, rungForKey, toQuoteLineInputs, type QuoteCardLine } from "../ai-quote-card";
import { AiConsole } from "../ai-console";

const dict = en as unknown as Dict;
const enText = en as unknown as Record<string, string>;

// Four DIFFERENT sizes on purpose. A fixture set where every division is the
// same size cannot tell "each row is priced from its own input" from "every row
// is priced from the first one" — the exact hole a sibling task shipped.
const SMALL: RungInput = { movableFixtures: 20, entrants: 8, courts: 2 }; // score 28  -> rung 1
const SMALLER_ISH: RungInput = { movableFixtures: 45, entrants: 10, courts: 3 }; // score 56  -> rung 1
const MEDIUM: RungInput = { movableFixtures: 90, entrants: 20, courts: 3 }; // score 106 -> rung 2
const LARGE: RungInput = { movableFixtures: 250, entrants: 40, courts: 4 }; // score 278 -> rung 3
// est. tokens (~134K) exceed even the rung-3 budget (128K) — the "very large" state.
const HUGE: RungInput = { movableFixtures: 500, entrants: 100, courts: 8 }; // score 566

function line(key: string, input: RungInput, chosen: number | null = null, label: string | null = null): QuoteCardLine {
  return { key, label, input, chosen };
}

function render(lines: QuoteCardLine[], busy = false): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict} locale="en">
      <AiQuoteCard lines={lines} onChange={() => {}} msg={(k, v) => tEn(k as string, v)} busy={busy} />
    </DictProvider>,
  );
}

/** English `msg` with the same `{var}` interpolation the runtime does. */
function tEn(key: string, vars?: Record<string, string | number>): string {
  const raw = enText[key] ?? key;
  return vars ? raw.replace(/\{(\w+)\}/g, (m, n) => (n in vars ? String(vars[n]) : m)) : raw;
}

/** The credits the card is claiming, read off the one element that carries it. */
function creditsShown(html: string): number {
  const m = /data-ai-credits="(\d+)"/.exec(html);
  expect(m, "card did not render data-ai-credits").not.toBeNull();
  return Number(m![1]);
}

interface Chip {
  rung: number;
  checked: boolean;
  tabIndex: string;
}

function chips(html: string): Chip[] {
  return [...html.matchAll(/<button[^>]*role="radio"[^>]*>/g)].map((m) => {
    const tag = m[0];
    return {
      rung: Number(/data-rung="(\d)"/.exec(tag)?.[1]),
      checked: /aria-checked="true"/.test(tag),
      tabIndex: /tabindex="(-?\d)"/.exec(tag)?.[1] ?? "",
    };
  });
}

const checkedRungs = (html: string) => chips(html).filter((c) => c.checked).map((c) => c.rung);

describe("AiQuoteCard", () => {
  it("pre-selects the predicted rung", () => {
    // MEDIUM predicts rung 2. A control that defaults to 1 (or to "the first
    // option") would silently under-fund every run nobody touched.
    const html = render([line("d1", MEDIUM)]);
    expect(chips(html).map((c) => c.rung)).toEqual([1, 2, 3]);
    expect(checkedRungs(html)).toEqual([2]);
    expect(creditsShown(html)).toBe(2);
  });

  it("selecting a lower rung shows the underfunded warning", () => {
    const warning = enText["board.ai.quote.underfunded"];
    // Same division, same everything, ONE difference: the chosen rung. Without
    // the untouched control as the contrast, "the warning is always rendered"
    // would satisfy the assertion too.
    const untouched = render([line("d1", LARGE)]);
    const cheapened = render([line("d1", LARGE, 1)]);
    expect(untouched).not.toContain(warning);
    expect(cheapened).toContain(warning);
    expect(checkedRungs(cheapened)).toEqual([1]);
  });

  it("selecting a higher rung shows no warning and raises the credit count", () => {
    const warning = enText["board.ai.quote.underfunded"];
    const predicted = render([line("d1", SMALL)]); // rung 1
    const richer = render([line("d1", SMALL, 3)]);
    expect(creditsShown(predicted)).toBe(1);
    expect(creditsShown(richer)).toBe(3);
    expect(richer).not.toContain(warning);
  });

  it("a single line renders no discount row", () => {
    // Not cosmetic: the batch discount is a JOINT-run rule. A lone rung-2
    // division costs 2 credits, not max(1, 2-1) = 1 — pricing the single-division
    // card through the discount would hand out a free credit on every run and
    // make the card disagree with what the server charges.
    const html = render([line("d1", MEDIUM)]);
    expect(creditsShown(html)).toBe(2);
    expect(html).not.toContain(enText["board.ai.quote.discount"]);
    expect(html).not.toContain("data-ai-discount");
  });

  it("two lines show the batch discount row and the max(1, sum-1) total", () => {
    // Two rung-1 divisions of DIFFERENT sizes: 1 + 1 = 2, minus the batch
    // discount = 1 credit. The differing sizes also prove each row is described
    // from its own input rather than from the first row's.
    const html = render([
      line("d1", SMALL, null, "Under 12s"),
      line("d2", SMALLER_ISH, null, "Under 16s"),
    ]);
    expect(html).toContain("Under 12s");
    expect(html).toContain("Under 16s");
    expect(html).toContain("20 fixtures");
    expect(html).toContain("45 fixtures");
    expect(html).toContain(enText["board.ai.quote.discount"]);
    expect(html).toContain('data-ai-discount="1"');
    expect(creditsShown(html)).toBe(1);
    expect(quoteRun(toQuoteLineInputs([line("d1", SMALL), line("d2", SMALLER_ISH)]), schedulingRungWeights()).rungTotal).toBe(2);
  });

  it("warns when the estimate outgrows even the rung-3 budget", () => {
    const veryLarge = enText["board.ai.quote.veryLarge"];
    expect(render([line("d1", LARGE)])).not.toContain(veryLarge);
    expect(render([line("d1", HUGE)])).toContain(veryLarge);
  });

  it("does not call an under-funded run 'very large'", () => {
    // Picking rung 1 on a rung-3 division drops the budget to 32K while the
    // estimate stays ~68K — so a naive `estTokens > quote.budget` fires the
    // split-the-division advice at someone whose division is a perfectly normal
    // size and who has already been told what they did. "Very large" is a
    // property of the WORK (measured against what the predictions would buy),
    // not of the budget the organiser chose.
    const html = render([line("d1", LARGE, 1)]);
    expect(html).toContain(enText["board.ai.quote.underfunded"]);
    expect(html).not.toContain(enText["board.ai.quote.veryLarge"]);
    // …and a genuinely oversized run still says so, whatever is picked.
    expect(render([line("d1", HUGE, 1)])).toContain(enText["board.ai.quote.veryLarge"]);
  });

  it("the rung control is a keyboard-navigable radiogroup", () => {
    const html = render([line("d1", MEDIUM)]);
    expect(html).toContain('role="radiogroup"');
    const c = chips(html);
    expect(c).toHaveLength(3);
    // Exactly one checked, and a ROVING tabindex: the group is one tab stop, and
    // the stop is the selected option (all-zero would make it three stops).
    expect(c.filter((x) => x.checked)).toHaveLength(1);
    expect(c.map((x) => x.tabIndex)).toEqual(["-1", "0", "-1"]);

    // Arrow keys move the selection and wrap; Home/End jump to the ends; every
    // other key is left to the browser.
    expect(rungForKey("ArrowRight", 1)).toBe(2);
    expect(rungForKey("ArrowDown", 2)).toBe(3);
    expect(rungForKey("ArrowRight", 3)).toBe(1); // wraps forward
    expect(rungForKey("ArrowLeft", 1)).toBe(3); // wraps backward
    expect(rungForKey("ArrowUp", 3)).toBe(2);
    expect(rungForKey("Home", 3)).toBe(1);
    expect(rungForKey("End", 1)).toBe(3);
    expect(rungForKey("Tab", 2)).toBeNull();
    expect(rungForKey("a", 2)).toBeNull();
  });

  it("maps a null rung to undefined at the quoteRun boundary", () => {
    // `QuoteLineInput.chosen` is `number | undefined` and quoteRun tests it with
    // `chosen !== undefined && isRung(chosen)`. A `null` reaching it happens to
    // fall through to the prediction today — by accident, not by contract. Pin
    // the conversion so a later `isRung` change cannot silently reprice a run.
    const mapped = toQuoteLineInputs([line("d1", MEDIUM, null), line("d2", LARGE, 1)]);
    expect(mapped[0].chosen).toBeUndefined();
    expect(mapped[1].chosen).toBe(1);
    expect(mapped.map((m) => m.key)).toEqual(["d1", "d2"]);
    expect(mapped.map((m) => m.input)).toEqual([MEDIUM, LARGE]);
  });

  it("agrees with quoteRun for the same lines", () => {
    // THE test. A client that quotes 4 while the server charges 5 is a support
    // ticket about being overcharged, and nothing else here would catch it.
    // Expectations come from quoteRun DIRECTLY — never from the card's own
    // helper, which would make this tautological.
    const sets: QuoteCardLine[][] = [
      [line("a", SMALL)],
      [line("a", MEDIUM)],
      [line("a", LARGE)],
      [line("a", SMALL), line("b", SMALLER_ISH)],
      [line("a", MEDIUM), line("b", LARGE)],
      [line("a", SMALL), line("b", MEDIUM), line("c", LARGE)],
      [line("a", LARGE, 1), line("b", MEDIUM)],
      [line("a", SMALL, 3), line("b", MEDIUM, 3), line("c", LARGE)],
    ];
    const expected = sets.map(
      (s) =>
        quoteRun(
          s.map((l) => ({ key: l.key, input: l.input, chosen: l.chosen === null ? undefined : l.chosen })),
          schedulingRungWeights(),
        ).credits,
    );
    // Sanity: the sets must actually span different prices, or "always returns 1"
    // would pass. 1/2/3/1/4/5/2/8.
    expect(expected).toEqual([1, 2, 3, 1, 4, 5, 2, 8]);
    expect(sets.map((s) => creditsShown(render(s)))).toEqual(expected);
  });
});

// --------------------------------------------------------------- the CTA
// A quote nobody reads is not a confirm surface. The console's run button is
// where the organiser actually commits, so the count has to be ON it — and it
// has to be the SAME count the card shows, which is why the console reads it
// from the card module rather than pricing the run a second time.
const RUNG3_BRIEF = {
  courts: ["Court 1", "Court 2", "Court 3", "Court 4"],
  windows: 1,
  blackouts: 0,
  constraintsSet: false,
  movable: 250,
  pinned: 0,
  entrants: Array.from({ length: 40 }, (_, i) => ({ id: `e${i}`, name: `Team ${i}` })),
  officialsWithBlackout: 0,
};

const consoleProps = {
  divisionId: "00000000-0000-4000-8000-000000000001",
  expectedSeq: 1,
  aiAllowed: true,
  brief: RUNG3_BRIEF,
  fixtures: [],
  scheduleFrozen: false,
  onClose: () => {},
} as unknown as Parameters<typeof AiConsole>[0];

describe("AiConsole brief step", () => {
  it("the CTA names the credit count", () => {
    const html = renderToStaticMarkup(
      <DictProvider dict={dict} locale="en">
        <AiConsole {...consoleProps} />
      </DictProvider>,
    );
    // 250 movable / 40 entrants / 4 courts predicts rung 3 -> 3 credits.
    const credits = quoteRun(
      [{ key: consoleProps.divisionId, input: LARGE }],
      schedulingRungWeights(),
    ).credits;
    expect(credits).toBe(3);
    const runBtn = html.slice(html.indexOf("ai-run"), html.indexOf("ai-run") + 900);
    expect(runBtn).toContain(`${credits} credits`);
  });
});
