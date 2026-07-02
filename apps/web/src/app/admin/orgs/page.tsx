import Link from "next/link";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function AdminOrgsPage() {
  const orgs = await sql<{
    id: string; name: string; slug: string; status: string;
    plan_key: string | null; members: number; created_at: string;
  }[]>`
    select o.id, o.name, o.slug, o.status,
           s.plan_key,
           (select count(*)::int from org_members m where m.org_id = o.id) as members,
           o.created_at
    from organizations o
    left join subscriptions s on s.org_id = o.id
    order by o.created_at desc
    limit 100`;

  return (
    <div className="space-y-6">
      <div>
        <p className="mb-1 text-xs text-slate-500">
          <Link href="/admin" className="hover:text-white">Admin</Link> / Orgs
        </p>
        <h1 className="text-xl font-bold text-white">Organizations</h1>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-800 text-xs text-slate-400">
            <tr>
              <th className="px-3 py-2 text-left">Name</th>
              <th className="px-3 py-2 text-left">Plan</th>
              <th className="px-3 py-2 text-left">Members</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {orgs.map((o) => (
              <tr key={o.id} className="hover:bg-slate-800/50">
                <td className="px-3 py-2">
                  <Link href={`/admin/orgs/${o.id}`} className="text-purple-300 hover:text-white">
                    {o.name}
                  </Link>
                  <span className="ml-2 text-xs text-slate-500">/{o.slug}</span>
                </td>
                <td className="px-3 py-2 text-slate-400">{o.plan_key ?? "community"}</td>
                <td className="px-3 py-2 text-slate-400">{o.members}</td>
                <td className="px-3 py-2">
                  <span className={`rounded px-2 py-0.5 text-xs ${
                    o.status === "active" ? "bg-emerald-900 text-emerald-300" :
                    o.status === "suspended" ? "bg-red-900 text-red-300" :
                    "bg-slate-700 text-slate-400"
                  }`}>{o.status}</span>
                </td>
                <td className="px-3 py-2 text-slate-500 text-xs">
                  {new Date(o.created_at).toLocaleDateString()}
                </td>
              </tr>
            ))}
            {orgs.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-slate-500">
                  No organizations yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
