"use client";

// Registration list as status tabs (PROMPT-52): Confirmed / Pending /
// Waitlist / All, with counts in the labels; the Waitlist tab is the
// numbered queue. Row actions split into labeled SPOT and MONEY clusters so
// the withdraw-vs-refund split is unmistakable — the verbs behind them are
// the same endpoints as before.
import type { Registration } from "./registrations-panel";
import type { Tab } from "./registration-pulse";
import { WaitlistQueue } from "./waitlist-queue";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700",
  paid: "bg-emerald-100 text-emerald-700",
  confirmed: "bg-emerald-100 text-emerald-700",
  waitlisted: "bg-sky-100 text-sky-700",
  withdrawn: "bg-slate-100 text-slate-500",
  expired: "bg-zinc-100 text-zinc-500",
};

/** Payment chip per row (spec §8): one glanceable money state. */
function paymentChip(msg: Msg, r: Registration): { label: string; cls: string; title?: string } | null {
  if (r.amount_cents <= 0 && !r.payment_intent_id) return null;
  // A closed-lost dispute leaves disputed_at set for history AND marks the
  // money returned — show that outcome, not a still-open-looking flag.
  if (r.disputed_at && r.refunded_cents >= r.amount_cents && r.amount_cents > 0)
    return {
      label: msg("reg.chip.disputeLost"),
      cls: "bg-rose-100 text-rose-700",
      // Static copy (PROMPT-55): deep history lives in the activity log.
      title: msg("reg.chip.disputeLostTitle"),
    };
  if (r.disputed_at) return { label: msg("reg.chip.disputed"), cls: "bg-rose-100 text-rose-700" };
  const partiallyRefunded = r.refunded_cents > 0 && r.refunded_cents < r.amount_cents;
  if (r.refunded_cents >= r.amount_cents && r.refunded_cents > 0)
    return { label: msg("reg.chip.refunded"), cls: "bg-slate-100 text-slate-600" };
  if (r.status === "withdrawn" && r.payment_intent_id && r.refunded_cents < r.amount_cents)
    return { label: msg("reg.chip.refundIncomplete"), cls: "bg-amber-100 text-amber-800" };
  if (partiallyRefunded)
    return { label: msg("reg.chip.partlyRefunded"), cls: "bg-amber-100 text-amber-700" };
  if (r.offline_marked_paid_at) return { label: msg("reg.chip.paidCash"), cls: "bg-emerald-100 text-emerald-700" };
  if (r.payment_intent_id && (r.status === "paid" || r.status === "confirmed"))
    return { label: msg("reg.chip.paidCard"), cls: "bg-emerald-100 text-emerald-700" };
  if (r.status === "pending") {
    return r.payment_method === "stripe"
      ? { label: `${msg("reg.chip.dueCard")}${hoursLeft(msg, r.expires_at)}`, cls: "bg-amber-100 text-amber-700" }
      : { label: msg("reg.chip.dueCash"), cls: "bg-amber-100 text-amber-700" };
  }
  return null;
}

/** Localized registration status; unknown values fall back to the raw token. */
function statusLabel(msg: Msg, status: string): string {
  const key = `reg.status.${status}` as MessageKey;
  const label = msg(key);
  return label === key ? status : label;
}

function hoursLeft(msg: Msg, iso: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return ` · ${msg("reg.chip.expiring")}`;
  const h = Math.round(ms / 3_600_000);
  return h >= 48 ? "" : ` · ${msg("reg.chip.hoursLeft", { h })}`;
}

export type ActionVerb = "confirm" | "waitlist" | "withdraw" | "refund" | "mark-paid" | "waive";

const TABS: { key: Tab; labelKey: MessageKey }[] = [
  { key: "confirmed", labelKey: "reg.tab.confirmed" },
  { key: "pending", labelKey: "reg.tab.pending" },
  { key: "waitlist", labelKey: "reg.tab.waitlist" },
  { key: "disputed", labelKey: "reg.tab.disputed" },
  { key: "all", labelKey: "reg.tab.all" },
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
  const msg = useMsg();
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
      <div role="tablist" aria-label={msg("reg.tablistAria")} className="mb-3 flex flex-wrap gap-1">
        {/* The Disputed tab only exists while there's something disputed to see. */}
        {TABS.filter(({ key }) => key !== "disputed" || counts.disputed > 0 || tab === "disputed").map(({ key, labelKey }) => (
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
            {msg(labelKey)} <span className="tabular-nums opacity-70">{counts[key]}</span>
          </button>
        ))}
      </div>

      {regs.length === 0 ? (
        <div className="card p-6 text-sm text-slate-500">{msg("reg.empty.none")}</div>
      ) : visible.length === 0 && query !== "" ? (
        <div className="card p-6 text-sm text-slate-500">{msg("reg.empty.noMatch", { query })}</div>
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
        <div className="card p-6 text-sm text-slate-500">{msg("reg.empty.tab")}</div>
      ) : (
        <ul className="space-y-2">
          {visible.map((r) => {
            const refundable =
              r.payment_intent_id !== null && r.refunded_cents < r.amount_cents;
            const chip = paymentChip(msg, r);
            const feeUnpaid = r.amount_cents > 0 && !r.payment_intent_id;
            const refundIncomplete =
              r.status === "withdrawn" && r.payment_intent_id !== null && r.refunded_cents < r.amount_cents;
            const spotActions = canEdit && (
              <>
                {(r.status === "pending" || r.status === "waitlisted") && !feeUnpaid && (
                  <button type="button" disabled={busy} onClick={() => onAction(r, "confirm")} className="btn btn-ghost text-xs">
                    {msg("reg.action.approve")}
                  </button>
                )}
                {r.status === "pending" && (
                  <button type="button" disabled={busy} onClick={() => onAction(r, "waitlist")} className="btn btn-ghost text-xs">
                    {msg("reg.action.waitlist")}
                  </button>
                )}
                {r.status !== "withdrawn" && r.status !== "expired" && (
                  <button type="button" disabled={busy} onClick={() => onAction(r, "withdraw")} className="btn btn-ghost text-xs text-red-600">
                    {msg("reg.action.withdraw")}
                  </button>
                )}
              </>
            );
            const moneyActions = canEdit && (
              <>
                {r.status === "pending" && feeUnpaid && (
                  <button type="button" disabled={busy} onClick={() => onAction(r, "mark-paid")} className="btn btn-ghost text-xs font-medium text-emerald-700" title={msg("reg.action.markPaidTitle")}>
                    {msg("reg.action.markPaid")}
                  </button>
                )}
                {(r.status === "pending" || r.status === "waitlisted") && feeUnpaid && (
                  <button type="button" disabled={busy} onClick={() => onAction(r, "waive")} className="btn btn-ghost text-xs" title={msg("reg.action.waiveTitle")}>
                    {msg("reg.action.waive")}
                  </button>
                )}
                {r.status === "pending" && r.amount_cents > 0 && r.payment_method !== "stripe" && (
                  <button type="button" disabled={busy} onClick={() => onRemind(r.id)} className="btn btn-ghost text-xs" title={msg("reg.action.remindTitle")}>
                    {msg("reg.action.remind")}
                  </button>
                )}
                {refundable && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onAction(r, "refund")}
                    className={`btn btn-ghost text-xs ${refundIncomplete ? "font-medium text-amber-700" : ""}`}
                    title={refundIncomplete ? msg("reg.action.retryRefundTitle") : msg("reg.action.refundTitle")}
                  >
                    {refundIncomplete ? msg("reg.action.retryRefund") : msg("reg.action.refund")}
                  </button>
                )}
                {r.disputed_at && (
                  <a
                    href={`/api/v1/registrations/${r.id}/evidence`}
                    download
                    className="btn btn-ghost text-xs font-medium text-rose-700"
                    title={msg("reg.action.evidenceTitle")}
                  >
                    {msg("reg.action.evidence")}
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
                  <span className={`badge ${STATUS_STYLE[r.status] ?? ""}`}>{statusLabel(msg, r.status)}</span>
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
                      title={msg("reg.duplicateTitle")}
                    >
                      {msg("reg.duplicate")}
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
                      <span className="ml-2 text-xs font-normal text-emerald-600">{msg("reg.entrant")}</span>
                    )}
                  </span>
                  <span className="block truncate text-xs text-slate-500">
                    {r.contact_email}
                    {r.guardian_name ? ` · ${msg("reg.guardian", { name: r.guardian_name })}` : ""}
                    {r.amount_cents > 0
                      ? ` · ${(r.amount_cents / 100).toFixed(2)} ${r.currency ?? ""}` +
                        (r.refunded_cents > 0 ? ` (${msg("reg.refundedAmount", { amount: (r.refunded_cents / 100).toFixed(2) })})` : "")
                      : ""}
                  </span>
                </span>
                {canEdit && (hasSpot || hasMoney) && (
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-slate-100 pt-2 sm:border-0 sm:pt-0">
                    {hasSpot && (
                      <span className="flex items-center gap-1">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{msg("reg.cluster.spot")}</span>
                        {spotActions}
                      </span>
                    )}
                    {hasMoney && (
                      <span className="flex items-center gap-1">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{msg("reg.cluster.money")}</span>
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
