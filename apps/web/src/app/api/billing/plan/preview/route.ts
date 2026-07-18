import { z } from "zod";
import { handler } from "@/lib/http";
import { previewPlanChange, requireBillingOwner } from "@/server/usecases/billing-manage";

const schema = z.object({
  plan_key: z.enum(["pro", "pro_plus"]),
  interval: z.enum(["monthly", "annual"]),
});

/** GET /api/billing/plan/preview?plan_key=&interval= — exact proration
 *  numbers for the confirm dialog. The returned prorationDate must be echoed
 *  to POST /api/billing/plan so the actual charge equals the preview. */
export async function GET(req: Request) {
  return handler(async () => {
    const { orgId } = await requireBillingOwner();
    const url = new URL(req.url);
    const { plan_key, interval } = schema.parse({
      plan_key: url.searchParams.get("plan_key"),
      interval: url.searchParams.get("interval"),
    });
    return previewPlanChange(orgId, plan_key, interval);
  });
}
