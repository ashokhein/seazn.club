import Link from "next/link";
import { listCoupons } from "@/lib/coupons";
import {
  AdminCouponCreate,
  AdminCouponToggle,
} from "@/components/admin-coupon-actions";

export const dynamic = "force-dynamic";

export default async function AdminCouponsPage() {
  const coupons = await listCoupons();

  return (
    <div className="space-y-6">
      <div>
        <p className="mb-1 text-xs text-slate-500">
          <Link href="/admin" className="hover:text-white">
            Admin
          </Link>{" "}
          / Coupons
        </p>
        <h1 className="text-xl font-bold text-white">Coupons</h1>
      </div>

      <AdminCouponCreate />

      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-800 text-xs text-slate-400">
            <tr>
              <th className="px-3 py-2 text-left">Code</th>
              <th className="px-3 py-2 text-left">Discount</th>
              <th className="px-3 py-2 text-left">Duration</th>
              <th className="px-3 py-2 text-left">Redemptions</th>
              <th className="px-3 py-2 text-left">Expires</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {coupons.map((c) => (
              <tr key={c.promoId} className="hover:bg-slate-800/50">
                <td className="px-3 py-2 font-mono text-purple-300">{c.code}</td>
                <td className="px-3 py-2 text-slate-300">{c.discount}</td>
                <td className="px-3 py-2 text-slate-400">{c.duration}</td>
                <td className="px-3 py-2 text-slate-400">{c.redemptions}</td>
                <td className="px-3 py-2 text-slate-500 text-xs">
                  {c.expiresAt ? new Date(c.expiresAt).toLocaleDateString() : "—"}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${
                      c.active
                        ? "bg-emerald-900 text-emerald-300"
                        : "bg-slate-700 text-slate-400"
                    }`}
                  >
                    {c.active ? "active" : "inactive"}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <AdminCouponToggle promoId={c.promoId} active={c.active} />
                </td>
              </tr>
            ))}
            {coupons.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-4 text-center text-slate-500">
                  No coupons yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
