import { handler } from "@/lib/http";
import { requireBillingOwner, retryOpenInvoice } from "@/server/usecases/billing-manage";

/** POST /api/billing/retry-invoice — pay the newest open invoice after a card
 *  fix (dunning recovery). Returns { requires_action, client_secret } when the
 *  payment needs in-page SCA (v3/11). */
export async function POST() {
  return handler(async () => {
    const { orgId } = await requireBillingOwner();
    return retryOpenInvoice(orgId);
  });
}
