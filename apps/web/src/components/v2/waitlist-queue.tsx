"use client";

// Waitlist as a QUEUE (PROMPT-52): ordered rows with a visible position,
// joined-at, and a Promote affordance consistent with auto-promotion (the
// oldest entry is #1 — the same row the sweep would promote). Semantics
// untouched: Promote calls the existing confirm/waive endpoints.
import type { Registration } from "./registrations-panel";

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
  const queue = [...rows].sort(
    (a, b) => (positions.get(a.id) ?? 0) - (positions.get(b.id) ?? 0),
  );

  if (queue.length === 0) {
    return (
      <div className="card p-6 text-sm text-slate-500">
        Nobody is waiting. The waitlist fills once the division is at capacity.
      </div>
    );
  }

  return (
    <ol className="space-y-2" data-testid="waitlist-queue">
      {queue.map((r) => {
        const feeDue = r.amount_cents > 0 && !r.payment_intent_id;
        return (
          <li key={r.id} className="card flex flex-wrap items-center gap-3 p-3 text-sm">
            <span
              className="w-8 text-center font-mono text-sm font-bold text-sky-700"
              data-testid="queue-position"
            >
              #{positions.get(r.id) ?? "?"}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-slate-800">{r.display_name}</span>
              <span className="block truncate text-xs text-slate-500">
                {r.contact_email} · joined {new Date(r.created_at).toLocaleDateString()}
              </span>
            </span>
            {canEdit && (
              <span className="flex gap-1">
                {feeDue ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onWaive(r)}
                    className="btn btn-ghost text-xs"
                    title="Confirm without payment (fee waived, logged)"
                  >
                    Waive fee &amp; promote
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onPromote(r)}
                    className="btn btn-ghost text-xs font-medium text-emerald-700"
                    title="Confirm this entry now — same as auto-promotion when a spot frees"
                  >
                    Promote
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onWithdraw(r)}
                  className="btn btn-ghost text-xs text-red-600"
                >
                  Withdraw
                </button>
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
