import { requireSuperadmin, logStaffAction } from "@/lib/admin";
import { setCouponActive } from "@/lib/coupons";
import { handler } from "@/lib/http";
import { z } from "zod";

const schema = z.object({ active: z.boolean() }).strict();

/** Toggle a promotion code active/inactive. Superadmin only. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ promoId: string }> },
) {
  return handler(async () => {
    const { promoId } = await params;
    const staff = await requireSuperadmin();
    const { active } = schema.parse(await req.json());
    const row = await setCouponActive(promoId, active);
    await logStaffAction(
      staff.id,
      active ? "coupon_activate" : "coupon_deactivate",
      "coupon",
      promoId,
      { code: row.code },
    );
    return row;
  });
}
