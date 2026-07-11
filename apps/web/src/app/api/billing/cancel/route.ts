import { z } from "zod";
import { handler } from "@/lib/http";
import { requireBillingOwner, setCancelAtPeriodEnd } from "@/server/usecases/billing-manage";

const schema = z.object({
  resume: z.boolean().optional().default(false),
  reason: z.string().max(200).optional(),
});

/** POST /api/billing/cancel — schedule cancellation at period end (in-app,
 *  replaces the portal path), or resume with { resume: true } (v3/11). */
export async function POST(req: Request) {
  return handler(async () => {
    const { orgId } = await requireBillingOwner();
    const body = schema.parse(await req.json().catch(() => ({})));
    return setCancelAtPeriodEnd(orgId, !body.resume, body.reason);
  });
}
