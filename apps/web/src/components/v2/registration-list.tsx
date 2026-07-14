"use client";

// Registration list as status tabs (PROMPT-52): Confirmed / Pending /
// Waitlist / All, with counts in the labels; the Waitlist tab is the
// numbered queue. Row actions split into labeled SPOT and MONEY clusters so
// the withdraw-vs-refund split is unmistakable — the verbs behind them are
// the same endpoints as before.
import type { Registration } from "./registrations-panel";
import type { Tab } from "./registration-pulse";
import { WaitlistQueue } from "./waitlist-queue";

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700",
  paid: "bg-emerald-100 text-emerald-700",
  confirmed: "bg-emerald-100 text-emerald-700",
  waitlisted: "bg-sky-100 text-sky-700",
  withdrawn: "bg-slate-100 text-slate-500",
  expired: "bg-zinc-100 text-zinc-500",
};

/** Payment chip per row (spec §8): one glanceable money state. */
function paymentChip(r: Registration): { label: string; cls: string; title?: string } | null {
  if (r.amount_cents <= 0 && !r.payment_intent_id) return null;
  // A closed-lost dispute leaves disputed_at set for history AND marks the
  // money returned — show that outcome, not a still-open-looking flag.
  if (r.disputed_at && r.refunded_cents >= r.amount_cents && r.amount_cents > 0)
    return {
      label: "dispute lost · refunded",
      cls: "bg-rose-100 text-rose-700",
      // Static copy (PROMPT-55): deep history lives in the activity log.
      title: "The cardholder was repaid by Stripe and the amount was recovered from your Stripe balance.",
    };
  if (r.disputed_at) return { label: "⚠ disputed", cls: "bg-rose-100 text-rose-700" };
  const partiallyRefunded = r.refunded_cents > 0 && r.refunded_cents < r.amount_cents;
  if (r.refunded_cents >= r.amount_cents && r.refunded_cents > 0)
    return { label: "refunded", cls: "bg-slate-100 text-slate-600" };
  if (r.status === "withdrawn" && r.payment_intent_id && r.refunded_cents < r.amount_cents)
    return { label: "refund incomplete", cls: "bg-amber-100 text-amber-800" };
  if (partiallyRefunded)
    return { label: "partly refunded", cls: "bg-amber-100 text-amber-700" };
  if (r.offline_marked_paid_at) return { label: "paid · cash", cls: "bg-emerald-100 text-emerald-700" };
  if (r.payment_intent_id && (r.status === "paid" || r.status === "confirmed"))
    return { label: "paid · card", cls: "bg-emerald-100 text-emerald-700" };
  if (r.status === "pending") {
    return r.payment_method === "stripe"
      ? { label: `due · card${hoursLeft(r.expires_at)}`, cls: "bg-amber-100 text-amber-700" }
      : { label: "due · cash", cls: "bg-amber-100 text-amber-700" };
  }
  return null;
}

function hoursLeft(iso: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return " · expiring";
  const h = Math.round(ms / 3_600_000);
  return h >= 48 ? "" : ` · ${h}h left`;
}

export type ActionVerb = "confirm" | "waitlist" | "withdraw" | "refund" | "mark-paid" | "waive";

const TABS: { key: Tab; label: string }[] = [
  { key: "confirmed", label: "Confirmed" },
  { key: "pending", label: "Pending" },
  { key: "waitlist", label: "Waitlist" },
  { key: "disputed", label: "Disputed" },
  { key: "all", label: "All" },
];

function inTab(r: Registration, tab: Tab): boolean {
  if (tab === "all") return true;
  if (tab === "confirmed") return r.status === "confirmed";
  if (tab === "pending") return r.status === "pending" || r.status === "paid";
  if (tab === "disputed") return r.disputed_at !== null;
  return r.status === "waitlisted";
}

export function RegistrationList({
  regs,
  shown,
  query,
  tab,
  onTab,
  positions,
  duplicates,
  canEdit,
  busy,
  onAction,
  onRemind,
}: {
  /** All rows (tab counts). */
  regs: Registration[];
  /** Search-filtered rows (what renders). */
  shown: Registration[];
  query: string;
  tab: Tab;
  onTab: (t: Tab) => void;
  positions: Map<string, number>;
  duplicates: Set<string>;
  canEdit: boolean;
  busy: boolean;
  onAction: (r: Registration, verb: ActionVerb) => void;
  onRemind: (id: string) => void;
}) {
  const counts: Record<Tab, number> = {
    confirmed: regs.filter((r) => inTab(r, "confirmed")).length,
    pending: regs.filter((r) => inTab(r, "pending")).length,
    waitlist: regs.filter((r) => inTab(r, "waitlist")).length,
    disputed: regs.filter((r) => inTab(r, "disputed")).length,
    all: regs.length,
  };
  const visible = shown.filter((r) => inTab(r, tab));

  return (
    <div>
      <div role="tablist" aria-label="Registrations by status" className="mb-3 flex flex-wrap gap-1">
        {/* The Disputed tab only exists while there's something disputed to see. */}
        {TABS.filter(({ key }) => key !== "disputed" || counts.disputed > 0 || tab === "disputed").map(({ key, label }) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            type="button"
            onClick={() => onTab(key)}
            data-testid={`reg-tab-${key}`}
            className={
              tab === key
                ? "rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-white"
                : "rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:border-slate-300"
            }
          >
            {label} <span className="tabular-nums opacity-70">{counts[key]}</span>
          </button>
        ))}
      </div>

      {regs.length === 0 ? (
        <div className="card p-6 text-sm text-slate-500">
          No registrations yet. Share the public competition page — the Register button
          appears while a division is open.
        </div>
      ) : visible.length === 0 && query !== "" ? (
        <div className="card p-6 text-sm text-slate-500">
          Nothing matches “{query}” — check the reference for typos (letters O/I are never
          used; try 0/1).
        </div>
      ) : tab === "waitlist" ? (
        <WaitlistQueue
          rows={visible}
          positions={positions}
          canEdit={canEdit}
          busy={busy}
          onPromote={(r) => onAction(r, "confirm")}
          onWaive={(r) => onAction(r, "waive")}
          onWithdraw={(r) => onAction(r, "withdraw")}
        />
      ) : visible.length === 0 ? (
        <div className="card p-6 text-sm text-slate-500">Nothing in this tab yet.</div>
      ) : (
        <ul className="space-y-2">
          {visible.map((r) => {
            const refundable =
              r.payment_intent_id !== null && r.refunded_cents < r.amount_cents;
            const chip = paymentChip(r);
            const feeUnpaid = r.amount_cents > 0 && !r.payment_intent_id;
            const spotActions = canEdit && (
              <>
                {(r.status === "pending" || r.status === "waitlisted") && !feeUnpaid && (
                  <button type="button" disabled={busy} onClick={() => onAction(r, "confirm")} className="btn btn-ghost text-xs">
                    Approve
                  </button>
                )}
                {r.status === "pending" && (
                  <button type="button" disabled={busy} onClick={() => onAction(r, "waitlist")} className="btn btn-ghost text-xs">
                    Waitlist
                  </button>
                )}
                {r.status !== "withdrawn" && r.status !== "expired" && (
                  <button type="button" disabled={busy} onClick={() => onAction(r, "withdraw")} className="btn btn-ghost text-xs text-red-600">
                    Withdraw
                  </button>
                )}
              </>
            );
            const moneyActions = canEdit && (
              <>
                {r.status === "pending" && feeUnpaid && (
                  <button type="button" disabled={busy} onClick={() => onAction(r, "mark-paid")} className="btn btn-ghost text-xs font-medium text-emerald-700" title="Record a cash/bank payment and confirm the entry">
                    Mark paid
                  </button>
                )}
                {(r.status === "pending" || r.status === "waitlisted") && feeUnpaid && (
                  <button type="button" disabled={busy} onClick={() => onAction(r, "waive")} className="btn btn-ghost text-xs" title="Confirm without payment (fee waived, logged)">
                    Waive fee
                  </button>
                )}
                {r.status === "pending" && r.amount_cents > 0 && r.payment_method !== "stripe" && (
                  <button type="button" disabled={busy} onClick={() => onRemind(r.id)} className="btn btn-ghost text-xs" title="Email the registrant a payment reminder">
                    Send reminder
                  </button>
                )}
                {refundable && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onAction(r, "refund")}
                    className={`btn btn-ghost text-xs ${chip?.label === "refund incomplete" ? "font-medium text-amber-700" : ""}`}
                    title={chip?.label === "refund incomplete" ? "The automatic refund failed — retry it" : "Refund the remaining amount — the entry keeps its spot"}
                  >
                    {chip?.label === "refund incomplete" ? "Retry refund" : "Refund"}
                  </button>
                )}
                {r.disputed_at && (
                  <a
                    href={`/api/v1/registrations/${r.id}/evidence`}
                    download
                    className="btn btn-ghost text-xs font-medium text-rose-700"
                    title="Download the dispute evidence pack — receipt, activity log and fixtures, ready for the Stripe dispute response"
                  >
                    Evidence pack
                  </a>
                )}
              </>
            );
            const hasSpot = spotActions && (r.status !== "withdrawn" && r.status !== "expired");
            const hasMoney =
              moneyActions &&
              (feeUnpaid || refundable || (r.status === "pending" && r.amount_cents > 0) || r.disputed_at);
            return (
              // Card on mobile (stacked: badges / identity / actions), one
              // inline row from sm: up — crowded data never squeezes the name.
              <li key={r.id} className="card flex flex-col gap-2 p-3 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className={`badge ${STATUS_STYLE[r.status] ?? ""}`}>{r.status}</span>
                  {r.status === "waitlisted" && positions.has(r.id) && (
                    <span className="badge bg-sky-100 font-mono text-sky-700">#{positions.get(r.id)}</span>
                  )}
                  {chip && (
                    <span className={`badge ${chip.cls}`} data-testid="payment-chip" title={chip.title}>
                      {chip.label}
                    </span>
                  )}
                  {duplicates.has(r.id) && (
                    <span
                      className="badge bg-amber-50 text-amber-700"
                      data-testid="duplicate-hint"
                      title="Same contact email as another active entry in this division — may be intentional (e.g. a parent entering two kids)."
                    >
                      ⚠ duplicate contact
                    </span>
                  )}
                  {r.ref_code && (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-slate-700">
                      {r.ref_code}
                    </span>
                  )}
                </span>
                <span className="min-w-0 sm:min-w-[10rem] sm:flex-1">
                  <span className="block truncate font-medium text-slate-800">
                    {r.display_name}
                    {r.entrant_id && (
                      <span className="ml-2 text-xs font-normal text-emerald-600">entrant ✓</span>
                    )}
                  </span>
                  <span className="block truncate text-xs text-slate-500">
                    {r.contact_email}
                    {r.guardian_name ? ` · guardian: ${r.guardian_name}` : ""}
                    {r.amount_cents > 0
                      ? ` · ${(r.amount_cents / 100).toFixed(2)} ${r.currency ?? ""}` +
                        (r.refunded_cents > 0 ? ` (refunded ${(r.refunded_cents / 100).toFixed(2)})` : "")
                      : ""}
                  </span>
                </span>
                {canEdit && (hasSpot || hasMoney) && (
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-slate-100 pt-2 sm:border-0 sm:pt-0">
                    {hasSpot && (
                      <span className="flex items-center gap-1">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Spot</span>
                        {spotActions}
                      </span>
                    )}
                    {hasMoney && (
                      <span className="flex items-center gap-1">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Money</span>
                        {moneyActions}
                      </span>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
