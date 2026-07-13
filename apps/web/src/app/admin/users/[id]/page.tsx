import Link from "@/components/ui/console-link";
import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { AdminUserActions } from "@/components/admin-user-actions";

export default async function AdminUserPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [user] = await sql<{
    id: string; email: string; display_name: string; email_verified: boolean;
    google_sub: string | null; is_staff: boolean; staff_role: string | null;
    created_at: string; deleted_at: string | null;
  }[]>`
    select id, email, display_name, email_verified, google_sub, is_staff, staff_role,
           created_at, deleted_at
    from users where id = ${id}`;
  if (!user) notFound();

  const orgs = await sql<{ id: string; name: string; slug: string; role: string }[]>`
    select o.id, o.name, o.slug, m.role
    from org_members m join organizations o on o.id = m.org_id
    where m.user_id = ${id}`;

  const auditLog = await sql<{ id: string; actor_email: string; action: string; created_at: string }[]>`
    select s.id, u.email as actor_email, s.action, s.created_at
    from staff_audit_log s join users u on u.id = s.actor_id
    where s.target_id = ${id} order by s.created_at desc limit 20`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-slate-500 mb-1">
            <Link href="/admin" className="hover:text-white">Admin</Link> / User
          </p>
          <h1 className="text-xl font-bold text-white">{user.display_name}</h1>
          <p className="text-sm text-slate-400">{user.email}</p>
          <p className="font-mono text-xs text-slate-500">{user.id}</p>
        </div>
        <div className="flex gap-2">
          {user.deleted_at && (
            <span className="rounded bg-red-900 px-2 py-1 text-xs text-red-300">deleted</span>
          )}
          {user.is_staff && (
            <span className="rounded bg-purple-900 px-2 py-1 text-xs text-purple-300">
              {user.staff_role ?? "staff"}
            </span>
          )}
          <span className={`rounded px-2 py-1 text-xs ${
            user.email_verified ? "bg-emerald-900 text-emerald-300" : "bg-yellow-900 text-yellow-300"
          }`}>
            {user.email_verified ? "verified" : "unverified"}
          </span>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Meta */}
        <div className="rounded-lg bg-slate-800 p-4 space-y-2">
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Account</h2>
          <p className="text-sm text-slate-300">Auth: {user.google_sub ? "Google OAuth" : "Email/Password"}</p>
          <p className="text-sm text-slate-300">Joined: {new Date(user.created_at).toLocaleDateString()}</p>
          {user.deleted_at && (
            <p className="text-sm text-red-400">Deleted: {new Date(user.deleted_at).toLocaleDateString()}</p>
          )}
        </div>

        {/* Actions */}
        <div className="rounded-lg bg-slate-800 p-4">
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Actions</h2>
          <AdminUserActions userId={id} emailVerified={user.email_verified} isDeleted={!!user.deleted_at} />
        </div>
      </div>

      {/* Orgs */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-400">Organizations</h2>
        {orgs.length === 0 ? (
          <p className="text-sm text-slate-500">No organizations</p>
        ) : (
          <div className="rounded-lg border border-slate-800 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-800 text-xs text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left">Org</th>
                  <th className="px-3 py-2 text-left">Role</th>
                  <th className="px-3 py-2 text-left">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {orgs.map((o) => (
                  <tr key={o.id} className="hover:bg-slate-800/50">
                    <td className="px-3 py-2">
                      <Link href={`/admin/orgs/${o.id}`} className="text-purple-300 hover:text-white">
                        {o.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-slate-400">{o.role}</td>
                    <td className="px-3 py-2">
                      <Link href={`/admin/orgs/${o.id}`} className="text-xs text-slate-400 hover:text-white">
                        View org →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Staff history */}
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
