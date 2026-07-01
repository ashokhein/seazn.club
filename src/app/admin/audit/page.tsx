import Link from "next/link";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function AdminAuditPage() {
  const rows = await sql<{
    id: string; actor_email: string; action: string; target_type: string;
    target_id: string; detail: unknown; created_at: string;
  }[]>`
    select s.id, u.email as actor_email, s.action, s.target_type, s.target_id,
           s.detail, s.created_at
    from staff_audit_log s join users u on u.id = s.actor_id
    order by s.chain_seq desc nulls last, s.created_at desc
    limit 200`;

  // Tamper-evidence: re-walk the hash chain (doc 04 §6). null = intact.
  const [{ broken }] = await sql<{ broken: string | null }[]>`
    select verify_staff_audit_log_chain() as broken`;

  return (
    <div className="space-y-6">
      <div>
        <p className="mb-1 text-xs text-slate-500">
          <Link href="/admin" className="hover:text-white">Admin</Link> / Audit
        </p>
        <h1 className="text-xl font-bold text-white">Audit log</h1>
      </div>

      <div
        className={`rounded-lg border px-3 py-2 text-sm ${
          broken
            ? "border-red-700 bg-red-900/30 text-red-300"
            : "border-emerald-800 bg-emerald-900/20 text-emerald-300"
        }`}
      >
        {broken
          ? `⚠ Hash chain broken at row ${broken} — the audit log may have been tampered with.`
          : "✓ Hash chain verified — no tampering detected."}
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-800 text-xs text-slate-400">
            <tr>
              <th className="px-3 py-2 text-left">When</th>
              <th className="px-3 py-2 text-left">Actor</th>
              <th className="px-3 py-2 text-left">Action</th>
              <th className="px-3 py-2 text-left">Target</th>
              <th className="px-3 py-2 text-left">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-slate-800/50 align-top">
                <td className="px-3 py-2 text-slate-500 text-xs whitespace-nowrap">
                  {new Date(r.created_at).toLocaleString()}
                </td>
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
                <td className="px-3 py-2 text-slate-500 text-xs font-mono max-w-md truncate">
                  {r.detail ? JSON.stringify(r.detail) : "—"}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-slate-500">
                  No staff actions yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
