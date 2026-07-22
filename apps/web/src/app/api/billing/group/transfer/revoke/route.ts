import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handler } from "@/lib/http";
import { revokeGroupTransfer } from "@/server/usecases/billing-groups";

const schema = z.object({ setup_intent_id: z.string().min(1) });

/**
 * POST /api/billing/group/transfer/revoke — withdraw an outstanding offer.
 *
 * Worth having with no UI behind it: an offer is a live claim on the group's
 * subscription, and without this the only way out is to wait for the TTL.
 * Gated on whoever pays for the group NOW, not on whoever made the offer.
 */
export async function POST(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const body = schema.parse(await req.json());
    return revokeGroupTransfer({ actorUserId: user.id, setupIntentId: body.setup_intent_id });
  });
}
