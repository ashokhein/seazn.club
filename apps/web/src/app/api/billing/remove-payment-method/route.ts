import { z } from "zod";
import { handler } from "@/lib/http";
import { removePaymentMethod, requireBillingOwner } from "@/server/usecases/billing-manage";

const schema = z.object({ payment_method_id: z.string().startsWith("pm_") });

/** POST /api/billing/remove-payment-method — detach a non-default card (v3/11). */
export async function POST(req: Request) {
  return handler(async () => {
    const { orgId } = await requireBillingOwner();
    const { payment_method_id } = schema.parse(await req.json());
    await removePaymentMethod(orgId, payment_method_id);
    return { removed: payment_method_id };
  });
}
