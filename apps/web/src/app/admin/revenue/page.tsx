import { requireStaff, logStaffAction } from "@/lib/admin";
import { AdminRevenue } from "@/components/admin-revenue";

export const dynamic = "force-dynamic";

/** Platform revenue report (design/v7 PROMPT-51): Stripe application fees
 *  rolled up by month and organisation. Stripe stays the ledger — the page
 *  only reads the cached usecase through /api/admin/revenue (superadmin;
 *  the layout's staff gate lets support in, the API re-checks). */
export default async function AdminRevenuePage() {
  const staff = await requireStaff();
  // Audited on page load only (not CSV downloads, not client range
  // changes); the range mirrors the route's last-12-calendar-months default.
  const now = new Date();
  const monthStart = (offset: number) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString().slice(0, 10);
  await logStaffAction(staff.id, "revenue_report_viewed", "platform", "revenue", {
    from: monthStart(-11),
    to: monthStart(1),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Revenue</h1>
        <p className="mt-1 text-xs text-slate-500">
          What the platform has earned from card entry fees — application fees read straight
          from Stripe, grouped by month and organisation. Refreshes within 5 minutes.
        </p>
      </div>
      <AdminRevenue />
    </div>
  );
}
