import Link from "@/components/ui/console-link";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const users = await sql<{
    id: string; email: string; display_name: string; email_verified: boolean;
    is_staff: boolean; staff_role: string | null; created_at: string;
    deleted_at: string | null;
  }[]>`
    select id, email, display_name, email_verified, is_staff, staff_role,
           created_at, deleted_at
    from users
    order by created_at desc
    limit 100`;

  return (
    <div className="space-y-6">
      <div>
        <p className="mb-1 text-xs text-slate-500">
          <Link href="/admin" className="hover:text-white">Admin</Link> / Users
        </p>
        <h1 className="text-xl font-bold text-white">Users</h1>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-800 text-xs text-slate-400">
            <tr>
              <th className="px-3 py-2 text-left">Email</th>
              <th className="px-3 py-2 text-left">Name</th>
              <th className="px-3 py-2 text-left">Role</th>
              <th className="px-3 py-2 text-left">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {users.map((u) => (
              <tr key={u.id} className="hover:bg-slate-800/50">
                <td className="px-3 py-2">
                  <Link href={`/admin/users/${u.id}`} className="text-purple-300 hover:text-white">
                    {u.email}
                  </Link>
                  {!u.email_verified && (
                    <span className="ml-2 text-xs text-amber-400">unverified</span>
                  )}
                  {u.deleted_at && (
                    <span className="ml-2 text-xs text-red-400">deleted</span>
                  )}
                </td>
                <td className="px-3 py-2 text-slate-400">{u.display_name}</td>
                <td className="px-3 py-2">
                  {u.is_staff ? (
                    <span className="rounded bg-purple-900 px-2 py-0.5 text-xs text-purple-300">
                      {u.staff_role ?? "support"}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-500">member</span>
                  )}
                </td>
                <td className="px-3 py-2 text-slate-500 text-xs">
                  {new Date(u.created_at).toLocaleDateString()}
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-center text-slate-500">
                  No users yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
