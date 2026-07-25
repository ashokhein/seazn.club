import { sql } from "@/lib/db";
import { requireStaff, logStaffAction } from "@/lib/admin";
import { adminAdjust, walletIdFor, InsufficientBalanceError } from "@/lib/credits";
import { handler, HttpError } from "@/lib/http";
import { z } from "zod";

/** RBAC threshold (SPEC-3 §2): support staff may grant/deduct up to this many
 *  credits per adjustment; anything larger needs a superadmin. Enforced on
 *  |delta| so a big clawback is gated the same as a big grant. The "confirm
 *  above threshold" prompt is a SPEC-6 UI concern; the server enforces only the
 *  support hard cap here. */
const SUPPORT_CREDIT_CAP = 50;

const schema = z
  .object({
    /** ±N credits; non-zero. */
    delta: z.number().int().refine((n) => n !== 0, "delta must be non-zero"),
    /** Internal reason (SPEC-3 §2); free text lands in `note`. */
    reason_code: z.enum(["support_goodwill", "sales_comp", "promo", "bug_fix", "refund_adjust"]),
    note: z.string().max(500).optional(),
    /** No double-grant on double-click (SPEC-3 §2). */
    idempotency_key: z.string().min(8).max(200),
  })
  .strict();

/** Grant or deduct AI credits for an org (SPEC-3 §1). Staff (support capped at
 *  ±50, superadmin unlimited); every adjustment is an attributed, reversible,
 *  reason-tagged `admin_adjust` ledger row on the group wallet (SPEC-2 §11), so
 *  it benefits every org in a billing group. Lands in the unified staff audit. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handler(async () => {
    const { id } = await params;
    const staff = await requireStaff();
    const { delta, reason_code, note, idempotency_key } = schema.parse(await req.json());

    // RBAC hard cap: over-threshold for support is refused, never silently
    // clamped — the operator must escalate to a superadmin.
    if (staff.staff_role !== "superadmin" && Math.abs(delta) > SUPPORT_CREDIT_CAP) {
      throw new HttpError(
        403,
        `Support staff may adjust at most ${SUPPORT_CREDIT_CAP} credits at a time; ${Math.abs(delta)} needs a superadmin.`,
      );
    }

    const [org] = await sql<{ id: string }[]>`select id from organizations where id = ${id}`;
    if (!org) throw new HttpError(404, "Organization not found");

    const walletId = await walletIdFor(id);
    // Stored reason = the internal code plus any free-text note; the org-side
    // friendly line (friendlyAdjustLabel) never surfaces this.
    const reason = note ? `${reason_code}: ${note}` : reason_code;

    let result: { applied: boolean; balanceAfter: number };
    try {
      result = await adminAdjust(walletId, delta, {
        createdBy: staff.id,
        reason,
        idempotencyKey: idempotency_key,
      });
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        throw new HttpError(422, "This deduction would drive the wallet below zero.");
      }
      throw err;
    }

    await logStaffAction(staff.id, "credit_adjust", "org", id, {
      delta,
      reason_code,
      note: note ?? null,
      wallet_id: walletId,
      balance_after: result.balanceAfter,
    });
    return { ok: true, balance_after: result.balanceAfter, applied: result.applied };
  });
}
