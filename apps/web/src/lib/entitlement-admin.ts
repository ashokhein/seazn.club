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
  // True when ANY plan cell carries a non-null int_value — i.e. this is a
  // dual-value (bool + cap) feature like import.bulk. The cell editor renders
  // the int input next to the bool toggle for every plan of such a feature.
  hasInt: boolean;
  cells: Record<string, string>; // plan_key -> rendered value
  // plan_key -> raw stored values, so the admin cell editor can seed its input
  // from truth (∞ = int_value null) rather than parse the rendered string.
  // `present` distinguishes a real row from an absent one: an absent cell
  // resolves as DENY (getLimit → 0), NOT unlimited, so it must render "—" not ∞.
  raw: Record<string, { present: boolean; bool_value: boolean | null; int_value: number | null }>;
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
      hasInt: [...plans.values()].some((c) => c.int_value !== null),
      cells: Object.fromEntries(PLANS.map((p) => [p, render(plans.get(p))])),
      raw: Object.fromEntries(
        PLANS.map((p) => {
          const cell = plans.get(p);
          return [
            p,
            {
              present: cell !== undefined,
              bool_value: cell?.bool_value ?? null,
              int_value: cell?.int_value ?? null,
            },
          ];
        }),
      ),
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
