// SPEC-3 §3 — the unified per-org "Adjustments log". Every staff adjustment
// already writes ONE row to staff_audit_log (V103: actor_id, action,
// target_type, target_id, detail jsonb, created_at; indexed on
// (target_id, created_at desc)). So this is a READ + derive over that one
// table, scoped to one org and the org-adjustment action subset — NOT a
// multi-store union. Callers must have passed requireStaff (any staff READS;
// the write-restriction lives in the T1/T2 mutation routes). The rendered UI
// is SPEC-6.
import { sql } from "@/lib/db";
import { DISCOVERY_AUDIT_ACTIONS, SUSPENSION_ACTIONS } from "@/lib/admin";
import { PASS_CREDIT_RESOLVE_ACTION } from "@/server/usecases/pass-credit";

/** The org-adjustment action subset that surfaces in the log. Excludes
 *  view/impersonate and the non-per-org catalog actions (coupon, fee,
 *  size_pack). Exported so the routes and tests share the one source.
 *
 *  This is an ALLOWLIST, so an org-targeted action missing from it is audited
 *  and unreadable — present in the raw staff-history list, absent from the
 *  panel an operator actually reads. The entries below that are SPREAD rather
 *  than typed out are the ones whose action string is built by the writer
 *  (a template, a union arm) and therefore the ones that can grow without
 *  anybody remembering this file: deriving them here means a new verb reaches
 *  the maps below as a missing key, i.e. a compile error, not a silent gap. */
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
  // V354's staff slot waiver. It moves a paying org's division cap the same
  // way an override does, and it is deliberately un-timed and un-undoable, so
  // it belongs in the panel a human actually reads rather than only in the raw
  // staff-history list.
  "division_slot_waived",
  // Moderation (admin-orgs.ts setOrgSuspension). Suspension flips
  // organizations.status, which is a plan-resolver INPUT — a suspended org
  // resolves as `community` — so it moves this org's entitlements as surely as
  // an override does, and belongs where an operator reads them.
  ...SUSPENSION_ACTIONS,
  // Discovery curation (api/admin/competitions/[id]/discovery). Target is the
  // COMPETITION's org, so these are org-scoped rows that the filter admits.
  ...DISCOVERY_AUDIT_ACTIONS,
  // The staff decision on an undetermined pass-credit reversal (pass-credit.ts).
  // The audit row IS the record — there is no column for the decision — so a
  // decision an operator cannot find is a decision that was not recorded.
  PASS_CREDIT_RESOLVE_ACTION,
] as const;

export type AdjustmentAction = (typeof ADJUSTMENT_ACTIONS)[number];
export type AdjustmentCategory =
  | "credits"
  | "cap"
  | "addon"
  | "plan"
  | "pass"
  | "moderation"
  | "discovery";

/** action → display category. */
export const ADJUSTMENT_CATEGORY: Record<AdjustmentAction, AdjustmentCategory> = {
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
  // A cap move, like the overrides above: it changes how many divisions the
  // org may hold under the same plan.
  division_slot_waived: "cap",
  // Not "plan": suspension does change what the org may do, but it is a
  // moderation decision and the money is deliberately untouched (see
  // setOrgSuspension). Filing it under plan would read as a billing change.
  suspend: "moderation",
  reactivate: "moderation",
  discovery_feature: "discovery",
  discovery_unfeature: "discovery",
  discovery_block: "discovery",
  discovery_unblock: "discovery",
  // The category was declared for this action when the panel was written and
  // then had nothing mapped to it, which is what an unnoticed omission looks
  // like from the outside.
  [PASS_CREDIT_RESOLVE_ACTION]: "pass",
};

/** action → has a compensating action a staffer can apply to undo it. The
 *  already-compensating/terminal actions are false. */
export const ADJUSTMENT_REVERSIBLE: Record<AdjustmentAction, boolean> = {
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
  // There is no un-waive control: `slot_waived_at` is one-way and the division
  // is archived. Terminal, like the other compensating actions here.
  division_slot_waived: false,
  // `reactivate` IS suspension's compensating action, so the pair follows the
  // addon_grant/addon_revoke shape above.
  suspend: true,
  reactivate: false,
  discovery_feature: true,
  discovery_block: true,
  discovery_unfeature: false,
  discovery_unblock: false,
  // Records a decision staff already carried out by hand in Stripe. There is
  // no staff control that undoes it — changing one's mind is a NEW decision,
  // logged as its own row, not a reversal of this one.
  [PASS_CREDIT_RESOLVE_ACTION]: false,
};

export interface AdjustmentEntry {
  id: string;
  actorId: string;
  actorName: string | null;
  /** Narrowed to the allowlist the query filters on — the read cannot return
   *  anything else, and the UI's label map is keyed on it, so a widened
   *  `string` here is what let a labelless action render its raw slug. */
  action: AdjustmentAction;
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
  const text = (key: string) =>
    typeof detail[key] === "string" && detail[key] ? (detail[key] as string) : null;
  const reason =
    text("reason") ??
    text("reason_code") ??
    // A slot waiver carries no reason of its own — the fact IS which division
    // it freed. The panel renders only `reason` as its subject column, so
    // without this an auditor sees "Division slot waived / cap" over an em
    // dash: something moved this org's division cap, but not WHICH division,
    // which is precisely the question the audit exists to answer. The name is
    // stamped at waive time rather than joined here, so a later rename or
    // delete cannot rewrite what the auditor is told.
    (row.action === "division_slot_waived" ? (text("division_name") ?? text("division_id")) : null);
  return {
    id: row.id,
    actorId: row.actor_id,
    actorName: row.actor_name,
    action: row.action,
    category: ADJUSTMENT_CATEGORY[row.action],
    detail,
    reason,
    reversible: ADJUSTMENT_REVERSIBLE[row.action],
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}
