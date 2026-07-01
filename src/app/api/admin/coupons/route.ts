import { requireStaff, requireSuperadmin, logStaffAction } from "@/lib/admin";
import { listCoupons, createCoupon } from "@/lib/coupons";
import { handler } from "@/lib/http";
import { z } from "zod";

/** List promotion codes. Any staff. */
export async function GET() {
  return handler(async () => {
    await requireStaff();
    return listCoupons();
  });
}

const schema = z
  .object({
    code: z.string().trim().min(1).max(64),
    duration: z.enum(["once", "repeating", "forever"]),
    durationInMonths: z.number().int().min(1).max(60).nullish(),
    percentOff: z.number().min(0).max(100).nullish(),
    amountOff: z.number().min(0).nullish(),
    currency: z.string().length(3).nullish(),
    maxRedemptions: z.number().int().min(1).nullish(),
    expiresAt: z.number().int().positive().nullish(),
  })
  .strict()
  .refine((v) => v.percentOff != null || (v.amountOff != null && v.currency), {
    message: "Provide either a percent or an amount + currency discount",
  })
  .refine((v) => v.duration !== "repeating" || v.durationInMonths != null, {
    message: "durationInMonths is required for repeating coupons",
  });

/** Create a coupon + promotion code. Superadmin only (billing impact). */
export async function POST(req: Request) {
  return handler(async () => {
    const staff = await requireSuperadmin();
    const input = schema.parse(await req.json());
    const row = await createCoupon(input);
    await logStaffAction(staff.id, "coupon_create", "coupon", row.promoId, {
      code: row.code,
      discount: row.discount,
      duration: row.duration,
    });
    return row;
  });
}
