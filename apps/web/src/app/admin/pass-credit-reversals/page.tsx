import Link from "@/components/ui/console-link";
import { requireStaff } from "@/lib/admin";
import { listUndeterminedPassCreditReversals } from "@/server/usecases/pass-credit";
import { ResolveUndeterminedForm } from "./resolve-form";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  open: "Needs a decision",
  kept: "Reviewed — customer keeps it",
  clawed_back: "Resolved — clawed back",
};

const STATUS_CLS: Record<string, string> = {
  open: "bg-amber-900 text-amber-200",
  kept: "bg-slate-700 text-slate-300",
  clawed_back: "bg-emerald-900 text-emerald-300",
};

/**
 * #305 (#286 phase 2) — the worklist for pass-credit redemptions whose refund
 * reversal could not be decided automatically, and the one place a human can
 * close one.
 *
 * An `open` row is holding its group's ONE lifetime Event Pass credit and will
 * go on doing so until somebody decides here; that is deliberate (the customer
 * provably still holds the money) but it is not a state to leave unattended.
 */
export default async function AdminPassCreditReversalsPage() {
  const staff = await requireStaff();
  const rows = await listUndeterminedPassCreditReversals();
  const open = rows.filter((r) => r.status === "open").length;

  return (
    <div className="space-y-6">
      <div>
        <p className="mb-1 text-xs text-slate-500">
          <Link href="/admin" className="hover:text-white">
            Admin
          </Link>{" "}
          / Pass credit reversals
        </p>
        <h1 className="text-xl font-bold text-white">Undetermined pass credit reversals</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-400">
          An Event Pass was refunded but the customer&rsquo;s Stripe balance could not be attributed
          to that pass, so nothing was clawed back automatically and the group&rsquo;s one lifetime
          pass credit stays held. Settle the balance in the Stripe dashboard FIRST, then record what
          you did here — this page never moves money.
        </p>
        <p className="mt-2 text-xs text-slate-500">
          {open} awaiting a decision · {rows.length} total
        </p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="w-full min-w-[64rem] text-sm">
          <thead className="bg-slate-800 text-xs text-slate-400">
            <tr>
              <th className="px-3 py-2 text-left">Org</th>
              <th className="px-3 py-2 text-left">Competition</th>
              <th className="px-3 py-2 text-left">Payment intent</th>
              <th className="px-3 py-2 text-left">Granted / reversed</th>
              <th className="px-3 py-2 text-left">Undetermined</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Decided by</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {rows.map((r) => (
              <tr key={r.id} className="align-top hover:bg-slate-800/50">
                <td className="px-3 py-2 text-slate-300">
                  {r.orgName ?? "—"}
                  <div className="font-mono text-[10px] text-slate-600">{r.orgId}</div>
                </td>
                <td className="px-3 py-2 text-slate-400">{r.competitionName ?? "—"}</td>
                <td className="px-3 py-2 font-mono text-xs text-purple-300">{r.paymentIntent}</td>
                <td className="px-3 py-2 text-slate-400">
                  {r.amountMinor} / {r.reversedMinor ?? 0}{" "}
                  <span className="uppercase text-slate-600">{r.currency}</span>
                  <div className="text-[10px] text-slate-600">minor units</div>
                </td>
                <td className="px-3 py-2 text-xs text-slate-500">
                  {r.undeterminedAt ? new Date(r.undeterminedAt).toLocaleString() : "—"}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${STATUS_CLS[r.status] ?? "bg-slate-700 text-slate-300"}`}
                  >
                    {STATUS_LABEL[r.status] ?? r.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs text-slate-400">
                  {r.resolvedBy ? (
                    <>
                      {r.resolvedByName ?? r.resolvedBy}
                      <div className="text-[10px] text-slate-600">
                        {r.resolvedAt ? new Date(r.resolvedAt).toLocaleString() : ""}
                      </div>
                      {r.reason && <div className="mt-1 text-slate-500">{r.reason}</div>}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-4 text-center text-slate-500">
                  Nothing undetermined — every pass credit reversal settled itself.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* The controls live outside the table so a 375px screen scrolls the wide
          row data horizontally without trapping the form inputs inside it. */}
      {rows
        .filter((r) => r.undeterminedAt !== null)
        .map((r) => (
          <div key={r.id} className="rounded-lg border border-slate-800 bg-slate-900 p-3">
            {/* break-all: a Stripe payment intent is one unbreakable token and
                would otherwise be the thing that scrolls the page at 375px. */}
            <p className="mb-2 break-all text-xs text-slate-400">
              <span className="font-semibold text-slate-200">{r.orgName ?? r.orgId}</span> ·{" "}
              <span className="font-mono text-purple-300">{r.paymentIntent}</span> ·{" "}
              {r.amountMinor} minor <span className="uppercase">{r.currency}</span> granted
              {r.status === "kept" && " · already reviewed as kept"}
            </p>
            <ResolveUndeterminedForm
              redemptionId={r.id}
              grantedMinor={r.amountMinor}
              currency={r.currency}
              canClawBack={staff.staff_role === "superadmin"}
            />
          </div>
        ))}
    </div>
  );
}
