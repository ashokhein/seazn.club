"use client";
// The wrap-up prompt (v17 gap #362) — "prompt, don't sweep", made visible.
//
// The settings page has carried a status nudge for a long time, and #362 makes
// it date-aware; but an organiser who has stopped visiting a finished
// competition never opens its settings, so the nudge alone reaches nobody in
// the population it is meant for. This is the same question, on the surface
// they land on.
//
// TWO answers, both already-modelled states:
//
//   "it finished"     → status `completed`, the `terminal` arm. PATCHed here,
//                       through the same /api/v1 route the settings nudge uses
//                       (v17 SPEC-4 §7 — there is no other status writer, and a
//                       second one would be a second place to get authorisation
//                       and lifecycle events wrong).
//   "the date moved"  → a link to settings, where `ends_on` is edited. It is a
//                       date field with a picker, not a one-click answer, so it
//                       stays where it already works.
//
// No dismissal. Nothing here is remembered: the prompt is a pure function of
// `status` and `ends_on` (see `needsWrapUp`), so answering it removes it and
// ignoring it leaves it — which is exactly the honest behaviour when the
// underlying state really has not been resolved. A "remind me later" flag would
// be a fourth piece of lifecycle state, and SPEC-4 §13.1's whole argument is
// against storing what can be computed.
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "@/components/ui/console-link";
import { CalendarX2 } from "lucide-react";
import { apiV1 } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";

export function CompetitionWrapUpPrompt({
  competitionId,
  endedOnLabel,
  settingsHref,
}: {
  competitionId: string;
  /** `ends_on`, already formatted by the server — see the page for the tz. */
  endedOnLabel: string;
  settingsHref: string;
}) {
  const msg = useMsg();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function markCompleted() {
    setError(null);
    setBusy(true);
    try {
      await apiV1(`/api/v1/competitions/${competitionId}`, {
        method: "PATCH",
        json: { status: "completed" },
      });
      // The prompt is derived from the row, so a refresh is what removes it —
      // there is no local "dismissed" state to set, and setting one would let
      // the banner disappear on a PATCH that had actually failed.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("comp.wrapUp.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"
      aria-labelledby="wrapup-title"
    >
      <div className="flex flex-wrap items-start gap-3">
        <CalendarX2 className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" strokeWidth={1.75} />
        <div className="min-w-0 flex-1">
          <h2 id="wrapup-title" className="text-sm font-semibold text-amber-900">
            {msg("comp.wrapUp.title")}
          </h2>
          <p className="mt-0.5 text-sm text-amber-800">
            {msg("comp.wrapUp.body", { date: endedOnLabel })}
          </p>
          {error && (
            <p role="alert" className="mt-2 text-sm font-medium text-red-700">
              {error}
            </p>
          )}
          {/* Stacks under `sm` so both 44px targets stay full-width at 375px. */}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={() => void markCompleted()}
              disabled={busy}
              className="btn btn-primary disabled:opacity-50"
            >
              {busy ? msg("comp.wrapUp.completing") : msg("comp.wrapUp.complete")}
            </button>
            <Link href={settingsHref} className="btn btn-ghost text-amber-900">
              {msg("comp.wrapUp.changeDate")}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
