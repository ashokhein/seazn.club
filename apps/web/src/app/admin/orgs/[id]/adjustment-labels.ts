import type { AdjustmentAction } from "@/server/usecases/admin-adjustments-log";

/**
 * Raw staff_audit_log action → friendly label for the adjustments log table.
 *
 * `Record<AdjustmentAction, string>`, not `Record<string, string>`: keyed on
 * `string` a new allowlisted action needed no label and the table rendered its
 * raw slug (`pass_credit_reversal_resolve`) with nothing failing — the omission
 * was only visible to whoever happened to open the panel. Keyed on the action
 * union, the next addition to ADJUSTMENT_ACTIONS is a compile error here.
 *
 * A separate module rather than a const inside `page.tsx` because Next rejects
 * exports other than the page contract from a page module, so a map living
 * there cannot be reached by the test that checks every action has a label.
 *
 * /admin is staff-only and English-only — no dictionary keys are owed.
 */
export const ADJUSTMENT_LABELS: Record<AdjustmentAction, string> = {
  credit_adjust: "Credit adjustment",
  addon_grant: "Add-on granted",
  addon_revoke: "Add-on revoked",
  comp_to_pro: "Comped to Pro",
  admin_downgrade: "Downgraded",
  extend_trial: "Trial extended",
  restore_trial: "Trial restored",
  entitlement_override: "Entitlement override",
  entitlement_override_removed: "Override removed",
  remove_payment_method: "Card removed",
  division_slot_waived: "Division slot waived",
  suspend: "Org suspended",
  reactivate: "Org reactivated",
  discovery_feature: "Featured in discovery",
  discovery_unfeature: "Unfeatured in discovery",
  discovery_block: "Blocked from discovery",
  discovery_unblock: "Unblocked in discovery",
  pass_credit_reversal_resolve: "Pass credit reversal resolved",
};
