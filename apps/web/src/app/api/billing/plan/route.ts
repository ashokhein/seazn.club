import { z } from "zod";
import { handler } from "@/lib/http";
import { applyPlanChange, requireBillingOwner } from "@/server/usecases/billing-manage";

const schema = z.object({
  plan_key: z.enum(["pro", "pro_plus"]),
  interval: z.enum(["monthly", "annual"]),
  proration_date: z.number().int().positive(),
});

/** POST /api/billing/plan — apply a Pro ↔ Pro Plus switch with the pinned
 *  proration_date from the preview. May return { requires_action,
 *  client_secret } when the immediate invoice needs SCA (mirrors
 *  /api/billing/interval). */
export async function POST(req: Request) {
  return handler(async () => {
    const { orgId } = await requireBillingOwner();
    const body = schema.parse(await req.json());
    return applyPlanChange(orgId, body.plan_key, body.interval, body.proration_date);
  });
}
