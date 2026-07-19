import { redirect } from "next/navigation";
import Link from "@/components/ui/console-link";
import { requireStaff } from "@/lib/admin";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const staff = await requireStaff().catch(() => null);
  if (!staff) redirect("/login");

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-900 px-6 py-3 flex items-center gap-6">
        <span className="text-xs font-bold uppercase tracking-widest text-purple-400">
          Staff Console
        </span>
        <nav className="flex min-w-0 gap-4 overflow-x-auto text-sm text-slate-400">
          <Link href="/admin" className="hover:text-white">Dashboard</Link>
          <Link href="/admin/orgs" className="hover:text-white">Orgs</Link>
          <Link href="/admin/users" className="hover:text-white">Users</Link>
          <Link href="/admin/coupons" className="hover:text-white">Coupons</Link>
          <Link href="/admin/entitlements" className="hover:text-white">Entitlements</Link>
          <Link href="/admin/revenue" className="hover:text-white">Revenue</Link>
          <Link href="/admin/billing-events" className="hover:text-white">Stripe</Link>
          <Link href="/admin/ai-runs" className="hover:text-white">AI runs</Link>
          <Link href="/admin/settings" className="hover:text-white">Settings</Link>
          <Link href="/admin/audit" className="hover:text-white">Audit</Link>
        </nav>
        <div className="ml-auto flex items-center gap-3 text-xs text-slate-500">
          <span>{staff.display_name}</span>
          <span className="rounded bg-purple-900 px-2 py-0.5 text-purple-300">
            {staff.staff_role ?? "support"}
          </span>
          <Link href="/dashboard" className="hover:text-white">← App</Link>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
    </div>
  );
}
