import { z } from "zod";
import { handler } from "@/lib/http";
import { requireBillingOwner, updateBillingAddress } from "@/server/usecases/billing-manage";

const schema = z.object({
  name: z.string().max(120).optional(),
  address: z.object({
    line1: z.string().min(1).max(200),
    line2: z.string().max(200).optional(),
    city: z.string().min(1).max(100),
    state: z.string().max(100).optional(),
    postal_code: z.string().min(1).max(20),
    country: z.string().length(2),
  }),
});

/** POST /api/billing/address — update the billing name/address that drives
 *  automatic_tax; corrects tax from the next invoice onward (v3/11). */
export async function POST(req: Request) {
  return handler(async () => {
    const { orgId } = await requireBillingOwner();
    const body = schema.parse(await req.json());
    await updateBillingAddress(orgId, body);
    return { updated: true };
  });
}
