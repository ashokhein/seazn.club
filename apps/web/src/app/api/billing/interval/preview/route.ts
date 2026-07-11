import { z } from "zod";
import { handler } from "@/lib/http";
import { previewIntervalChange, requireBillingOwner } from "@/server/usecases/billing-manage";

const schema = z.object({ interval: z.enum(["monthly", "annual"]) });

/** GET /api/billing/interval/preview?interval= — exact proration numbers for
 *  the confirm dialog. The returned prorationDate must be echoed to
 *  POST /api/billing/interval so the actual charge equals the preview (v3/11). */
export async function GET(req: Request) {
  return handler(async () => {
    const { orgId } = await requireBillingOwner();
    const url = new URL(req.url);
    const { interval } = schema.parse({ interval: url.searchParams.get("interval") });
    return previewIntervalChange(orgId, interval);
  });
}
