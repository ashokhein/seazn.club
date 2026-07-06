import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { AdminOrgActions } from "@/components/admin-org-actions";
import { AdminDiscoveryActions } from "@/components/admin-discovery-actions";
import { hasFeature } from "@/lib/entitlements";

export default async function AdminOrgPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [org] = await sql<{
    id: string; name: string; slug: string; status: string;
    created_at: string; deleted_at: string | null;
  }[]>`select id, name, slug, status, created_at, deleted_at from organizations where id = ${id}`;
  if (!org) notFound();

  const [sub] = await sql<{
    plan_key: string; status: string; trial_end: string | null;
    current_period_end: string | null; stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
  }[]>`select plan_key, status, trial_end, current_period_end, stripe_customer_id, stripe_subscription_id
       from subscriptions where org_id = ${id}`;

  const members = await sql<{
    user_id: string; email: string; display_name: string; role: string; joined_at: string;
  }[]>`
    select m.user_id, u.email, u.display_name, m.role, m.created_at as joined_at
    from org_members m join users u on u.id = m.user_id
    where m.org_id = ${id} order by m.created_at asc`;

  // Discovery curation (doc 15 §3): public competitions of this org with
  // their showcase state — featured (Pro-eligible) and abuse block.
  const competitions = await sql<{
    id: string; name: string; visibility: string; discoverable: boolean;
    discovery_blocked: boolean; discovery_featured: boolean;
  }[]>`
    select id, name, visibility, discoverable, discovery_blocked, discovery_featured
    from competitions where org_id = ${id}
    order by created_at desc limit 50`;
  const featureEligible = await hasFeature(id, "discovery.featured");

  const overrides = await sql<{ feature_key: string; bool_value: boolean | null; int_value: number | null; reason: string | null }[]>`
    select feature_key, bool_value, int_value, reason
    from org_entitlement_overrides where org_id = ${id}`;

  const auditLog = await sql<{ id: string; actor_email: string; action: string; created_at: string }[]>`
    select s.id, u.email as actor_email, s.action, s.created_at
    from staff_audit_log s join users u on u.id = s.actor_id
    where s.target_id = ${id} order by s.created_at desc limit 20`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-slate-500 mb-1">
            <Link href="/admin" className="hover:text-white">Admin</Link> / Org
          </p>
          <h1 className="text-xl font-bold text-white">{org.name}</h1>
          <p className="font-mono text-xs text-slate-400">{org.id}</p>
        </div>
        <span className={`rounded px-2 py-1 text-xs font-medium ${
          org.status === "active" ? "bg-emerald-900 text-emerald-300" :
          org.status === "suspended" ? "bg-red-900 text-red-300" :
          "bg-slate-700 text-slate-300"
        }`}>{org.status}</span>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Subscription */}
        <div className="rounded-lg bg-slate-800 p-4 space-y-2">
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Subscription</h2>
          <p className="text-white font-medium">{sub?.plan_key ?? "community"}</p>
          <p className="text-sm text-slate-400">Status: {sub?.status ?? "—"}</p>
          {sub?.trial_end && <p className="text-sm text-slate-400">Trial ends: {new Date(sub.trial_end).toLocaleDateString()}</p>}
          {sub?.current_period_end && <p className="text-sm text-slate-400">Renews: {new Date(sub.current_period_end).toLocaleDateString()}</p>}
          {sub?.stripe_customer_id && (
            <p className="text-xs text-slate-500 font-mono truncate">{sub.stripe_customer_id}</p>
          )}
        </div>

        {/* Stats */}
        <div className="rounded-lg bg-slate-800 p-4 space-y-2">
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Usage</h2>
          <p className="text-sm text-slate-300">{members.length} members</p>
          <p className="text-sm text-slate-300">{competitions.length}+ competitions</p>
          <p className="text-sm text-slate-300">Created {new Date(org.created_at).toLocaleDateString()}</p>
        </div>

        {/* Actions */}
        <div className="rounded-lg bg-slate-800 p-4">
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Actions</h2>
          <AdminOrgActions
            orgId={id}
            currentStatus={org.status}
          />
        </div>
      </div>

      {/* Members */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-400">Members</h2>
        <div className="rounded-lg border border-slate-800 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-800 text-xs text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left">Email</th>
                <th className="px-3 py-2 text-left">Role</th>
                <th className="px-3 py-2 text-left">Joined</th>
                <th className="px-3 py-2 text-left">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {members.map((m) => (
                <tr key={m.user_id} className="hover:bg-slate-800/50">
                  <td className="px-3 py-2">
                    <Link href={`/admin/users/${m.user_id}`} className="text-purple-300 hover:text-white">
                      {m.email}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-slate-400">{m.role}</td>
                  <td className="px-3 py-2 text-slate-500 text-xs">{new Date(m.joined_at).toLocaleDateString()}</td>
                  <td className="px-3 py-2">
                    <Link href={`/admin/users/${m.user_id}`} className="text-xs text-slate-400 hover:text-white">View →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Discovery curation (doc 15 §3) */}
      {competitions.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-slate-400">Discovery showcase</h2>
          <div className="rounded-lg border border-slate-800 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-800 text-xs text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left">Competition</th>
                  <th className="px-3 py-2 text-left">State</th>
                  <th className="px-3 py-2 text-left">Curation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {competitions.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-800/50">
                    <td className="px-3 py-2 text-slate-300">{c.name}</td>
                    <td className="px-3 py-2 text-xs">
                      <span className="text-slate-400">{c.visibility}</span>
                      {c.discoverable && <span className="ml-2 text-emerald-400">discoverable</span>}
                      {c.discovery_featured && <span className="ml-2 text-amber-400">featured</span>}
                      {c.discovery_blocked && <span className="ml-2 text-red-400">blocked</span>}
                    </td>
                    <td className="px-3 py-2">
                      <AdminDiscoveryActions
                        competitionId={c.id}
                        featured={c.discovery_featured}
                        blocked={c.discovery_blocked}
                        featureEligible={featureEligible}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Entitlement overrides */}
      {overrides.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-slate-400">Entitlement overrides</h2>
          <div className="rounded-lg border border-slate-800 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-800 text-xs text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left">Feature</th>
                  <th className="px-3 py-2 text-left">Value</th>
                  <th className="px-3 py-2 text-left">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {overrides.map((o) => (
                  <tr key={o.feature_key}>
                    <td className="px-3 py-2 font-mono text-xs text-purple-300">{o.feature_key}</td>
                    <td className="px-3 py-2 text-slate-300">
                      {o.bool_value != null ? String(o.bool_value) : o.int_value ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-slate-400 text-xs">{o.reason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Staff audit */}
      {auditLog.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-slate-400">Staff history</h2>
          <div className="space-y-1">
            {auditLog.map((e) => (
              <div key={e.id} className="flex gap-3 text-xs text-slate-400">
                <span className="text-slate-600">{new Date(e.created_at).toLocaleString()}</span>
                <span className="text-purple-400">{e.actor_email}</span>
                <span>{e.action}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
