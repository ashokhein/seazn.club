// Sibling of page.tsx: Next only tolerates its own fixed export set on a
// page module, so a helper the page needs lives here instead.
import { sql } from "@/lib/db";

/**
 * A group invoice covers SEVERAL organisations, so labelling it by the one org
 * in `metadata.org_id` names the buyer and hides the rest. Since billing groups
 * the durable stamp is `metadata.subscription_id` (the group), so an event is
 * attributed to the PAYER and the size of the group it billed for — the same
 * thing the webhook resolves through. Falls back to the org name for pre-group
 * events that never carried the subscription stamp.
 */
export async function groupLabelsByIds(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<{ id: string; payer: string | null; org_count: number }[]>`
    select s.id,
           u.display_name as payer,
           (select count(*)::int from organizations o
             where o.subscription_id = s.id and o.deleted_at is null) as org_count
      from subscriptions s
      left join users u on u.id = s.owner_user_id
     where s.id in ${sql(ids)}`;
  return new Map(
    rows.map((r) => {
      const who = r.payer ? ` · ${r.payer}` : "";
      const label = r.org_count === 1 ? `1 organisation${who}` : `${r.org_count} organisations${who}`;
      return [r.id, label];
    }),
  );
}
