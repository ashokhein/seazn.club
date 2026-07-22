import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handler } from "@/lib/http";
import { previewAttachCharge, subscriptionIsOwnedBy } from "@/server/usecases/billing-groups";

const schema = z.object({ subscription_id: z.string().uuid() });

/**
 * POST /api/billing/group/attach/preview — the exact prorated amount attaching
 * one more org would charge now, or null for a free move (non-live group, or a
 * slot already paid for). The panel shows it in the confirm dialog so the price
 * is an exact figure before the click, not "half your plan's rate".
 *
 * Payer-gated: previewing a charge reveals a group's live billing shape, which
 * belongs to whoever pays for it.
 */
export async function POST(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const { subscription_id } = schema.parse(await req.json());
    await subscriptionIsOwnedBy(subscription_id, user.id);
    return { preview: await previewAttachCharge(subscription_id) };
  });
}
