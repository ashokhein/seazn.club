import { sql } from "@/lib/db";
import { requireOrgRole } from "@/lib/auth";
import { handler } from "@/lib/http";
import { ORG_ROLES } from "@/lib/types";

interface EntitlementRow {
  feature_key: string;
  bool_value: boolean | null;
  int_value: number | null;
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

    // org overrides take priority over plan entitlements
    const rows = await sql<EntitlementRow[]>`
      select
        pe.feature_key,
        coalesce(ov.bool_value, pe.bool_value) as bool_value,
        coalesce(ov.int_value,  pe.int_value)  as int_value
      from plan_entitlements pe
      left join org_entitlement_overrides ov
        on ov.org_id = ${orgId} and ov.feature_key = pe.feature_key
      where pe.plan_key = ${planKey}
      order by pe.feature_key`;

    const [{ seasons_count }] = await sql<{ seasons_count: number }[]>`
      select count(*)::int as seasons_count from seasons where org_id = ${orgId}`;

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

    const entitlements = Object.fromEntries(
      rows.map((r) =>
        r.bool_value !== null
          ? [r.feature_key, { enabled: r.bool_value }]
          : [r.feature_key, { limit: r.int_value }],
      ),
    );

    return {
      plan_key: planKey,
      status,
      trial_end: sub?.trial_end ?? null,
      current_period_end: sub?.current_period_end ?? null,
      usage: {
        seasons_count,
        competitions_active_count: v2?.competitions_active_count ?? 0,
        dashboards_public_count: v2?.dashboards_public_count ?? 0,
      },
      entitlements,
    };
  });
}
