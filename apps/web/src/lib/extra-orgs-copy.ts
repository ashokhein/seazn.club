// Which sentence a failed `POST /api/billing/extra-orgs` shows the buyer
// (v17 gap #293, Task 6). Pure `status -> DictionaryKey`, the same shape as
// `passCheckoutErrorKey` (lib/pass-ladder.ts), for the same reason: the route's
// `error` string is hardcoded English written for logs, and this surface ships
// in en/es/fr/nl.
//
// Client-safe: no `server-only`, no DB, no Stripe. `setExtraOrgs` lives in a
// `server-only` usecase and CANNOT be imported here — its numeric bound
// (MAX_EXTRA_ORGS) reaches the control as a prop from the server component
// instead of being restated, so the two cannot drift.
import type { DictionaryKey } from "@/lib/i18n-keys";

/**
 * THE POINT OF THIS FUNCTION IS THAT THE REFUSALS DO NOT COLLAPSE. Three of
 * them are separate ACTIONS by the customer, and telling someone to do the
 * wrong one is worse than saying nothing:
 *
 *   400  ORG/SESSION STATE ONLY, never input. `requireBillingOwner` raises it
 *        for "No active organization" and "No billing account for the selected
 *        organization" — both reachable from a stale org cookie on a page that
 *        rendered fine a minute ago. Remedy: pick an organisation again. It
 *        must NOT tell the buyer to fix a number; the route pushes every
 *        body-parse failure to 422 precisely to keep that promise.
 *   401  signed out — remedy: sign in. Kept apart from 403 because "sign in
 *        again" and "you are not the payer" are different situations, and a
 *        session that expired mid-page is the commoner one.
 *   403  signed in, but not this billing group's payer. Nothing they can do
 *        here; the copy names who can.
 *   409  the GROUP cannot hold the add-on at all — no live paid subscription,
 *        or a plan with no extra-org SKU. Remedy: CHANGE PLAN.
 *   422  the count is outside 0..MAX_EXTRA_ORGS, or the body was unparseable.
 *        Remedy: CHANGE THE NUMBER. Unreachable from this control (it clamps),
 *        so in practice this fires only for a hand-rolled request.
 *   423  the reduction would go below the organisations the group is USING.
 *        Remedy: MOVE AN ORGANISATION OUT first — neither a plan change nor a
 *        different number, which is exactly why the route gave it its own
 *        status.
 *   503  the Stripe catalog has not been synced for this account. Nothing the
 *        buyer did; remedy: try later / contact support.
 *   else 5xx, an unexpected Stripe failure escaping with raw English, or a
 *        rejected fetch (`status: null`). Nothing is known — say so and invite
 *        a retry rather than guessing.
 *
 * Note 409 and 503 are NOT merged even though both end in "not right now":
 * one is fixed by the customer changing plan and the other cannot be fixed by
 * the customer at all.
 */
export function extraOrgsErrorKey(status: number | null): DictionaryKey {
  switch (status) {
    case 400:
      return "addOns.extraOrg.error.orgState";
    case 401:
      return "addOns.extraOrg.error.signedOut";
    case 403:
      return "addOns.extraOrg.error.notPayer";
    case 409:
      return "addOns.extraOrg.error.planCannot";
    case 422:
      return "addOns.extraOrg.error.badCount";
    case 423:
      return "addOns.extraOrg.error.inUse";
    case 503:
      return "addOns.extraOrg.error.unavailable";
    default:
      return "addOns.extraOrg.error.generic";
  }
}

/** Every status the route documents, so a test can walk them rather than
 *  enumerate them by hand and forget one — the enumeration is itself the thing
 *  that gets forgotten. 500 is deliberately absent: it is the `default` arm,
 *  and pinning it here would let a future `case 500` pass unnoticed. */
export const EXTRA_ORGS_REFUSAL_STATUSES = [400, 401, 403, 409, 422, 423, 503] as const;
