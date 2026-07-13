import Link from "next/link";
import { platformFeeDefault } from "@/lib/platform-settings";
import { AdminPlatformSettings } from "@/components/admin-platform-settings";

export const dynamic = "force-dynamic";

/** Platform settings (spec §5) — layout enforces staff; the API re-checks
 *  superadmin on write. */
export default async function AdminSettingsPage() {
  const fee = await platformFeeDefault();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Platform settings</h1>
        <p className="text-xs text-slate-500 mt-1">
          Fee resolution: org override → plan entitlement (registration.fee_percent) → this
          default → PLATFORM_FEE_PERCENT env → 5.
        </p>
      </div>
      <AdminPlatformSettings initialFeePercent={fee} />
      <p className="text-xs text-slate-500">
        See what the cut has earned →{" "}
        <Link href="/admin/revenue" className="text-purple-300 hover:text-white">
          Revenue
        </Link>
      </p>
    </div>
  );
}
