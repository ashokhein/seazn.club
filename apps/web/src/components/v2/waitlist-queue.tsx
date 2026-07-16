"use client";

// Waitlist as a QUEUE (PROMPT-52): ordered rows with a visible position,
// joined-at, and a Promote affordance consistent with auto-promotion (the
// oldest entry is #1 — the same row the sweep would promote). Semantics
// untouched: Promote calls the existing confirm/waive endpoints.
import type { Registration } from "./registrations-panel";
import { useMsg } from "@/components/i18n/dict-provider";

export function WaitlistQueue({
  rows,
  positions,
  canEdit,
  busy,
  onPromote,
  onWaive,
  onWithdraw,
}: {
  rows: Registration[];
  positions: Map<string, number>;
  canEdit: boolean;
  busy: boolean;
  onPromote: (r: Registration) => void;
  onWaive: (r: Registration) => void;
  onWithdraw: (r: Registration) => void;
}) {
  const msg = useMsg();
  const queue = [...rows].sort(
    (a, b) => (positions.get(a.id) ?? 0) - (positions.get(b.id) ?? 0),
  );

  if (queue.length === 0) {
    return <div className="card p-6 text-sm text-slate-500">{msg("reg.waitlist.empty")}</div>;
  }

  return (
    <ol className="space-y-2" data-testid="waitlist-queue">
      {queue.map((r) => {
        const feeDue = r.amount_cents > 0 && !r.payment_intent_id;
        return (
          // Card on mobile (position + identity, actions below), inline row
          // from sm: up — mirrors the registration list's responsive shape.
          <li key={r.id} className="card flex flex-col gap-2 p-3 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
            <span className="flex min-w-0 items-center gap-3 sm:flex-1">
              <span
                className="w-8 shrink-0 text-center font-mono text-sm font-bold text-sky-700"
                data-testid="queue-position"
              >
                #{positions.get(r.id) ?? "?"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-slate-800">{r.display_name}</span>
                <span className="block truncate text-xs text-slate-500">
                  {r.contact_email} · {msg("reg.waitlist.joined", { date: new Date(r.created_at).toLocaleDateString() })}
                </span>
              </span>
            </span>
            {canEdit && (
              <span className="flex gap-1 border-t border-slate-100 pt-2 sm:border-0 sm:pt-0">
                {feeDue ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onWaive(r)}
                    className="btn btn-ghost text-xs"
                    title={msg("reg.action.waiveTitle")}
                  >
                    {msg("reg.waitlist.waivePromote")}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onPromote(r)}
                    className="btn btn-ghost text-xs font-medium text-emerald-700"
                    title={msg("reg.waitlist.promoteTitle")}
                  >
                    {msg("reg.waitlist.promote")}
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onWithdraw(r)}
                  className="btn btn-ghost text-xs text-red-600"
                >
                  {msg("reg.action.withdraw")}
                </button>
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
