import "server-only";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { walletIdFor } from "@/lib/credits";
import { logStaffAction } from "@/lib/admin";

/**
 * Staff GRANT of an add-on (design/v17-pricing-entitlements/SPEC-3 §1 row 3):
 * comp extra seats / a size pack / extra orgs for a sales deal. Writes ONE
 * `org_addons` row with `status='granted'` and `stripe_item_id=null` — the
 * additive-cap axis the resolver already sums (`lib/entitlements.addonBonus`,
 * `status in ('active','granted')`), so the cap rises on the very next check.
 * This is the admin WRITE path only; no Stripe object exists behind it.
 *
 * Keyed on the org's WALLET (`coalesce(group_subscription_id, org_id)`, SPEC-2
 * §11) so a group-wide grant (`targetOrgId=null`) lifts every org on the wallet;
 * a set `targetOrgId` narrows it to one. `delta_each>0`/`qty>0` are pinned by
 * V324's CHECKs, but we reject ≤0 up front with a typed 422 so the route never
 * surfaces a raw constraint error.
 *
 * **Idempotent (SPEC-3 §2, no double-grant on double-click):** V324's
 * stripe_item_id unique index is PARTIAL and does not cover null-item admin
 * rows, so grants dedupe on `admin_idempotency_key` (V327) instead —
 * ON CONFLICT DO NOTHING. A replayed key returns the existing row id with
 * `applied:false` and writes NO second audit row (the SPEC-3 §3 unified log
 * reads staff_audit_log; a duplicate there reads as two grants for one action).
 *
 * @returns the row id and whether this call actually created it.
 */
export async function grantAddon(
  actorId: string,
  orgId: string,
  input: {
    featureKey: string;
    deltaEach: number;
    qty: number;
    targetOrgId: string | null;
    reason: string;
    idempotencyKey: string;
  },
): Promise<{ id: string; applied: boolean }> {
  const { featureKey, deltaEach, qty, targetOrgId, reason, idempotencyKey } = input;
  if (!Number.isInteger(deltaEach) || deltaEach <= 0) {
    throw new HttpError(422, "delta_each must be a positive integer.");
  }
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new HttpError(422, "qty must be a positive integer.");
  }

  const walletId = await walletIdFor(orgId);
  const [inserted] = await sql<{ id: string }[]>`
    insert into org_addons
      (wallet_id, target_org_id, target_competition_id, feature_key, delta_each, qty,
       stripe_item_id, status, admin_idempotency_key)
    values (${walletId}, ${targetOrgId}, null, ${featureKey}, ${deltaEach}, ${qty},
            null, 'granted', ${idempotencyKey})
    on conflict (admin_idempotency_key) where admin_idempotency_key is not null do nothing
    returning id`;

  // Replay: the key already granted — return the prior row, log nothing.
  if (!inserted) {
    const [existing] = await sql<{ id: string }[]>`
      select id from org_addons where admin_idempotency_key = ${idempotencyKey}`;
    return { id: existing!.id, applied: false };
  }

  await logStaffAction(actorId, "addon_grant", "org", orgId, {
    feature_key: featureKey,
    delta_each: deltaEach,
    qty,
    target_org_id: targetOrgId,
    reason,
    addon_id: inserted.id,
  });
  return { id: inserted.id, applied: true };
}

/**
 * Staff REVOKE of an admin-granted add-on (SPEC-3 §2 reversible =
 * freeze-not-delete, §7 "no history deletion"): flip `status` to `'canceled'`
 * so the resolver stops counting it and the cap drops back to base. The row is
 * NEVER deleted — the qty>0 CHECK (V324) stays satisfied and the audit trail
 * survives.
 *
 * Only a row that is (a) on THIS org's wallet, (b) `status='granted'`, and
 * (c) admin-written (`stripe_item_id is null`) can be revoked here. A
 * Stripe-paid `active` row is billing-events' to cancel (409); another org's
 * row or an unknown id is a 404 — neither is touched.
 *
 * **Idempotent:** revoking an already-`canceled` admin row on this wallet
 * returns `{revoked:false}` without error and writes NO second audit row
 * (mirrors grantAddon's applied-guard — only a real state change is logged).
 */
export async function revokeAddon(
  actorId: string,
  orgId: string,
  addonId: string,
  reason: string,
): Promise<{ revoked: boolean }> {
  const walletId = await walletIdFor(orgId);

  const flipped = await sql<{ id: string }[]>`
    update org_addons set status = 'canceled'
     where id = ${addonId}
       and wallet_id = ${walletId}
       and status = 'granted'
       and stripe_item_id is null
    returning id`;

  if (flipped.length === 0) {
    // Nothing flipped — decide between an idempotent replay (already canceled
    // admin row) and a genuine refusal (unknown / other-org / Stripe-paid).
    const [row] = await sql<
      { wallet_id: string; status: string; stripe_item_id: string | null }[]
    >`select wallet_id, status, stripe_item_id from org_addons where id = ${addonId}`;
    if (!row || row.wallet_id !== walletId) {
      throw new HttpError(404, "No such add-on for this org.");
    }
    if (row.stripe_item_id !== null) {
      throw new HttpError(409, "This is a Stripe-paid add-on; cancel it through billing.");
    }
    if (row.status === "canceled") return { revoked: false }; // replay — no audit
    throw new HttpError(409, "This add-on cannot be revoked from the admin adjustment layer.");
  }

  await logStaffAction(actorId, "addon_revoke", "org", orgId, { addon_id: addonId, reason });
  return { revoked: true };
}
