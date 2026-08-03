"use client";

// W5 (#400) Task 6 — the receipt for a compiled instruction.
//
// The organiser typed a sentence. Before a credit moves, this card shows them
// what the machine actually made of it: the rules the referee will check, the
// wishes it will merely aim for, the words it could not use at all, and how it
// read the calendar. Declining is a client no-op — nothing here has been paid
// for, which is the whole point of the gate.
//
// THE SIGNATURE IS THE RULE LEDGER. A hairline vertical spine runs down the
// left of the enforced list with a monospace constraint token sitting on it and
// the plain-English reading to its right. The spine is structural, not
// decorative: SOLID violet means binding, and the preferences list below repeats
// the same shape with a DASHED slate spine, so "this one is enforced and that
// one is not" is legible before a single word is read. Everything else stays
// inside the existing card idiom — `rounded-lg border border-slate-200`, 11px
// uppercase section labels, mono chips on `ring-1 ring-inset`. The boldness is
// spent on the spine and nowhere else.
//
// The tokens are the engine's own six constraint kinds, deliberately not rule
// codes: every compiled instruction rule verifies as H8, so an H8 chip would
// print the same character on every row and say nothing.
import { useMsg, usePlural } from "@/components/i18n/dict-provider";
import { useLocale } from "@/components/i18n/dict-provider";
import type { AiParsePreviewResponse } from "@/server/api-v1/schemas";
import {
  constraintToken,
  describeHardConstraint,
  type NameLookup,
} from "./ai-instruction-describe";

/** Section label — one shape for all five, so the card reads as one object. */
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{children}</p>
  );
}

/** A token chip on the ledger spine. `shrink-0` because the token is the row's
 *  identity — a long reading may wrap, the code never squeezes. */
function Token({ children, tone }: { children: React.ReactNode; tone: "hard" | "soft" }) {
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-4 ring-1 ring-inset ${
        tone === "hard"
          ? "bg-violet-50 text-violet-700 ring-violet-200"
          : "bg-slate-50 text-slate-500 ring-slate-200"
      }`}
    >
      {children}
    </span>
  );
}

export function AiInstructionPreview({
  preview,
  credits,
  names,
  onConfirm,
  onDismiss,
  onAsPreference,
}: {
  preview: AiParsePreviewResponse;
  /** What confirming will cost. Named AT the confirm, never only above it. */
  credits: number;
  /** Resolves a narrowed scope to a name the organiser recognises. Omitted on a
   *  console that knows none — the reading then says the rule is narrowed
   *  without inventing a division name. */
  names?: NameLookup;
  onConfirm: () => void;
  onDismiss: () => void;
  /** Explicit fallback after a failed compile: run the sentence as a preference,
   *  with nothing pretending it is enforced. Never called automatically. */
  onAsPreference: () => void;
}) {
  const msg = useMsg();
  const plural = usePlural();
  const appLocale = useLocale();
  // "en" formats dates US-style ("Aug 7, 2026"); the board's day tabs pin the
  // same thing for the same reason (lib/day-label.ts).
  const locale = appLocale === "en" ? "en-GB" : appLocale;
  const ctx = { msg, plural, names: names ?? (() => null), locale };

  const { hard, soft, unparsed, assumptions } = preview.compiled;
  // `failed` and a missing `preview_id` are the SAME thing to this card, and the
  // schema does not tie them together: `AiParsePreviewResponse` permits
  // `failed: false` with the id absent. `canRun` reads the id, so rendering the
  // confirm on `failed === false` alone drew a live-looking button that did
  // nothing and gave no reason (#400 Task 6b). Nothing to confirm is a failure,
  // whatever the flag says — and the fallback is still offered, so the
  // organiser is never stranded.
  const failed = preview.failed || !preview.preview_id;
  // Hard AND soft empty is a compile that produced nothing. An empty list would
  // render as a success, so the card says the words out loud instead.
  const nothingEnforceable = !failed && hard.length === 0 && soft.length === 0;

  const creditLabel = plural("board.ai.quote.credits", credits);

  return (
    <section
      aria-label={msg("board.ai.preview.title")}
      data-preview-state={failed ? "failed" : "ready"}
      className={`rounded-lg border p-3 ${
        failed ? "border-amber-200 bg-amber-50/60" : "border-slate-200 bg-white"
      }`}
    >
      {failed ? (
        <>
          <p className="flex items-start gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-800">
            <span aria-hidden className="shrink-0">
              ⚠
            </span>
            <span className="min-w-0">{msg("board.ai.preview.failed.title")}</span>
          </p>
          <p className="mt-1 text-[11px] leading-snug text-amber-900/80">
            {msg("board.ai.preview.failed.hint")}
          </p>
        </>
      ) : (
        // "Read as" over nothing is a heading with no list under it. When the
        // compile produced no rule at all, the card leads with the statement
        // instead — see the empty block below.
        !nothingEnforceable && (
          <>
            <Eyebrow>{msg("board.ai.preview.readAs")}</Eyebrow>
            <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
              {msg("board.ai.preview.readAsHint")}
            </p>
          </>
        )
      )}

      {nothingEnforceable && (
        <p
          data-preview-empty="1"
          className="rounded-md border border-slate-200 bg-slate-50/70 px-2.5 py-2 text-xs leading-snug text-slate-600"
        >
          {msg("board.ai.preview.empty")}
        </p>
      )}

      {/* The ledger. Solid violet spine = these bind. */}
      {hard.length > 0 && (
        <ul className="mt-2 space-y-2 border-l-2 border-violet-300 pl-3">
          {hard.map((c, i) => (
            <li
              key={i}
              data-preview-rule="hard"
              className="flex flex-wrap items-start gap-x-2 gap-y-1"
            >
              <Token tone="hard">{constraintToken(c)}</Token>
              <span className="min-w-0 flex-1 basis-40 text-xs leading-relaxed text-slate-700">
                {describeHardConstraint(c, ctx)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* Same shape, DASHED spine. The one thing an organiser must not
          misread is a wish as a rule, so the section says it in the heading,
          repeats it in the hint, and encodes it in the spine itself.

          #400 Task 6b — and it names the MECHANISM, not the intention. These
          notes reach exactly one place, the architect's prompt
          (`schedule-ai-prompt.ts:135`); they never reach the verifier. The
          token was `PREFER`, which reads as *the system will try*, and beside a
          clause we cannot model at all — "the show court where families can
          watch" — it reads as *the system understood*. There is no court
          attribute concept in the engine and no `HardConstraint` variant
          selects a court, so that clause is structurally unenforceable however
          well it is phrased; #440 (court identity + a court selector) is what
          would change that, and until it lands the honest word is that we sent
          it on. Unlike the six constraint tokens above, this one IS translated:
          it is a claim about what we did, not a code for a rule kind. */}
      {soft.length > 0 && (
        <div className="mt-3">
          <Eyebrow>{msg("board.ai.preview.soft.title")}</Eyebrow>
          <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
            {msg("board.ai.preview.soft.hint")}
          </p>
          <ul className="mt-2 space-y-2 border-l-2 border-dashed border-slate-300 pl-3">
            {soft.map((sfx, i) => (
              <li
                key={i}
                data-preview-rule="soft"
                className="flex flex-wrap items-start gap-x-2 gap-y-1"
              >
                <Token tone="soft">{msg("board.ai.preview.soft.token")}</Token>
                <span className="min-w-0 flex-1 basis-40 break-words text-xs leading-relaxed text-slate-600">
                  {sfx.note}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The organiser's own words, untouched. Quoting them verbatim is the
          honest move: paraphrasing what we failed to understand would suggest
          we understood it. */}
      {unparsed.length > 0 && (
        <div className="mt-3">
          <Eyebrow>{msg("board.ai.preview.unparsed.title")}</Eyebrow>
          <div className="mt-1.5 space-y-1.5">
            {unparsed.map((line, i) => (
              <blockquote
                key={i}
                data-preview-unparsed="1"
                className="break-words border-l-2 border-slate-200 pl-3 text-xs italic leading-snug text-slate-500"
              >
                {line}
              </blockquote>
            ))}
          </div>
          <p className="mt-1 text-[11px] leading-snug text-slate-400">
            {msg("board.ai.preview.unparsed.hint")}
          </p>
        </div>
      )}

      {/* RESOLVER assumptions — stage 1, deterministic, how we read the
          calendar. NOT the architect's own assumptions, which are stage 2 and
          ride on the plan response into the review panel. */}
      {assumptions.length > 0 && (
        <div className="mt-3">
          <Eyebrow>{msg("board.ai.preview.assumed.title")}</Eyebrow>
          <ul className="mt-1.5 space-y-1">
            {assumptions.map((line, i) => (
              <li
                key={i}
                data-preview-assumption="1"
                className="flex flex-wrap items-start gap-x-2 gap-y-0.5"
              >
                <span aria-hidden className="mt-px shrink-0 font-mono text-[11px] text-slate-400">
                  ~
                </span>
                <span className="min-w-0 flex-1 basis-40 break-words text-[11px] leading-snug text-slate-600">
                  {line}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The dates the INSTRUCTION claimed, in the org's zone — null when it
          claimed none, and never back-filled with the run's default window. */}
      {preview.window && (
        <p
          data-preview-window="1"
          className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-t border-slate-100 pt-2 font-mono text-[11px] text-slate-500"
        >
          <span className="shrink-0 font-sans font-semibold uppercase tracking-wide text-slate-400">
            {msg("board.ai.preview.windowTitle")}
          </span>
          <span className="min-w-0 break-words">
            {msg("board.ai.preview.window", {
              start: preview.window.start,
              end: preview.window.end,
              tz: preview.window.tz,
            })}
          </span>
        </p>
      )}

      <div data-preview-actions="1" className="mt-3 flex flex-wrap gap-2">
        {failed ? (
          <>
            {/* Ghost, and second in the tab order after nothing: taking an
                unenforced run is a choice, not the happy path. */}
            <button
              type="button"
              data-preview-as-preference="1"
              onClick={onAsPreference}
              className="flex-[3] basis-48 rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-semibold text-amber-800 transition hover:bg-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
            >
              {msg("board.ai.preview.failed.asPreference")}
            </button>
            <button
              type="button"
              data-preview-dismiss="1"
              onClick={onDismiss}
              className="flex-1 basis-28 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
            >
              {msg("board.ai.preview.failed.edit")}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              data-preview-confirm="1"
              data-ai-credits={credits}
              onClick={onConfirm}
              className="flex-[3] basis-48 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
            >
              {msg("board.ai.preview.confirm", { credits: creditLabel })}
            </button>
            <button
              type="button"
              data-preview-dismiss="1"
              onClick={onDismiss}
              className="flex-1 basis-28 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
            >
              {msg("board.ai.preview.dismiss")}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
