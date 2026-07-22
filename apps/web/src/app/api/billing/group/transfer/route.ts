import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handler } from "@/lib/http";
import { listGroupTransferOffers, offerGroupTransfer } from "@/server/usecases/billing-groups";

const schema = z.object({
  subscription_id: z.string().uuid(),
  new_owner_user_id: z.string().uuid(),
});

/**
 * POST /api/billing/group/transfer — offer a billing group to another payer
 * (spec 2026-07-21 billing-groups §Operations 3).
 *
 * Distinct from /api/orgs/[id]/transfer-owner, which moves ORG ownership and
 * never touches billing. Two-phase whenever the group has a live subscription:
 * the response carries a SetupIntent the recipient confirms with THEIR card,
 * and ownership moves at /api/billing/group/transfer/accept. A group with
 * nothing to bill transfers on this call and answers `status: "transferred"`.
 */
/**
 * GET /api/billing/group/transfer — outstanding offers involving the caller,
 * in both directions.
 *
 * Without this an offer could not be WITHDRAWN: the SetupIntent id was returned
 * once, to the offerer, and stored nowhere, so a page reload left a live claim
 * on their own subscription that they had no way to cancel. It is also how a
 * recipient learns an offer exists at all.
 *
 * `client_secret` is populated only on offers made TO the caller — see
 * listGroupTransferOffers.
 */
export async function GET() {
  return handler(async () => {
    const user = await requireUser();
    return listGroupTransferOffers(user.id);
  });
}

export async function POST(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const body = schema.parse(await req.json());
    return offerGroupTransfer({
      actorUserId: user.id,
      subscriptionId: body.subscription_id,
      newOwnerUserId: body.new_owner_user_id,
    });
  });
}
