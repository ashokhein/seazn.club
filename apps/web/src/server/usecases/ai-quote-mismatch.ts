// #387 — did the organiser get charged what the confirm card promised?
//
// The card computes its quote by calling the same pure function the server
// calls (`quoteRun` in lib/ai-rung.ts). That design is deliberate and good: no
// per-keystroke fetch, one arithmetic implementation. It rests on one premise —
// same function, same inputs, same environment — and PR #359 found three ways
// that premise breaks. #385 closed the largest of them.
//
// DETECTION IS SERVER-SIDE. The client sends the number its card showed; the
// server compares it against what it actually charged. The telemetry then fires
// even when nobody is looking at the screen, and the event is written by the
// side that knows the truth about the charge.
//
// This is TELEMETRY, NOT A GATE. A mismatch never refuses a run and never
// alters a plan: the organiser already paid, and refusing here would take their
// credit and give them nothing. It is recorded and reported.
import { withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";

/** What the response carries when the two disagree — see `AiRunPriceFields`. */
export interface QuoteMismatch {
  quoted: number;
  charged: number;
}

export const QUOTE_MISMATCH_EVENT = "schedule.ai_quote_mismatch" as const;

/**
 * Compare the card's quote to the charge, record the divergence, return it.
 *
 * Called by all three run paths (`schedule-ai.ts`, `competition-schedule-ai.ts`,
 * `officials-ai.ts`) so they cannot come to different conclusions about what
 * counts as a mismatch — a fork between those three is what produced the
 * divergence #387 is about in the first place.
 *
 * `undefined` quoted is SILENCE, not zero: server-side callers, smoke and every
 * external consumer send nothing, and reading that as "quoted 0" would file a
 * mismatch against every one of them.
 *
 * Best-effort BY CONSTRUCTION AND BY CATCH, and it needs both. It is called
 * AFTER the run's own ledger row, so the credit is already spent and the plan
 * already generated — but the three call sites await it bare, inside functions
 * whose outer wrapper re-throws once `claim.creditConsumed` is true. An
 * uncaught insert failure there would turn a paid, successful run into a 500,
 * which is the exact outcome this telemetry exists to avoid causing. So the
 * write is caught here, once, rather than at each call site where a fourth
 * path would forget it.
 *
 * The catch does NOT suppress the return value. The comparison is pure and
 * already known to be true by this point; a lost telemetry row is no reason to
 * tell the caller their quote matched when it did not.
 */
export async function recordQuoteMismatch(
  auth: AuthCtx,
  ctx: { competitionId: string; divisionIds: string[] },
  quoted: number | undefined,
  charged: number,
): Promise<QuoteMismatch | undefined> {
  if (quoted === undefined || quoted === charged) return undefined;
  try {
    await withTenant(auth.orgId, async (tx) => {
      await tx`
        insert into competition_events (competition_id, org_id, type, payload, actor_id)
        values (${ctx.competitionId}, ${auth.orgId}, ${QUOTE_MISMATCH_EVENT},
                ${tx.json({
                  quoted,
                  charged,
                  // Which run this was about. A competition-scoped event with no
                  // division ids cannot be traced back to the pack that was
                  // priced, which is the whole point of recording it.
                  division_ids: ctx.divisionIds,
                  // Direction, denormalised so an analytics query does not have
                  // to recompute it: `over` means the organiser paid more than
                  // the card promised, which is the complaint-shaped one.
                  direction: charged > quoted ? "over" : "under",
                } as never)}, ${auth.userId})`;
    });
  } catch (err) {
    console.warn("[quote-mismatch] record failed:", err);
  }
  return { quoted, charged };
}
