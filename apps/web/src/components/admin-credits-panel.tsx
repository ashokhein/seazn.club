"use client";

// SPEC-6 C2 — admin Credits section + Grant/deduct modal. Wires the P4
// `POST /api/admin/orgs/[id]/credits` route: signed `delta`, one of the five
// `reason_code`s, an optional free-text note, and a client-generated
// `idempotency_key` per modal open so a double-submit cannot double-grant.
//
// This is a CLIENT component (modal + state). The rest of /admin is
// English-only (no `t`/`dict` island), so this matches — no i18n imports.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/modal";

/** The 5 server-enforced reason codes → friendly labels (order is the dropdown
 *  order). Kept in lockstep with the route's zod enum. */
const REASONS: { code: string; label: string }[] = [
  { code: "support_goodwill", label: "Support goodwill" },
  { code: "sales_comp", label: "Sales comp" },
  { code: "promo", label: "Promo" },
  { code: "bug_fix", label: "Bug fix" },
  { code: "refund_adjust", label: "Refund adjustment" },
];

/** Server hard cap for support staff (SPEC-3 §2). Superadmin is unlimited. */
const SUPPORT_CREDIT_CAP = 50;

export function AdminCreditsPanel({
  orgId,
  walletId,
  sharedByOrgs,
  balance,
  staffRole,
}: {
  orgId: string;
  walletId: string;
  sharedByOrgs: number;
  balance: number;
  /** The CALLER's role, so the modal can show the ≤50 hint. The server still
   *  enforces the cap and 403s — this hint is advisory only. */
  staffRole: "support" | "superadmin" | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Fresh idempotency key per open: a double-click on Grant replays the SAME
  // key, which the route treats as a no-op (applied:false) instead of a second
  // grant. Rotated in `openModal` so a reopened modal gets a new adjustment.
  const [idemKey, setIdemKey] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState(REASONS[0].code);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [balanceAfter, setBalanceAfter] = useState<number | null>(null);

  const isSupport = staffRole !== "superadmin";
  const delta = Number(amount);
  const deltaValid = Number.isInteger(delta) && delta !== 0;
  const overCap = isSupport && deltaValid && Math.abs(delta) > SUPPORT_CREDIT_CAP;

  function openModal() {
    setIdemKey(
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `adj-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    setAmount("");
    setReason(REASONS[0].code);
    setNote("");
    setError("");
    setBalanceAfter(null);
    setBusy(false);
    setOpen(true);
  }

  async function submit() {
    if (!deltaValid || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/orgs/${orgId}/credits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          delta,
          reason_code: reason,
          note: note.trim() || undefined,
          idempotency_key: idemKey,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "Adjustment failed");
      // The handler wraps success as { ok, data:{ balance_after, applied } }, so
      // the balance is under d.data — reading top-level left the confirmation dead.
      setBalanceAfter(typeof d.data?.balance_after === "number" ? d.data.balance_after : null);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Adjustment failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-slate-300">AI credits</h2>
      <div className="rounded-lg bg-slate-800 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="text-2xl font-bold text-white">
              {balance.toLocaleString()}{" "}
              <span className="text-sm font-normal text-slate-300">credits</span>
            </p>
            <p className="font-mono text-xs text-slate-300">wallet {walletId}</p>
            {sharedByOrgs > 1 && (
              <p className="text-xs text-amber-300">
                Shared by {sharedByOrgs} orgs in this billing group — an adjustment moves the whole pool.
              </p>
            )}
          </div>
          <button
            onClick={openModal}
            className="rounded bg-purple-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-600"
          >
            Grant / deduct
          </button>
        </div>
      </div>

      {open && (
        <Modal
          title="Grant / deduct credits"
          onClose={() => setOpen(false)}
          footer={
            balanceAfter !== null ? (
              <button onClick={() => setOpen(false)} className="btn btn-primary">
                Done
              </button>
            ) : (
              <>
                <button onClick={() => setOpen(false)} className="btn btn-ghost">
                  Cancel
                </button>
                <button
                  onClick={submit}
                  disabled={!deltaValid || overCap || busy}
                  className="btn btn-primary disabled:opacity-40"
                >
                  {busy ? "Applying…" : delta < 0 ? "Deduct" : "Grant"}
                </button>
              </>
            )
          }
        >
          {balanceAfter !== null ? (
            <p className="text-slate-700">
              Applied. New wallet balance:{" "}
              <span className="font-semibold text-purple-900">
                {balanceAfter.toLocaleString()} credits
              </span>
              .
            </p>
          ) : (
            <div className="space-y-4">
              <div>
                <label htmlFor="adj-amount" className="mb-1 block text-xs font-medium text-slate-600">
                  Amount (±N credits)
                </label>
                <input
                  id="adj-amount"
                  type="number"
                  step={1}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="e.g. 25 to grant, -10 to deduct"
                  className="input w-full"
                />
                {isSupport ? (
                  <p className={`mt-1 text-xs ${overCap ? "text-red-600" : "text-slate-500"}`}>
                    Support staff may adjust ≤ {SUPPORT_CREDIT_CAP} credits at a time.
                    {overCap && " This needs a superadmin."}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-slate-500">Superadmin — no adjustment cap.</p>
                )}
              </div>

              <div>
                <label htmlFor="adj-reason" className="mb-1 block text-xs font-medium text-slate-600">
                  Reason
                </label>
                <select
                  id="adj-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="input w-full"
                >
                  {REASONS.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="adj-note" className="mb-1 block text-xs font-medium text-slate-600">
                  Note (optional)
                </label>
                <input
                  id="adj-note"
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={500}
                  placeholder="Context for the audit log"
                  className="input w-full"
                />
              </div>

              {error && <p className="text-xs text-red-600">{error}</p>}
            </div>
          )}
        </Modal>
      )}
    </section>
  );
}
