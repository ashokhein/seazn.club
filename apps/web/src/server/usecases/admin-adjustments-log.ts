// SPEC-3 §3 — the unified per-org "Adjustments log". Every staff adjustment
// already writes ONE row to staff_audit_log (V103: actor_id, action,
// target_type, target_id, detail jsonb, created_at; indexed on
// (target_id, created_at desc)). So this is a READ + derive over that one
// table, scoped to one org and the org-adjustment action subset — NOT a
// multi-store union. Callers must have passed requireStaff (any staff READS;
// the write-restriction lives in the T1/T2 mutation routes). The rendered UI
// is SPEC-6.
import { sql } from "@/lib/db";

/** The org-adjustment action subset that surfaces in the log. Excludes
 *  view/impersonate and the non-per-org catalog actions (coupon, fee,
 *  size_pack). Exported so the routes and tests share the one source. */
export const ADJUSTMENT_ACTIONS = [
  "credit_adjust",
  "addon_grant",
  "addon_revoke",
  "comp_to_pro",
  "admin_downgrade",
  "extend_trial",
  "restore_trial",
  "entitlement_override",
  "entitlement_override_removed",
  "remove_payment_method",
] as const;

export type AdjustmentAction = (typeof ADJUSTMENT_ACTIONS)[number];
export type AdjustmentCategory = "credits" | "cap" | "addon" | "plan" | "pass";

/** action → display category. */
const CATEGORY: Record<AdjustmentAction, AdjustmentCategory> = {
  credit_adjust: "credits",
  addon_grant: "addon",
  addon_revoke: "addon",
  entitlement_override: "cap",
  entitlement_override_removed: "cap",
  comp_to_pro: "plan",
  admin_downgrade: "plan",
  extend_trial: "plan",
  restore_trial: "plan",
  remove_payment_method: "plan",
};

/** action → has a compensating action a staffer can apply to undo it. The
 *  already-compensating/terminal actions are false. */
const REVERSIBLE: Record<AdjustmentAction, boolean> = {
  credit_adjust: true,
  addon_grant: true,
  entitlement_override: true,
  comp_to_pro: true,
  extend_trial: true,
  addon_revoke: false,
  entitlement_override_removed: false,
  admin_downgrade: false,
  restore_trial: false,
  remove_payment_method: false,
};

export interface AdjustmentEntry {
  id: string;
  actorId: string;
  actorName: string | null;
  action: string;
  category: AdjustmentCategory;
  detail: Record<string, unknown>;
  reason: string | null;
  reversible: boolean;
  createdAt: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface Row {
  id: string;
  actor_id: string;
  actor_name: string | null;
  action: AdjustmentAction;
  detail: Record<string, unknown> | null;
  created_at: string | Date;
}

/** Newest-first adjustments for one org. `before` is a created_at ISO cursor
 *  (exclusive) for keyset paging; `limit` defaults to 50, capped at 200. */
export async function adjustmentsForOrg(
  orgId: string,
  opts?: { limit?: number; before?: string },
): Promise<AdjustmentEntry[]> {
  const limit = Math.min(Math.max(1, Math.trunc(opts?.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const before = opts?.before ?? null;

  const rows = await sql<Row[]>`
    select s.id,
           s.actor_id,
           coalesce(u.display_name, u.email) as actor_name,
           s.action,
           s.detail,
           s.created_at
    from staff_audit_log s
    left join users u on u.id = s.actor_id
    -- entitlement_override(_removed) log with target_type='entitlement' (the
    -- feature they touch), target_id still the org id — include that type so
    -- cap overrides surface in the org's log. The action-set filter below is
    -- what scopes the rows; these two are the only 'entitlement'-typed actions.
    where s.target_type in ('org', 'entitlement')
      and s.target_id = ${orgId}
      and s.action = any(${ADJUSTMENT_ACTIONS as unknown as string[]})
      ${before ? sql`and s.created_at < ${before}` : sql``}
    order by s.created_at desc
    limit ${limit}`;

  return rows.map(toEntry);
}

function toEntry(row: Row): AdjustmentEntry {
  const detail = (row.detail ?? {}) as Record<string, unknown>;
  const reason =
    (typeof detail.reason === "string" && detail.reason) ||
    (typeof detail.reason_code === "string" && detail.reason_code) ||
    null;
  return {
    id: row.id,
    actorId: row.actor_id,
    actorName: row.actor_name,
    action: row.action,
    category: CATEGORY[row.action],
    detail,
    reason,
    reversible: REVERSIBLE[row.action],
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}
