/** Display names for the paid plans. Plan names are product names — they are
 *  the same in every locale (like "Connect"), so they live here and not in the
 *  dictionaries.
 *
 *  Exists because the billing page rendered the raw `plan_key` under a CSS
 *  `capitalize`, which turns `pro_plus` into "Pro_plus", and because several
 *  strings around cancel/resume said "Pro" to a Pro Plus subscriber. */
const LABELS: Record<string, string> = {
  community: "Community",
  pro: "Pro",
  pro_plus: "Pro Plus",
};

/** `pro_plus` → "Pro Plus". An unknown key is title-cased rather than shown
 *  raw, so a plan added to the DB before this map is still legible. */
export function planLabel(planKey: string | null | undefined): string {
  if (!planKey) return LABELS.community;
  return (
    LABELS[planKey] ??
    planKey
      .split("_")
      .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
      .join(" ")
  );
}
