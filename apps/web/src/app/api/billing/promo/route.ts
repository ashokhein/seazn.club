import { z } from "zod";
import { handler, HttpError } from "@/lib/http";
import { applyPromoCode, removePromoCode, requireBillingOwner } from "@/server/usecases/billing-manage";

const schema = z.object({
  code: z.string().min(1).max(50).optional(),
  remove: z.boolean().optional().default(false),
});

/** POST /api/billing/promo — apply a promotion code to the live subscription
 *  ({ code }) or remove the active discount ({ remove: true }). Discounts
 *  affect every following invoice (v3/11). */
export async function POST(req: Request) {
  return handler(async () => {
    const { orgId } = await requireBillingOwner();
    const body = schema.parse(await req.json());
    if (body.remove) {
      await removePromoCode(orgId);
      return { removed: true };
    }
    if (!body.code) throw new HttpError(400, "Enter a code first.");
    return { discount: await applyPromoCode(orgId, body.code.trim()) };
  });
}
