import { sql } from "@/lib/db";
import { featureReason } from "@/lib/feature-copy";
import { groupForAdmin, type AdminEntRow } from "@/lib/entitlement-admin";
import { EntCellEditor } from "@/components/admin/ent-cell-editor";

const PLAN_KEYS = ["community", "event_pass", "pro", "pro_plus"] as const;

export default async function AdminEntitlementsPage() {
  const rows = await sql<AdminEntRow[]>`
    select plan_key, feature_key, bool_value, int_value
    from plan_entitlements order by feature_key, plan_key`;
  const overrides = await sql<{ feature_key: string; n: number }[]>`
    select feature_key, count(*)::int as n from org_entitlement_overrides
    where expires_at is null or expires_at > now()
    group by feature_key`;
  const ovByKey = new Map(overrides.map((o) => [o.feature_key, o.n]));
  const sections = groupForAdmin(rows);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Entitlements</h1>
        <p className="text-xs text-slate-400">
          Live from <code>plan_entitlements</code> — the resolver, pricing page and this
          table all read the same rows. <code>∞</code> = unlimited (int null); a missing
          cell (<code>—</code>) resolves as DENY. Per-org exceptions live on each org page
          (overrides).
        </p>
      </div>
      {sections.map((s) => (
        <section key={s.slug}>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">{s.slug}</h2>
          <div className="rounded-lg border border-slate-800 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-800 text-xs text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left">Feature key</th>
                  <th className="px-3 py-2 text-left">Type</th>
                  <th className="px-3 py-2 text-center">Community</th>
                  <th className="px-3 py-2 text-center">Event Pass</th>
                  <th className="px-3 py-2 text-center">Pro</th>
                  <th className="px-3 py-2 text-center">Pro Plus</th>
                  <th className="px-3 py-2 text-left">What it gates</th>
                  <th className="px-3 py-2 text-right">Overrides</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {s.features.map((f) => (
                  <tr key={f.feature_key} className="hover:bg-slate-800/50">
                    <td className="px-3 py-2 font-mono text-xs text-purple-300">{f.feature_key}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{f.type}</td>
                    {PLAN_KEYS.map((p) => (
                      <td key={p} className="px-3 py-2 text-center text-slate-300">
                        <EntCellEditor
                          planKey={p}
                          featureKey={f.feature_key}
                          type={f.type}
                          boolValue={f.raw[p].bool_value}
                          intValue={f.raw[p].int_value}
                        />
                      </td>
                    ))}
                    <td className="px-3 py-2 text-xs text-slate-400">{featureReason(f.feature_key)}</td>
                    <td className="px-3 py-2 text-right text-xs text-slate-500">{ovByKey.get(f.feature_key) ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
