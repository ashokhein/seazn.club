import { z } from "zod";
import { handler } from "@/lib/http";
import { TAX_ID_TYPES } from "@/lib/billing-manage";
import { addTaxId, requireBillingOwner } from "@/server/usecases/billing-manage";

const schema = z.object({
  type: z.enum(TAX_ID_TYPES),
  value: z.string().min(4).max(30),
});

/** POST /api/billing/tax-id — attach a GST/VAT/ABN id. Prints on all
 *  following invoices; Stripe Tax adjusts treatment (e.g. EU reverse charge)
 *  automatically (v3/11). */
export async function POST(req: Request) {
  return handler(async () => {
    const { orgId } = await requireBillingOwner();
    const body = schema.parse(await req.json());
    return addTaxId(orgId, body.type, body.value.trim());
  });
}
