import { sql } from "@/lib/db";
import { requireOrgRole } from "@/lib/auth";
import { handler } from "@/lib/http";
import { ORG_ROLES, type Subscription } from "@/lib/types";

/** Current subscription state for an org. Any member may read. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id: orgId } = await params;
    await requireOrgRole(orgId, ORG_ROLES);

    const [sub] = await sql<Subscription[]>`
      select org_id, plan_key, status, stripe_customer_id,
             stripe_subscription_id, current_period_end, trial_end,
             cancel_at_period_end, updated_at
      from subscriptions where org_id = ${orgId}`;

    return sub ?? {
      org_id: orgId,
      plan_key: "community",
      status: "active",
      stripe_customer_id: null,
      stripe_subscription_id: null,
      current_period_end: null,
      trial_end: null,
      cancel_at_period_end: false,
      updated_at: new Date().toISOString(),
    };
  });
}
