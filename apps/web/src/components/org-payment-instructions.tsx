"use client";

// Org payments card (spec 2026-07-12 §8): Stripe Connect status + onboarding,
// the org's default payment method for new divisions, and the org-wide
// offline instructions (divisions can override both per-division).
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/client";
import { apiV1, ApiV1Error } from "@/lib/client-v1";

interface ConnectStatus {
  connected: boolean;
  charges_enabled: boolean;
  details_submitted: boolean | null;
}

export function OrgPaymentInstructions({
  orgId,
  initialValue,
  initialDefaultMethod = "offline",
  isOwner = false,
}: {
  orgId: string;
  initialValue: string | null;
  initialDefaultMethod?: "offline" | "stripe";
  isOwner?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(initialValue ?? "");
  const [method, setMethod] = useState<"offline" | "stripe">(initialDefaultMethod);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connect, setConnect] = useState<ConnectStatus | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectBusy, setConnectBusy] = useState(false);
  const dirty = value.trim() !== (initialValue ?? "").trim();

  // Connect status is owner-only server-side; returning from Stripe
  // onboarding (?connect=return) forces a live re-read (reconcile-on-return).
  useEffect(() => {
    if (!isOwner) return;
    const refresh = searchParams.get("connect") === "return" ? "?refresh=1" : "";
    apiV1<ConnectStatus>(`/api/v1/orgs/${orgId}/connect${refresh}`)
      .then(setConnect)
      .catch(() => setConnect(null));
  }, [orgId, isOwner, searchParams]);

  async function saveInstructions() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api(`/api/orgs/${orgId}`, {
        method: "PATCH",
        json: { payment_instructions: value.trim() || null },
      });
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  async function saveMethod(next: "offline" | "stripe") {
    const prev = method;
    setMethod(next);
    try {
      await api(`/api/orgs/${orgId}`, {
        method: "PATCH",
        json: { default_payment_method: next },
      });
      router.refresh();
    } catch (err) {
      setMethod(prev);
      setError(err instanceof Error ? err.message : "Failed to save");
    }
  }

  async function startOnboarding() {
    setConnectBusy(true);
    setConnectError(null);
    try {
      const { url } = await apiV1<{ url: string }>(`/api/v1/orgs/${orgId}/connect`, {
        method: "POST",
        json: { return_path: "/settings" },
      });
      window.location.assign(url);
    } catch (err) {
      setConnectError(
        err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED"
          ? "Card payments need Pro or an Event Pass."
          : err instanceof Error
            ? err.message
            : "Could not start Stripe onboarding",
      );
      setConnectBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Stripe Connect (owners only — the API enforces it too). */}
      {isOwner && (
        <div className="rounded-lg border border-slate-200 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-slate-800">Card payments (Stripe)</p>
              <p className="mt-0.5 text-xs text-slate-500">
                Entry fees settle straight to your Stripe account; entries confirm
                automatically on payment.
              </p>
            </div>
            {connect?.charges_enabled ? (
              <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700">
                ● Live — charges enabled
              </span>
            ) : connect?.connected ? (
              <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-700">
                Onboarding incomplete
              </span>
            ) : (
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500">
                Not connected
              </span>
            )}
          </div>
          {!connect?.charges_enabled && (
            <button
              type="button"
              onClick={startOnboarding}
              disabled={connectBusy}
              className="btn btn-primary mt-3 px-4 text-sm"
            >
              {connectBusy
                ? "Opening Stripe…"
                : connect?.connected
                  ? "Resume Stripe onboarding"
                  : "Connect Stripe"}
            </button>
          )}
          {connectError && <p className="mt-2 text-xs text-red-600">{connectError}</p>}
        </div>
      )}

      {/* Default method for new divisions. */}
      <fieldset>
        <legend className="label">How do entry fees usually work?</legend>
        <p className="mb-2 text-xs text-slate-500">
          Preselected when you set up registration on a new division — each division can
          still choose its own.
        </p>
        <div className="flex gap-2">
          {(
            [
              { key: "offline", label: "Pay the organiser" },
              { key: "stripe", label: "Card at sign-up" },
            ] as const
          ).map((opt) => (
            <label
              key={opt.key}
              className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${
                method === opt.key
                  ? "border-purple-300 bg-purple-50 text-slate-900"
                  : "border-slate-200 text-slate-600 hover:border-slate-300"
              }`}
            >
              <input
                type="radio"
                name="org_default_method"
                checked={method === opt.key}
                onChange={() => void saveMethod(opt.key)}
              />
              {opt.label}
            </label>
          ))}
        </div>
      </fieldset>

      {/* Org-wide offline instructions. */}
      <label className="block">
        <span className="label">Cash / bank transfer instructions</span>
        <p className="mb-2 text-xs text-slate-500">
          Shown to registrants of pay-the-organiser divisions and included in their
          confirmation email. Divisions can override these. e.g. bank name, account number,
          sort code / IBAN, reference to use, or &ldquo;pay cash on the day&rdquo;.
        </p>
        <textarea
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
          }}
          rows={5}
          maxLength={2000}
          placeholder={"Bank: Example Bank\nAccount name: Riverside FC\nSort code: 00-00-00\nAccount no: 12345678\nReference: your team name"}
          className="input w-full font-mono text-sm"
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={saveInstructions}
            disabled={busy || !dirty}
            className="btn btn-primary px-4"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          {error && <span className="text-xs text-red-600">{error}</span>}
          {saved && !error && <span className="text-xs text-green-600">Saved.</span>}
        </div>
      </label>
    </div>
  );
}
