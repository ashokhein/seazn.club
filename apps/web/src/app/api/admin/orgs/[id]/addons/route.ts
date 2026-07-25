import { sql } from "@/lib/db";
import { requireSuperadmin } from "@/lib/admin";
import { grantAddon, revokeAddon } from "@/server/usecases/admin-addons";
import { handler, HttpError } from "@/lib/http";
import { z } from "zod";

/** SPEC-3 §2 reason taxonomy — the same fixed set the credit-adjust route uses;
 *  free text lands in `note`, and both fold into the stored `reason`. */
const REASON_CODE = z.enum([
  "support_goodwill",
  "sales_comp",
  "promo",
  "bug_fix",
  "refund_adjust",
]);

const grantSchema = z
  .object({
    feature_key: z.string().min(1).max(80),
    /** +N per unit; V324 requires > 0. */
    delta_each: z.number().int().positive(),
    /** Line quantity; V324 requires > 0. */
    qty: z.number().int().positive(),
    /** NULL / omitted = group-wide (lifts every org on the wallet); set = one org. */
    target_org_id: z.string().uuid().nullable().optional(),
    reason_code: REASON_CODE,
    note: z.string().max(500).optional(),
    /** No double-grant on double-click (SPEC-3 §2). */
    idempotency_key: z.string().min(8).max(200),
  })
  .strict();

const revokeSchema = z
  .object({
    addon_id: z.string().uuid(),
    reason_code: REASON_CODE,
    note: z.string().max(500).optional(),
  })
  .strict();

/** Grant a comped add-on (SPEC-3 §1 row 3). SUPERADMIN ONLY — comping capacity
 *  is a sales-deal, high-privilege act (matches entitlement-override), so
 *  support staff cannot. Writes one `status='granted'` org_addons row on the
 *  org's group wallet; every grant is an attributed, reversible, reason-tagged
 *  `addon_grant` staff-audit row (SPEC-3 §3). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handler(async () => {
    const { id } = await params;
    const staff = await requireSuperadmin();
    const { feature_key, delta_each, qty, target_org_id, reason_code, note, idempotency_key } =
      grantSchema.parse(await req.json());

    const [org] = await sql<{ id: string }[]>`select id from organizations where id = ${id}`;
    if (!org) throw new HttpError(404, "Organization not found");

    // Stored reason = internal code plus any free-text note (as the credit route).
    const reason = note ? `${reason_code}: ${note}` : reason_code;

    const { id: addonId, applied } = await grantAddon(staff.id, id, {
      featureKey: feature_key,
      deltaEach: delta_each,
      qty,
      targetOrgId: target_org_id ?? null,
      reason,
      idempotencyKey: idempotency_key,
    });
    return { ok: true, addon_id: addonId, applied };
  });
}

/** Revoke an admin-granted add-on (SPEC-3 §2 reversible = freeze-not-delete).
 *  SUPERADMIN ONLY. Flips the row to `status='canceled'`; a Stripe-paid or
 *  other-org row is refused (409/404). */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handler(async () => {
    const { id } = await params;
    const staff = await requireSuperadmin();
    const { addon_id, reason_code, note } = revokeSchema.parse(await req.json());

    const [org] = await sql<{ id: string }[]>`select id from organizations where id = ${id}`;
    if (!org) throw new HttpError(404, "Organization not found");

    const reason = note ? `${reason_code}: ${note}` : reason_code;
    const { revoked } = await revokeAddon(staff.id, id, addon_id, reason);
    return { ok: true, revoked };
  });
}
