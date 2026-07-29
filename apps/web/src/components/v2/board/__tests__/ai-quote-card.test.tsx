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
import type { AiConsoleFixture } from "../ai-diff";
import {
  AiQuoteCard,
  pickValue,
  rungForKey,
  toQuoteLineInputs,
  type QuoteCardLine,
} from "../ai-quote-card";
import {
  AiConsole,
  movableForRun,
  officialsQuoteInput,
  scheduleQuoteLines,
  type AiBriefContext,
} from "../ai-console";

/** An AiConsoleFixture with only the fields the officials sizing reads. */
function fx(
  id: string,
  o: { status: string; at: string | null; court: string | null; home: string; away: string },
): AiConsoleFixture {
  return {
    id,
    stage_id: "st-1",
    scheduled_at: o.at,
    court_label: o.court,
    code: id,
    matchup: `${o.home} v ${o.away}`,
    isFinal: false,
    isJunior: false,
    status: o.status,
    home_entrant_id: o.home,
    away_entrant_id: o.away,
  };
}

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
// Fits its OWN rung-3 budget (est ~114K ≤ 128K), but two of them (~228K) do not
// fit the 224K that 3+3 credits buy — the joint-only "very large" state.
const BIG: RungInput = { movableFixtures: 450, entrants: 40, courts: 5 }; // score 480

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

/**
 * Every representation of a division row's amount: the e2e/data hook, the
 * screen-reader string, and the digit a sighted organiser actually reads.
 *
 * Asserting only the data attribute is how a "fix" for an unpinned money digit
 * ends up pinning a *different* element that happens to hold the right value —
 * three mutations of the visible span survived exactly that mistake.
 */
function rowAmounts(html: string): { attr: string; sr: string; visible: string }[] {
  const re =
    /<span data-ai-line-rung="(\d)"[^>]*><span class="sr-only">([^<]*)<\/span><span aria-hidden="true">(\d+)<\/span><\/span>/g;
  return [...html.matchAll(re)].map((m) => ({ attr: m[1], sr: m[2], visible: m[3] }));
}

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

  it("prices each division row from its own rung, not the first row's or the total", () => {
    // MIXED RUNGS, deliberately. The test above varies fixture SIZE but both
    // divisions land on rung 1, so every money digit on the card — both row
    // amounts and the total — is the same `1`, and a row that rendered
    // `lines[0].rung`, or `quote.credits`, would be indistinguishable from a
    // correct one. Rung 1 + rung 3 makes all four numbers different:
    // rows 1 and 3, discount 1, total max(1, 4-1) = 3.
    const html = render([
      line("d1", SMALL, null, "Under 12s"), // rung 1, ~8K
      line("d2", LARGE, null, "Under 16s"), // rung 3, ~68K
    ]);
    // All THREE renderings of each amount, not just the data hook: the digit on
    // screen and the string a screen reader announces are the ones that would
    // actually mislead someone about what they are paying.
    expect(rowAmounts(html)).toEqual([
      { attr: "1", sr: "1 credit", visible: "1" },
      { attr: "3", sr: "3 credits", visible: "3" },
    ]);
    // Est-tokens are per row too — a shared `lines[0].estTokens` would print ~8K twice.
    expect(html).toContain("~8K tokens");
    expect(html).toContain("~68K tokens");
    expect(html).toContain('data-ai-discount="1"');
    expect(creditsShown(html)).toBe(3);
    // The row amounts must not silently be the total, and vice versa.
    expect(creditsShown(html)).not.toBe(1);
  });

  it("names the token budget the credits buy", () => {
    // #348 §8's explicit copy rule: credits buy a BUDGET, not usage. The
    // sentence is the only place the organiser learns what they are getting,
    // and 1/2/3 credits buy 32K/64K/128K.
    expect(render([line("d1", SMALL)])).toContain("up to 32K tokens");
    expect(render([line("d1", MEDIUM)])).toContain("up to 64K tokens");
    expect(render([line("d1", LARGE)])).toContain("up to 128K tokens");
    // Picking a lower rung buys a SMALLER budget — the number has to follow the
    // choice, not the prediction.
    expect(render([line("d1", LARGE, 1)])).toContain("up to 32K tokens");
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

  it("names WHICH divisions are very large on a joint run", () => {
    // "Split the division" is unactionable when the card is showing five of
    // them and the warning names none. The singular copy must not be what a
    // joint run renders.
    const html = render([
      line("d1", SMALL, null, "Under 12s"),
      line("d2", HUGE, null, "Under 16s"),
    ]);
    // ONE offending division takes the singular verb — "Under 16s are very
    // large" is the kind of copy that reads as a bug on a surface about money.
    expect(html).toContain("Under 16s is very large");
    expect(html).not.toContain(enText["board.ai.quote.veryLarge"]); // the un-attributed copy
    // The healthy division is not accused.
    expect(html).not.toContain("Under 12s is very large");

    // Two offenders take the plural, and both are named.
    const both = render([
      line("d1", HUGE, null, "Under 12s"),
      line("d2", HUGE, null, "Under 16s"),
    ]);
    expect(both).toContain("Under 12s, Under 16s are very large");
  });

  it("tells a joint run to drop divisions when no single one is at fault", () => {
    // Each division fits its own rung-3 budget (est ~114K ≤ 128K), so naming
    // one and telling the organiser to split it would be wrong. Together they
    // are ~228K against the 224K that 3+3 credits buy — a real problem with
    // different advice: run fewer divisions together.
    const html = render([line("a", BIG, null, "Alpha"), line("b", BIG, null, "Bravo")]);
    expect(html).toContain(enText["board.ai.quote.veryLargeJoint"]);
    expect(html).not.toContain("are very large"); // no division is accused
    expect(html).not.toContain(enText["board.ai.quote.veryLarge"]); // nor the singular copy

    // One division alone is under its budget and says nothing at all.
    const alone = render([line("a", BIG)]);
    expect(alone).not.toContain(enText["board.ai.quote.veryLargeJoint"]);
    expect(alone).not.toContain(enText["board.ai.quote.veryLarge"]);
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

  it("picking the recommended rung means 'follow the prediction', not a frozen number", () => {
    // Clicking the already-selected chip is a visual no-op, but a control that
    // reported the NUMBER would flip the request from "server, size this
    // yourself" to "charge me my client-side guess" — freezing an estimate the
    // server may not agree with into the price. It would also make `null`
    // unreachable the moment the control is touched, so there would be no way
    // back to the recommendation.
    expect(pickValue(2, 2)).toBeNull();
    expect(pickValue(1, 2)).toBe(1);
    expect(pickValue(3, 2)).toBe(3);
    expect(pickValue(1, 1)).toBeNull();
    expect(pickValue(3, 3)).toBeNull();
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
const DIVISION_ID = "00000000-0000-4000-8000-000000000001";

const movableFixture = (i: number, court: string, at: string | null) => ({
  id: `f${i}`,
  scheduled_at: at,
  court_label: court,
});

/** 250 movable on Court 1, 40 ACTIVE entrants, 4 courts → score 278 → rung 3. */
const RUNG3_BRIEF: AiBriefContext = {
  courts: ["Court 1", "Court 2", "Court 3", "Court 4"],
  windows: 1,
  blackouts: 0,
  constraintsSet: false,
  movableFixtures: Array.from({ length: 250 }, (_, i) =>
    movableFixture(i, "Court 1", "2026-08-01T10:00:00.000Z"),
  ),
  pinned: 0,
  // The chip picker's list is competition-wide and unfiltered — deliberately a
  // different (larger) number than `activeEntrants`, so a card that priced off
  // it would be visible.
  entrants: Array.from({ length: 96 }, (_, i) => ({ id: `e${i}`, name: `Team ${i}` })),
  activeEntrants: 40,
  officialsWithBlackout: 0,
};

// A typed fixture, not a cast: `currency` is required, and a bare
// `as unknown as Parameters<…>[0]` would silently drop the next required prop
// someone adds — failing at runtime, or not at all.
const consoleProps: Parameters<typeof AiConsole>[0] = {
  divisionId: DIVISION_ID,
  expectedSeq: 1,
  aiAllowed: true,
  currency: "usd",
  brief: RUNG3_BRIEF,
  fixtures: [],
  scheduleFrozen: false,
  onClose: () => {},
};

const renderConsole = (props: Partial<Parameters<typeof AiConsole>[0]> = {}): string =>
  renderToStaticMarkup(
    <DictProvider dict={dict} locale="en">
      <AiConsole {...consoleProps} {...props} />
    </DictProvider>,
  );

const runButton = (html: string): string =>
  html.slice(html.indexOf("ai-run"), html.indexOf("ai-run") + 900);

describe("AiConsole brief step", () => {
  it("the CTA names the credit count", () => {
    const html = renderConsole();
    // 250 movable / 40 active entrants / 4 courts predicts rung 3 -> 3 credits.
    const credits = quoteRun([{ key: DIVISION_ID, input: LARGE }], schedulingRungWeights()).credits;
    expect(credits).toBe(3);
    expect(runButton(html)).toContain(`${credits} credits`);
  });

  it("a frozen board names no price", () => {
    // The card is hidden on a frozen board because "quoting it would be a price
    // for something that is not on offer" — the disabled button underneath it
    // must not go on quoting one.
    const html = renderConsole({ scheduleFrozen: true });
    expect(html).toContain(enText["board.ai.frozen"]); // the frozen notice is rendered…
    expect(runButton(html)).not.toContain("credits");
    expect(runButton(html)).toContain("Generate schedule");
  });
});

// ------------------------------------------- the OTHER half of agreement
// `quoteRun` being shared makes the arithmetic agree. It does nothing about the
// INPUTS, and that is where the two sides actually drift: the server narrows
// movable fixtures by scope in repair mode only (schedule-ai.ts:319) and counts
// entrants `status not in ('withdrawn','disqualified')` (:505).
describe("the RungInput the client builds", () => {
  const briefFor = (over: Partial<AiBriefContext> = {}): AiBriefContext => ({
    ...RUNG3_BRIEF,
    ...over,
  });

  it("prices on the entrants the server prices on, not the picker's list", () => {
    // 40 movable / 2 courts. With the server's 20 active entrants the score is
    // 40 + 10 + 4 = 54 → rung 1. With the picker's unfiltered 60 it is
    // 40 + 30 + 4 = 74 → rung 2. One credit or two, for the same run.
    const brief = briefFor({
      courts: ["Court 1", "Court 2"],
      movableFixtures: Array.from({ length: 40 }, (_, i) =>
        movableFixture(i, "Court 1", "2026-08-01T10:00:00.000Z"),
      ),
      entrants: Array.from({ length: 60 }, (_, i) => ({ id: `e${i}`, name: `Team ${i}` })),
      activeEntrants: 20,
    });
    const [priced] = scheduleQuoteLines(DIVISION_ID, brief, "generate", undefined, null);
    expect(priced.input).toEqual({ movableFixtures: 40, entrants: 20, courts: 2 });
    expect(quoteRun([{ key: "d", input: priced.input }], schedulingRungWeights()).credits).toBe(1);
    // The lazy version — `brief.entrants.length` — really does cost more.
    expect(
      quoteRun(
        [{ key: "d", input: { ...priced.input, entrants: brief.entrants.length } }],
        schedulingRungWeights(),
      ).credits,
    ).toBe(2);
  });

  it("quotes a scoped repair on the fixtures in scope, not the whole division", () => {
    // Repair scoped to one court: 5 of 250 fixtures. Unnarrowed that is a
    // rung-3 card (3 credits) in front of a rung-1 charge.
    const brief = briefFor({
      movableFixtures: [
        ...Array.from({ length: 245 }, (_, i) =>
          movableFixture(i, "Court 1", "2026-08-01T10:00:00.000Z"),
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          movableFixture(500 + i, "Court 9", "2026-08-01T10:00:00.000Z"),
        ),
      ],
    });
    const scope = { courts: ["Court 9"] };
    const repair = scheduleQuoteLines(DIVISION_ID, brief, "repair", scope, null);
    expect(repair[0].input.movableFixtures).toBe(5);
    expect(quoteRun(toQuoteLineInputs(repair), schedulingRungWeights()).credits).toBe(1);

    // …and generate/refine re-plan the whole set even when a scope is present,
    // exactly as the server does. A client that narrowed unconditionally would
    // UNDER-quote, which is the dangerous direction.
    for (const mode of ["generate", "refine"] as const) {
      const lines = scheduleQuoteLines(DIVISION_ID, brief, mode, scope, null);
      expect(lines[0].input.movableFixtures, mode).toBe(250);
      expect(quoteRun(toQuoteLineInputs(lines), schedulingRungWeights()).credits).toBe(3);
    }
  });

  it("mirrors inScope: a court-less fixture is always in scope, and `from` is inclusive", () => {
    const fixtures = [
      movableFixture(1, "Court 1", "2026-08-01T09:00:00.000Z"),
      movableFixture(2, "Court 9", "2026-08-01T10:00:00.000Z"),
      { id: "tray", scheduled_at: null, court_label: null },
    ];
    // A fixture with no court survives a court scope (server: `court_label === null || …`).
    expect(
      movableForRun(fixtures, "repair", { courts: ["Court 9"] }).map((f) => f.id),
    ).toEqual(["f2", "tray"]);
    // `from` is >=, and an unscheduled fixture is never filtered out by it.
    expect(
      movableForRun(fixtures, "repair", { from: "2026-08-01T10:00:00.000Z" }).map((f) => f.id),
    ).toEqual(["f2", "tray"]);
  });

  it("sizes the officials quote from the officials pack, not the division", () => {
    // The pack holds fixtures that have a time and are not decided, with the
    // DISTINCT entrants and courts of exactly those — a decided fixture, an
    // untimed one, and a repeated entrant must each be handled.
    const fixtures = [
      fx("a", { status: "scheduled", at: "2026-08-01T09:00:00.000Z", court: "Court 1", home: "e1", away: "e2" }),
      fx("b", { status: "scheduled", at: "2026-08-01T10:00:00.000Z", court: "Court 1", home: "e1", away: "e3" }),
      fx("c", { status: "decided", at: "2026-08-01T08:00:00.000Z", court: "Court 2", home: "e4", away: "e5" }),
      fx("d", { status: "scheduled", at: null, court: null, home: "e6", away: "e7" }),
    ];
    // No proposal yet: only the two timed, undecided fixtures count. Entrants
    // e1/e2/e3 = 3 distinct (e1 appears twice), one court.
    expect(officialsQuoteInput(fixtures, [])).toEqual({
      movableFixtures: 2,
      entrants: 3,
      courts: 1,
    });
    // Phase A's dry-run proposal gives the untimed fixture a slot on a new
    // court — the officials pack then includes it, exactly as the server's
    // `scheduleOverride` does.
    expect(
      officialsQuoteInput(fixtures, [
        { fixture_id: "d", scheduled_at: "2026-08-01T11:00:00.000Z", court_label: "Court 3" },
      ]),
    ).toEqual({ movableFixtures: 3, entrants: 5, courts: 2 });
  });
});
