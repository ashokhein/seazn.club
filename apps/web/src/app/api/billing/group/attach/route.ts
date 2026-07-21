import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handler } from "@/lib/http";
import { attachOrgToGroup } from "@/server/usecases/billing-groups";

const schema = z.object({
  org_id: z.string().uuid(),
  subscription_id: z.string().uuid(),
});

/**
 * POST /api/billing/group/attach — move an organisation into an existing
 * billing group (spec 2026-07-21 billing-groups §Operations 1).
 *
 * Deliberately NOT requireBillingOwner(): that resolves the group from the
 * ACTIVE ORG cookie, and an attach names its target group explicitly. The use
 * case gates on both sides itself — the org's owner AND the target group's
 * payer — so the route only has to establish who is asking.
 */
export async function POST(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const body = schema.parse(await req.json());
    return attachOrgToGroup({
      actorUserId: user.id,
      orgId: body.org_id,
      subscriptionId: body.subscription_id,
    });
  });
}
