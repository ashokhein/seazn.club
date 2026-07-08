import { getActiveOrgId, requireOrgRole } from "@/lib/auth";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { downgradeToCommunity } from "@/lib/billing";

/** POST /api/billing/downgrade — self-serve downgrade to Community for a
 *  non-Stripe (comped) org. Stripe-billed orgs must use the portal. Owner only. */
export async function POST() {
  return handler(async () => {
    const orgId = await getActiveOrgId();
    if (!orgId) throw new HttpError(400, "No active organization");
    await requireOrgRole(orgId, ["owner"]);
    await downgradeToCommunity(orgId);
    return { plan_key: "community" };
  });
}
