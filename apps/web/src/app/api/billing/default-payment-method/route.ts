import { z } from "zod";
import { handler } from "@/lib/http";
import { requireBillingOwner, setDefaultPaymentMethod } from "@/server/usecases/billing-manage";

const schema = z
  .object({
    setup_intent_id: z.string().startsWith("seti_").optional(),
    payment_method_id: z.string().startsWith("pm_").optional(),
  })
  .refine((b) => b.setup_intent_id || b.payment_method_id, {
    message: "setup_intent_id or payment_method_id required",
  });

/** POST /api/billing/default-payment-method — finalize a confirmed SetupIntent
 *  as the customer default, or promote an existing card (v3/11). */
export async function POST(req: Request) {
  return handler(async () => {
    const { orgId } = await requireBillingOwner();
    const body = schema.parse(await req.json());
    return setDefaultPaymentMethod(orgId, {
      setupIntentId: body.setup_intent_id,
      paymentMethodId: body.payment_method_id,
    });
  });
}
