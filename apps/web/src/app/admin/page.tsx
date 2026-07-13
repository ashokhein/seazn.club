import Link from "@/components/ui/console-link";
import { sql } from "@/lib/db";

export default async function AdminDashboard() {
  const [counts] = await sql<{
    users: number; orgs: number; active_subs: number; staff_actions_today: number;
  }[]>`
    select
      (select count(*)::int from users where deleted_at is null)          as users,
      (select count(*)::int from organizations where status = 'active')   as orgs,
      (select count(*)::int from subscriptions where plan_key <> 'community' and status in ('trialing','active')) as active_subs,
      (select count(*)::int from staff_audit_log where created_at >= now() - interval '24 hours') as staff_actions_today`;

  const recentAudit = await sql<{
    id: string; actor_email: string; action: string; target_type: string;
    target_id: string; created_at: string;
  }[]>`
    select s.id, u.email as actor_email, s.action, s.target_type, s.target_id, s.created_at
    from staff_audit_log s join users u on u.id = s.actor_id
    order by s.created_at desc limit 20`;

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-bold text-white">Dashboard</h1>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: "Users", value: counts.users },
          { label: "Active orgs", value: counts.orgs },
          { label: "Paid subs", value: counts.active_subs },
          { label: "Staff actions (24h)", value: counts.staff_actions_today },
        ].map((s) => (
          <div key={s.label} className="rounded-lg bg-slate-800 p-4">
            <p className="text-2xl font-bold text-white">{s.value}</p>
            <p className="text-xs text-slate-400">{s.label}</p>
          </div>
        ))}
      </div>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-slate-400">Recent staff actions</h2>
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-800 text-xs text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left">Actor</th>
                <th className="px-3 py-2 text-left">Action</th>
                <th className="px-3 py-2 text-left">Target</th>
                <th className="px-3 py-2 text-left">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {recentAudit.map((r) => (
                <tr key={r.id} className="hover:bg-slate-800/50">
                  <td className="px-3 py-2 text-slate-300">{r.actor_email}</td>
                  <td className="px-3 py-2 font-mono text-purple-300">{r.action}</td>
                  <td className="px-3 py-2 text-slate-400">
                    {r.target_type === "org" || r.target_type === "user" ? (
                      <Link
                        href={`/admin/${r.target_type}s/${r.target_id}`}
                        className="hover:text-white"
                      >
                        {r.target_type}/{r.target_id.slice(0, 8)}…
                      </Link>
                    ) : (
                      <span>{r.target_type}/{r.target_id.slice(0, 8)}…</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-500 text-xs">
                    {new Date(r.created_at).toLocaleString()}
                  </td>
                </tr>
              ))}
              {recentAudit.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-4 text-center text-slate-500">
                    No staff actions yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
