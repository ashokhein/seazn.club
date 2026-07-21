import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handler } from "@/lib/http";
import { transferGroupOwnership } from "@/server/usecases/billing-groups";

const schema = z.object({
  subscription_id: z.string().uuid(),
  new_owner_user_id: z.string().uuid(),
});

/**
 * POST /api/billing/group/transfer — hand a whole billing group to another
 * payer (spec 2026-07-21 billing-groups §Operations 3).
 *
 * Distinct from /api/orgs/[id]/transfer-owner, which moves ORG ownership and
 * never touches billing. This moves the payer and the invoice contact; the card
 * does not travel with it.
 */
export async function POST(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const body = schema.parse(await req.json());
    return transferGroupOwnership({
      actorUserId: user.id,
      subscriptionId: body.subscription_id,
      newOwnerUserId: body.new_owner_user_id,
    });
  });
}
