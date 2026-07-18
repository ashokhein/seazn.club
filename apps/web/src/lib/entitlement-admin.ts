import { ENTITLEMENT_DOMAINS } from "@/lib/entitlement-domains";

export interface AdminEntRow {
  feature_key: string;
  plan_key: string;
  bool_value: boolean | null;
  int_value: number | null;
}

export interface AdminEntFeature {
  feature_key: string;
  type: "bool" | "int";
  cells: Record<string, string>; // plan_key -> rendered value
}

export interface AdminEntSection { slug: string; features: AdminEntFeature[] }

const PLANS = ["community", "event_pass", "pro", "pro_plus"] as const;

function render(cell: AdminEntRow | undefined): string {
  if (!cell) return "—";
  if (cell.bool_value !== null) {
    // Dual-value keys (import.bulk: true + cap 20) show both.
    if (cell.bool_value && cell.int_value !== null) return `true (${cell.int_value})`;
    return cell.bool_value ? "true" : "false";
  }
  return cell.int_value === null ? "∞" : String(cell.int_value);
}

/** Pivot plan_entitlements rows into domain-grouped admin sections. Keys not
 *  in ENTITLEMENT_DOMAINS land in a trailing "other" section (vestigial +
 *  spec-2 keys stay visible to staff even while unadvertised). */
export function groupForAdmin(rows: AdminEntRow[]): AdminEntSection[] {
  const byKey = new Map<string, Map<string, AdminEntRow>>();
  for (const r of rows) {
    if (!byKey.has(r.feature_key)) byKey.set(r.feature_key, new Map());
    byKey.get(r.feature_key)!.set(r.plan_key, r);
  }
  const toFeature = (k: string): AdminEntFeature => {
    const plans = byKey.get(k) ?? new Map<string, AdminEntRow>();
    const sample = [...plans.values()][0];
    return {
      feature_key: k,
      type: sample && sample.bool_value !== null ? "bool" : "int",
      cells: Object.fromEntries(PLANS.map((p) => [p, render(plans.get(p))])),
    };
  };
  const listed = new Set(ENTITLEMENT_DOMAINS.flatMap((d) => d.features));
  const sections: AdminEntSection[] = ENTITLEMENT_DOMAINS.map((d) => ({
    slug: d.slug,
    features: d.features.filter((f) => byKey.has(f)).map(toFeature),
  }));
  const other = [...byKey.keys()].filter((k) => !listed.has(k)).sort().map(toFeature);
  if (other.length > 0) sections.push({ slug: "other", features: other });
  return sections;
}
