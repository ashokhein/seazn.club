import { handler } from "@/lib/http";
import { createCardSetupIntent, requireBillingOwner } from "@/server/usecases/billing-manage";

/** POST /api/billing/setup-intent — card-only SetupIntent for the in-app
 *  PaymentElement (v3/11). Card data stays inside Stripe's iframe (SAQ A). */
export async function POST() {
  return handler(async () => {
    const { orgId } = await requireBillingOwner();
    return createCardSetupIntent(orgId);
  });
}
