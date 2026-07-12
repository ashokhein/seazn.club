import { z } from "zod";
import { handler } from "@/lib/http";
import { applyIntervalChange, requireBillingOwner } from "@/server/usecases/billing-manage";

const schema = z.object({
  interval: z.enum(["monthly", "annual"]),
  proration_date: z.number().int().positive(),
});

/** POST /api/billing/interval — apply the monthly↔annual switch with the
 *  pinned proration_date from the preview. May return { requires_action,
 *  client_secret } when the immediate invoice needs SCA (v3/11). */
export async function POST(req: Request) {
  return handler(async () => {
    const { orgId } = await requireBillingOwner();
    const body = schema.parse(await req.json());
    return applyIntervalChange(orgId, body.interval, body.proration_date);
  });
}
