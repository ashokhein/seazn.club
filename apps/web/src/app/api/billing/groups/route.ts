import { sql } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { handler } from "@/lib/http";
import { groupOrgLimit } from "@/lib/billing-group";

/**
 * GET /api/billing/groups — the billing groups you PAY for, with the
 * organisations in each (spec 2026-07-21 billing-groups §Operations).
 *
 * This exists because `POST /api/billing/group/attach` needs a
 * `subscription_id` and nothing returned one. `GET /api/orgs/[id]/subscription`
 * deliberately does not: it is gated on ORG_ROLES, so any member of any org in
 * the group can read it, and it dropped `stripe_customer_id` for exactly that
 * reason. The group's identity belongs to the payer, not to everyone billed
 * through it — so it is published here instead, gated on `owner_user_id`.
 *
 * Payer-gated, not member-gated. Being inside an organisation someone else pays
 * for tells you nothing about their other organisations, and this response
 * names them.
 *
 * `seats_paid` is `quantity_paid`, and it can legitimately exceed the org count:
 * a slot that has been paid for and freed stays yours until renewal, which is
 * what makes re-adding an organisation cost nothing. The UI needs the two
 * numbers separately to say so — a single "5 of 5" would make a free re-add look
 * like a purchase.
 */
export async function GET() {
  return handler(async () => {
    const user = await requireUser();

    // One query, not one per group: a payer with several groups is the normal
    // shape after a detach, and the org list is the whole point of the payload.
    const rows = await sql<
      {
        id: string;
        plan_key: string;
        status: string;
        quantity_paid: number;
        current_period_end: string | null;
        cancel_at_period_end: boolean;
        trial_end: string | null;
        orgs: { id: string; name: string; slug: string; status: string }[];
      }[]
    >`
      select s.id, s.plan_key, s.status, s.quantity_paid,
             s.current_period_end, s.cancel_at_period_end, s.trial_end,
             coalesce(
               (select json_agg(json_build_object(
                          'id', o.id, 'name', o.name, 'slug', o.slug, 'status', o.status)
                        order by o.created_at)
                  from organizations o
                 where o.subscription_id = s.id and o.deleted_at is null),
               '[]'::json) as orgs
        from subscriptions s
       where s.owner_user_id = ${user.id}
       -- subscriptions has no created_at; updated_at is what groupIdsOwnedBy
       -- orders by, and matching it keeps the two listings in the same order.
       order by s.updated_at`;

    // Resolved per group rather than in the query above: the cap is an
    // ENTITLEMENT (`orgs.max_owned`), which comes from the cache-aside resolver
    // and not from a column, so a join here would answer with a stale or
    // override-blind number. null means unlimited, or an empty group with no
    // member org to resolve a plan through.
    return Promise.all(
      rows.map(async (g) => ({
        ...g,
        max_orgs: await groupOrgLimit(g.id, g.orgs.map((o) => o.id)),
      })),
    );
  });
}
