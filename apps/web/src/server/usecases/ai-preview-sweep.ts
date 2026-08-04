import { sql } from "@/lib/db";

/** How long a CONSUMED preview is kept. V345 stores `raw` beside `resolved`
 *  precisely so a disputed compile can be re-derived and diffed against what
 *  the organiser was shown; that is only worth anything for as long as a
 *  dispute is live. 30 days is long enough to answer one and short enough to
 *  be a retention period rather than "forever". */
const SPENT_RETENTION_DAYS = 30;

/**
 * #403 — storage limitation for the one table in the scheduling programme that
 * persists an organiser's raw free-text instruction.
 *
 * `ai_parse_previews.instruction` is the sentence the organiser typed, verbatim.
 * That is exactly the field the data-protection review flags as able to carry
 * personal data about individuals ("keep X away from Y"). V345 gives every row
 * a 30-minute life (`expires_at`) and ships a partial index commented "Sweep
 * support" — and until this, nothing swept: rows survived until the whole org
 * was deleted.
 *
 * Two classes, because they stop being useful for different reasons:
 *  - unconsumed and expired — the organiser walked away from the preview. It can
 *    never be run (the run gate requires `consumed_at is null and expires_at >
 *    now()`), so it is dead weight the moment it expires.
 *  - consumed, older than the dispute window — it did run, and the run it
 *    authorised is on the board.
 *
 * Deliberately not tenant-scoped: this is a cron-driven housekeeping job with no
 * request org, and it follows the same plain-client pattern as the billing
 * webhook sweeps (billing-events.ts) which already write to force-RLS tables.
 */
export async function sweepExpiredPreviews(): Promise<{ expired: number; spent: number }> {
  const expired = await sql<{ id: string }[]>`
    delete from ai_parse_previews
    where consumed_at is null and expires_at < now()
    returning id`;
  const spent = await sql<{ id: string }[]>`
    delete from ai_parse_previews
    where consumed_at is not null
      and consumed_at < now() - (${SPENT_RETENTION_DAYS} || ' days')::interval
    returning id`;
  return { expired: expired.length, spent: spent.length };
}
