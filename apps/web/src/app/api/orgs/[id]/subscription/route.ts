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

    // Reached through organizations.subscription_id (V310). `org_id` is no
    // longer a column on subscriptions — it is projected from the org we were
    // asked about, because many orgs may share the row behind it.
    //
    // stripe_customer_id is NOT returned any more. ORG_ROLES means any member
    // of any org in the group could read it, and it is a handle to the PAYER's
    // Stripe customer — someone else's billing identity, on a route whose job
    // is "what plan does my org have". Nothing in the app consumed it.
    const [sub] = await sql<Omit<Subscription, "stripe_customer_id">[]>`
      select o.id as org_id, s.plan_key, s.status,
             s.stripe_subscription_id, s.current_period_end, s.trial_end,
             s.cancel_at_period_end, s.updated_at
      from subscriptions s
      join organizations o on o.subscription_id = s.id
      where o.id = ${orgId}`;

    return sub ?? {
      org_id: orgId,
      plan_key: "community",
      status: "active",
      stripe_subscription_id: null,
      current_period_end: null,
      trial_end: null,
      cancel_at_period_end: false,
      updated_at: new Date().toISOString(),
    };
  });
}
