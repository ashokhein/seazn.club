// Wrap-up prompt (v17 gap #362) — the answer to "nothing retires a live
// competition past its ends_on".
//
// Owner decision 2026-07-29: PROMPT, don't sweep. No cron moves a competition
// to `completed` on the organiser's behalf. SPEC-4 §13.1 is explicit about why
// — compute-at-read is what lets an organiser fix a wrong end date and get the
// entitlement back on the next read, and a swept `status` is a value they never
// chose, unrecoverable without staff.
//
// So the product asks instead. When a non-terminal competition passes its end
// date plus the grace, the organiser is shown the two things that could be
// true — it finished, or the date moved — and picks one. BOTH answers land the
// competition on an arm that already exists (`terminal` / a fresh
// `past_ends_on`), so nothing here needs a new lifecycle state, a dismissal
// column, or anything to reconcile: the prompt appears and disappears purely
// from `status` and `ends_on`.
//
// The rule is NOT re-derived here. `passLockReason` is the one definition,
// shared with the SQL (`pass_applies`, V343) and pinned to it by
// entitlements-sql-parity — this module asks it a question and names the
// answer in competition-lifecycle terms instead of pass terms.
import { passLockReason } from "./entitlements";

/**
 * Is this competition waiting for its organiser to say what happened?
 *
 * True exactly when the `past_ends_on` arm has fired: `ends_on` is set, more
 * than the 7-day grace has passed, and the status is still non-terminal (a
 * completed or archived competition answers `terminal` from the same call, so
 * it can never reach this).
 *
 * Deliberately NOT gated on holding an Event Pass. The date now drives three
 * enforcement sites — the pass overlay, `competitions.max_active`, and
 * freezability (#347/V343) — so a Community competition sitting past its end
 * date is in the same untidy state, with the same two possible explanations.
 * A prompt scoped to pass holders would leave most of the population unasked.
 */
export function needsWrapUp(status: string, endsOn: Date | string | null): boolean {
  return passLockReason(status, endsOn) === "past_ends_on";
}

/** Fixture counts for the competition, as the settings page aggregates them. */
export interface FixtureAgg {
  total: number;
  underway: number;
  done: number;
  scheduled: number;
}

/**
 * State-derived status nudge: published → live → completed as matches progress.
 *
 * Lived in `settings/page.tsx` until #362 — moved here so the DATE arm below is
 * shared with the overview's prompt, and so both are reachable from a unit test
 * (a function private to a server page is not).
 *
 * The date arm is FIRST and does not consult `agg`, which is the whole point:
 * the old rule needed `agg.total > 0` and then `done === total`, so a
 * competition abandoned with no fixtures at all — or with fixtures nobody ever
 * scored, which is what abandonment usually looks like — got no nudge from any
 * arm. That population is precisely the one #362 is about.
 *
 * It returns "completed" for any non-terminal status, `draft` included. A draft
 * whose end date passed is not a special case: it holds a slot against
 * `competitions.max_active` exactly like a live one, and the organiser's two
 * honest answers are still "it's over" or "the date moved".
 */
export function suggestStatus(
  status: string,
  endsOn: Date | string | null,
  agg: FixtureAgg,
): string | null {
  if (needsWrapUp(status, endsOn)) return "completed";
  if (agg.total === 0) return null;
  if (status === "live" && agg.done === agg.total) return "completed";
  if ((status === "draft" || status === "published") && agg.underway > 0) return "live";
  if (status === "draft" && agg.scheduled > 0) return "published";
  return null;
}
