"use client";

// The confirm card an organiser reads BEFORE credits are spent — #348 §8 (the
// single-division card, both AI phases) and #350 §7 (the joint, per-division
// breakdown), in ONE component because they are the same card with one line or
// several.
//
// PRICING IS NOT REIMPLEMENTED HERE. `quoteRun` in lib/ai-rung.ts is pure and
// I/O-free precisely so the client can call the very function the server prices
// with; the card displays what it returns and nothing it computed itself. The
// server always recomputes at run time — this number is advisory — but a card
// that says 4 while the invoice says 5 is a support ticket about being
// overcharged, so "advisory" must never mean "different".
//
// Agreement needs BOTH halves: the same function AND the same inputs. The
// second half is the caller's job and is the easy one to get wrong — see the
// `RungInput` contract on `AiBriefContext` in ai-console.tsx, where the client
// has to mirror the server's repair-mode scope narrowing and its
// withdrawn/disqualified entrant filter.
//
// Visually it is a receipt, because that is what it is: an itemised list, a
// discount line, a rule, a total. Hence the right-hand amount column, the
// tabular figures (a bill whose digits do not line up is not a bill) and the
// single violet accent reserved for the total. Everything else is the console's
// existing slate vocabulary, so the card reads as part of the dock rather than
// as a payment page that wandered in.
import { useRef, type ReactNode } from "react";
import { usePlural, type useMsg } from "@/components/i18n/dict-provider";
import {
  freeDraftQuote,
  quoteRun,
  schedulingRungWeights,
  tokenBudgetForCredits,
  type Quote,
  type QuoteLineInput,
  type Rung,
  type RungInput,
  type RungWeights,
} from "@/lib/ai-rung";

export const RUNGS: Rung[] = [1, 2, 3];

/** One priced unit of work as the BOARD holds it. `chosen: null` means "follow
 *  the prediction" — the console's reducer state before the organiser touches
 *  the control, and what a click on the recommended chip returns to.
 *  `label: null` selects the single-division layout. */
export interface QuoteCardLine {
  key: string;
  label: string | null;
  input: RungInput;
  chosen: number | null;
}

export interface QuoteCardOptions {
  /** Phase A passes `schedulingRungWeights()` (the default); Phase B MUST pass
   *  `officialsRungWeights()` — officials packs are lighter and their
   *  thresholds sit higher, so scheduling weights would over-quote every
   *  officials run. */
  weights?: RungWeights;
  /** Phase B's empty-instruction path returns the deterministic solver draft
   *  with no model call, quoted flat at 1 credit (`freeDraftQuote`). Sizing it
   *  would charge a large division 2-3 credits for a run that spends nothing. */
  freeDraft?: boolean;
}

/**
 * The boundary between the board's `chosen: number | null` and `quoteRun`'s
 * `chosen?: number`.
 *
 * A `null` passed straight through happens to price correctly today, because
 * `quoteRun` tests `chosen !== undefined && isRung(chosen)` and `isRung(null)`
 * is false — so it falls through to the prediction. That is an accident of two
 * independent guards agreeing, not a contract: narrow `isRung`'s test and every
 * unmodified line silently reprices. Convert explicitly and let the conversion
 * be the thing the test pins.
 */
export function toQuoteLineInputs(lines: QuoteCardLine[]): QuoteLineInput[] {
  return lines.map((l) => ({
    key: l.key,
    input: l.input,
    chosen: l.chosen === null ? undefined : l.chosen,
  }));
}

/** The ONE quote both the card and its caller's CTA read. Two call sites
 *  pricing the same run separately is exactly how a CTA and a card come to
 *  disagree, so there is one function, it takes the board's own line type, and
 *  it owns the free-draft special case too. */
export function quoteFor(lines: QuoteCardLine[], opts: QuoteCardOptions = {}): Quote {
  if (opts.freeDraft) return freeDraftQuote(lines[0]?.key ?? "run");
  return quoteRun(toQuoteLineInputs(lines), opts.weights ?? schedulingRungWeights());
}

/**
 * Radiogroup keyboard reducer (WAI-ARIA radio group pattern): arrows move AND
 * select, wrapping at both ends; Home/End jump to the ends; anything else is
 * left to the browser so Tab still leaves the group. Pure so the behaviour is
 * testable without a DOM.
 */
export function rungForKey(key: string, current: Rung): Rung | null {
  const i = RUNGS.indexOf(current);
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return RUNGS[(i + 1) % RUNGS.length];
    case "ArrowLeft":
    case "ArrowUp":
      return RUNGS[(i - 1 + RUNGS.length) % RUNGS.length];
    case "Home":
      return RUNGS[0];
    case "End":
      return RUNGS[RUNGS.length - 1];
    default:
      return null;
  }
}

/**
 * What picking `rung` MEANS for a line the server predicted at `predicted`.
 *
 * Picking the recommended rung yields `null` — "server, size this yourself" —
 * not the number. Without this, clicking the already-selected chip is a visual
 * no-op that silently flips the request from "follow your own prediction" to
 * "charge me my client-side guess", freezing a stale estimate into the price;
 * and `chosen: null` becomes unreachable the moment the control is touched, so
 * "follow the recommendation" could never be got back to.
 */
export function pickValue(rung: Rung, predicted: Rung): number | null {
  return rung === predicted ? null : rung;
}

/** Helper-text token counts, rounded to the nearest thousand ("~45K"). The
 *  estimate is uncalibrated and advisory (lib/ai-rung.ts), so showing it to the
 *  token would claim a precision it does not have. */
export function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(Math.round(n));
}

export function AiQuoteCard({
  lines,
  onChange,
  msg,
  busy,
  weights,
  freeDraft = false,
}: {
  lines: QuoteCardLine[];
  onChange: (key: string, rung: number | null) => void;
  msg: ReturnType<typeof useMsg>;
  busy: boolean;
} & QuoteCardOptions) {
  const plural = usePlural();
  const quote = quoteFor(lines, { weights, freeDraft });
  const joint = quote.lines.length > 1;

  // "Very large" means the work outgrows what the TOP rung can buy — #348 §8's
  // "predicted > rung-3 capacity → still allow it, warn". It is measured
  // against the budget the PREDICTIONS would buy, never against the budget the
  // organiser happens to have chosen: comparing to `quote.budget` makes every
  // under-funded pick also claim the division should be split, which is both
  // wrong (the division is fine) and a second warning saying what the
  // underfunded one already said.
  //
  // Attributed PER LINE, because "split the division" is only actionable if the
  // organiser is told which one. A joint run can also outgrow its budget with
  // no single division at fault — a different problem with different advice
  // (run fewer divisions together), so it gets its own line.
  const oversized = freeDraft
    ? []
    : quote.lines.filter((l) => l.estTokens > tokenBudgetForCredits(l.predictedRung));
  // EVERY oversized line gets a name. Dropping the unnamed ones instead
  // (`.filter(Boolean)`) means a joint run whose oversized lines are all
  // unlabelled yields an empty list and falls through to the singular
  // "split the division" copy — the very bug the attribution replaced,
  // reappearing through the back door.
  const oversizedNames = oversized.map(
    (l) => lines.find((x) => x.key === l.key)?.label ?? msg("board.ai.quote.thisDivision"),
  );
  const predictedBudget = tokenBudgetForCredits(
    quote.lines.reduce((n, l) => n + l.predictedRung, 0),
  );
  const jointTooBig = !freeDraft && oversized.length === 0 && quote.estTokens > predictedBudget;

  return (
    <section
      aria-label={msg("board.ai.quote.aria")}
      data-ai-credits={quote.credits}
      className="rounded-lg border border-slate-200 bg-white"
    >
      <p className="border-b border-slate-100 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {msg("board.ai.quote.title")}
      </p>

      <ul className="divide-y divide-slate-100">
        {quote.lines.map((priced, i) => {
          const line = lines[i];
          return (
            <li key={priced.key} className="px-3 py-2.5">
              {/* Name + amount. The only side-by-side pair on the card, and the
                  amount is 1-2 characters — so 375px never needs to scroll. */}
              {joint && (
                <p className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-700">
                    {line.label ?? msg("board.ai.quote.thisDivision")}
                  </span>
                  <span
                    data-ai-line-rung={priced.rung}
                    className="shrink-0 text-xs font-semibold tabular-nums text-slate-700"
                  >
                    <span className="sr-only">{plural("board.ai.quote.credits", priced.rung)}</span>
                    <span aria-hidden>{priced.rung}</span>
                  </span>
                </p>
              )}
              <p
                data-ai-line-tokens={priced.estTokens}
                className={`text-[11px] text-slate-500 ${joint ? "mt-0.5" : ""}`}
              >
                {/* The free draft spends no tokens at all, so an estimate of
                    "~0 tokens" would be noise dressed as information. */}
                {freeDraft
                  ? msg("board.ai.quote.sizePlain", {
                      fixtures: line.input.movableFixtures,
                      courts: line.input.courts,
                    })
                  : msg("board.ai.quote.size", {
                      fixtures: line.input.movableFixtures,
                      courts: line.input.courts,
                      tokens: formatTokens(priced.estTokens),
                    })}
              </p>
              {freeDraft ? (
                <p className="mt-1.5 text-[11px] text-slate-500">
                  {msg("board.ai.quote.freeDraft")}
                </p>
              ) : (
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <RungChips
                    value={priced.rung}
                    busy={busy}
                    ariaLabel={
                      line.label
                        ? msg("board.ai.quote.rungAriaDivision", { division: line.label })
                        : msg("board.ai.quote.rungAria")
                    }
                    onPick={(r) => onChange(priced.key, pickValue(r, priced.predictedRung))}
                  />
                  <span className="text-[11px] text-slate-500">
                    {msg("board.ai.quote.predicted", { n: priced.predictedRung })}
                  </span>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {/* The discount is a JOINT-run rule (max(1, sum - 1)); a lone rung-2
          division costs 2, not 1. So this block belongs to the joint layout,
          not to "discount happens to be non-zero". */}
      {joint && (
        <div className="px-3 py-2.5 text-xs">
          <p className="flex items-baseline justify-between gap-3 text-slate-500">
            <span>{msg("board.ai.quote.discount")}</span>
            <span
              data-ai-discount={quote.discount}
              className="shrink-0 font-medium tabular-nums text-teal-700"
            >
              {msg("board.ai.quote.discountAmount", { count: quote.discount })}
            </span>
          </p>
          <p className="mt-2 flex items-baseline justify-between gap-3 border-t border-slate-300 pt-2">
            <span className="font-medium text-slate-700">{msg("board.ai.quote.total")}</span>
            <strong className="shrink-0 text-lg font-semibold leading-none tabular-nums text-violet-700">
              {plural("board.ai.quote.credits", quote.credits)}
            </strong>
          </p>
        </div>
      )}

      <div className="space-y-1.5 px-3 pb-3 pt-2">
        {/* The copy rule from #348 §8: credits buy a BUDGET, not usage. Omitted
            for the free draft — it makes no model call, so promising it a
            thinking budget would describe a run that does not happen. */}
        {!freeDraft && (
          <p className="text-[11px] text-slate-500" data-ai-budget={quote.budget}>
            {msg("board.ai.quote.budget", { tokens: formatTokens(quote.budget) })}
          </p>
        )}
        {quote.underfunded && <Caution>{msg("board.ai.quote.underfunded")}</Caution>}
        {oversized.length > 0 && (
          <Caution>
            {joint
              ? plural("board.ai.quote.veryLargeDivisions", oversizedNames.length, {
                  divisions: oversizedNames.join(", "),
                })
              : msg("board.ai.quote.veryLarge")}
          </Caution>
        )}
        {jointTooBig && <Caution>{msg("board.ai.quote.veryLargeJoint")}</Caution>}
      </div>
    </section>
  );
}

function Caution({ children }: { children: ReactNode }) {
  return (
    <p
      role="status"
      className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] leading-snug text-amber-900"
    >
      <span aria-hidden>⚠</span>
      <span>{children}</span>
    </p>
  );
}

/** 1 / 2 / 3, styled as the console's existing segmented control but wired as a
 *  real radio group: one tab stop (roving tabindex), arrows move the selection
 *  AND the focus, and the focus ring is visible because this control spends
 *  money.
 *
 *  Moving focus is not a detail. Without it an arrow press leaves the ring and
 *  the screen-reader cursor on an unchecked chip while a DIFFERENT chip carries
 *  `aria-checked` and `tabIndex={0}` — a keyboard user cannot tell what they
 *  have selected. Static markup cannot prove a focus move, so the assertion
 *  lives in Task 9's Playwright e2e; see the report for the exact behaviour. */
function RungChips({
  value,
  busy,
  ariaLabel,
  onPick,
}: {
  value: Rung;
  busy: boolean;
  ariaLabel: string;
  onPick: (rung: Rung) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5"
    >
      {RUNGS.map((r, i) => {
        const active = r === value;
        return (
          <button
            key={r}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={busy}
            data-rung={r}
            onClick={() => onPick(r)}
            onKeyDown={(e) => {
              const next = rungForKey(e.key, value);
              if (!next) return;
              e.preventDefault();
              onPick(next);
              // Roving tabindex: DOM focus has to follow the selection, or the
              // ring is left behind on a chip that is no longer checked.
              refs.current[RUNGS.indexOf(next)]?.focus();
            }}
            className={`w-7 rounded-md py-0.5 text-xs font-semibold tabular-nums transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-1 disabled:opacity-40 ${
              active ? "bg-white text-violet-700 shadow-sm" : "text-slate-500 hover:text-violet-700"
            }`}
          >
            {r}
          </button>
        );
      })}
    </div>
  );
}
