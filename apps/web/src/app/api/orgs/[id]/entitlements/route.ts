import { sql } from "@/lib/db";
import { requireOrgRole } from "@/lib/auth";
import { getLimit, hasFeature } from "@/lib/entitlements";
import { handler } from "@/lib/http";
import { ORG_ROLES } from "@/lib/types";

/** Key list only — the plan row says WHICH keys the panel shows and whether a
 *  key is a boolean feature or a numeric quota. The VALUES come from the
 *  resolver, never from this row. */
interface EntitlementKeyRow {
  feature_key: string;
  is_boolean: boolean;
}

/** Resolved entitlements + current usage for an org (any member may read). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id: orgId } = await params;
    await requireOrgRole(orgId, ORG_ROLES);

    const [sub] = await sql<{
      plan_key: string;
      status: string;
      trial_end: string | null;
      current_period_end: string | null;
    }[]>`
      select plan_key, status, trial_end, current_period_end
      from subscriptions where org_id = ${orgId}`;

    const planKey = sub?.plan_key ?? "community";
    const status = sub?.status ?? "active";

    // The panel must promise exactly what enforcement delivers, so this route
    // no longer resolves anything itself. It used to union overrides in raw SQL
    // with no expires_at filter, no comped_until degradation and no past_due
    // grace — and it coalesced int_value, which silently demoted every staff
    // "unlimited" grant to the plan's number. plan_entitlements is now read for
    // the KEY LIST only; every value comes from lib/entitlements.
    const rows = await sql<EntitlementKeyRow[]>`
      select feature_key, bool_value is not null as is_boolean
      from plan_entitlements
      where plan_key = ${planKey}
      order by feature_key`;

    // v2 usage (PROMPT-13): what the UI compares against the v2 quota keys.
    // Statuses counted mirror competitions.max_active enforcement.
    const [v2] = await sql<
      { competitions_active_count: number; dashboards_public_count: number }[]
    >`
      select
        count(*) filter (where status in ('draft','published','live'))::int
          as competitions_active_count,
        count(*) filter (where visibility = 'public')::int
          as dashboards_public_count
      from competitions where org_id = ${orgId}`;

    // Org-level questions, so no competition id: an Event Pass lifts a single
    // competition, not the org, and the 2-arg call is what asks that question.
    // hasFeature/getLimit are cache-aside (5-min TTL), so on a warm cache this
    // is N cache reads — no extra caching layer here.
    const entitlements = Object.fromEntries(
      await Promise.all(
        rows.map(async (r) =>
          r.is_boolean
            ? ([r.feature_key, { enabled: await hasFeature(orgId, r.feature_key) }] as const)
            : ([r.feature_key, { limit: await getLimit(orgId, r.feature_key) }] as const),
        ),
      ),
    );

    return {
      plan_key: planKey,
      status,
      trial_end: sub?.trial_end ?? null,
      current_period_end: sub?.current_period_end ?? null,
      usage: {
        competitions_active_count: v2?.competitions_active_count ?? 0,
        dashboards_public_count: v2?.dashboards_public_count ?? 0,
      },
      entitlements,
    };
  });
}
