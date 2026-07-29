import { requireStaff } from "@/lib/admin";
import { handler, HttpError } from "@/lib/http";
import {
  listUndeterminedPassCreditReversals,
  resolveUndeterminedPassCreditReversal,
} from "@/server/usecases/pass-credit";
import { z } from "zod";

const resolveSchema = z
  .object({
    redemption_id: z.string().uuid(),
    resolution: z.enum(["clawed_back", "kept"]),
    /** Minor units staff actually removed in Stripe. Required for a claw-back;
     *  the usecase bounds it by the grant and 422s outside 0..grant. */
    reversed_minor: z.number().int().nonnegative().optional(),
    reason: z.string().min(1).max(500),
  })
  .strict();

/** The staff worklist: every pass-credit redemption whose refund reversal could
 *  not be decided automatically (#286 / V337), plus the decision each has since
 *  been given. Read-only, so plain staff. */
export async function GET() {
  return handler(async () => {
    await requireStaff();
    return { rows: await listUndeterminedPassCreditReversals() };
  });
}

/**
 * Record a staff decision about one undetermined reversal (#305, #286 phase 2).
 *
 * `clawed_back` is SUPERADMIN-only: it releases the group's lifetime pass-credit
 * cap, so getting it wrong hands the group a second Event Pass credit it never
 * earned — the same bar `entitlement-override` and `addon_grant` sit behind.
 * `kept` moves no money and frees nothing (the cap goes on holding), so support
 * staff may record it.
 *
 * This endpoint NEVER touches Stripe. The claw-back it records already happened,
 * by hand, in the Stripe dashboard — that is the whole reason a human is in the
 * loop. See the §6 header in server/usecases/pass-credit.ts.
 */
export async function POST(req: Request) {
  return handler(async () => {
    const staff = await requireStaff();
    const { redemption_id, resolution, reversed_minor, reason } = resolveSchema.parse(
      await req.json(),
    );

    // Inline rather than a second `requireSuperadmin()` call: the privilege
    // depends on WHICH decision is being recorded, which is only known after
    // the body parses, and re-querying the staff row to learn what we already
    // hold would just be a second round trip.
    if (resolution === "clawed_back" && staff.staff_role !== "superadmin") {
      throw new HttpError(403, "Releasing a pass-credit cap requires superadmin.");
    }

    const { resolved } = await resolveUndeterminedPassCreditReversal(staff.id, redemption_id, {
      resolution,
      reversedMinor: reversed_minor,
      reason,
    });
    return { resolved };
  });
}
