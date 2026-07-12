import { z } from "zod";
import { handler } from "@/lib/http";
import { removeTaxId, requireBillingOwner } from "@/server/usecases/billing-manage";

const schema = z.object({ tax_id: z.string().startsWith("txi_") });

/** POST /api/billing/tax-id/remove — detach a tax id (ownership verified). */
export async function POST(req: Request) {
  return handler(async () => {
    const { orgId } = await requireBillingOwner();
    const { tax_id } = schema.parse(await req.json());
    await removeTaxId(orgId, tax_id);
    return { removed: tax_id };
  });
}
