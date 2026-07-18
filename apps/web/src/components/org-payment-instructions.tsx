"use client";

// Org payments card (spec 2026-07-12 §8): Stripe Connect status + onboarding,
// the org's default payment method for new divisions, and the org-wide
// offline instructions (divisions can override both per-division).
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/client";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { ProseEditor } from "@/components/prose-editor";
import { useMsg } from "@/components/i18n/dict-provider";

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
  const msg = useMsg();
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
  const [tosAgreed, setTosAgreed] = useState(false);
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
      setError(err instanceof Error ? err.message : msg("pay.saveFailed"));
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
      setError(err instanceof Error ? err.message : msg("pay.saveFailed"));
    }
  }

  async function startOnboarding() {
    setConnectBusy(true);
    setConnectError(null);
    try {
      const { url } = await apiV1<{ url: string }>(`/api/v1/orgs/${orgId}/connect`, {
        method: "POST",
        json: { return_path: "/settings/connect", tos_agreed: tosAgreed },
      });
      window.location.assign(url);
    } catch (err) {
      setConnectError(
        err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED"
          ? msg("pay.needPro")
          : err instanceof Error
            ? err.message
            : msg("pay.onboardErr"),
      );
      setConnectBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Stripe Connect (owners only — the API enforces it too). */}
      {isOwner && (
        <div data-tour="connect-stripe" className="rounded-lg border border-slate-200 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-slate-800">{msg("pay.cardTitle")}</p>
              <p className="mt-0.5 text-xs text-slate-500">{msg("pay.cardBlurb")}</p>
            </div>
            {connect?.charges_enabled ? (
              <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700">
                {msg("pay.statusLive")}
              </span>
            ) : connect?.connected ? (
              <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-700">
                {msg("pay.statusIncomplete")}
              </span>
            ) : (
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500">
                {msg("pay.statusNone")}
              </span>
            )}
          </div>
          {/* What connecting involves — the three stops on the way to taking
              card entry fees, with the current one highlighted. */}
          <ol className="mt-3 space-y-2">
            {[
              {
                label: msg("pay.stepConnect"),
                detail: msg("pay.stepConnectDetail"),
                done: !!connect?.connected,
                active: !connect?.connected,
              },
              {
                label: msg("pay.stepVerify"),
                detail: msg("pay.stepVerifyDetail"),
                done: !!connect?.charges_enabled,
                active: !!connect?.connected && !connect?.charges_enabled,
              },
              {
                label: msg("pay.stepGoLive"),
                detail: msg("pay.stepGoLiveDetail"),
                done: !!connect?.charges_enabled,
                active: !!connect?.charges_enabled,
              },
            ].map((step, i) => (
              <li key={step.label} className="flex items-start gap-2.5">
                <span
                  className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${
                    step.done
                      ? "bg-emerald-100 text-emerald-700"
                      : step.active
                        ? "bg-purple-100 text-purple-700"
                        : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {step.done ? "✓" : i + 1}
                </span>
                <p className="text-xs leading-5 text-slate-500">
                  <span
                    className={`font-medium ${
                      step.active ? "text-purple-700" : "text-slate-700"
                    }`}
                  >
                    {step.label}
                  </span>{" "}
                  — {step.detail}
                </p>
              </li>
            ))}
          </ol>
          {/* ToS gate (PROMPT-55): the first connect creates the Express
              account, so the chargeback clause is accepted before it exists.
              Resuming an existing onboarding never re-asks. */}
          {!connect?.charges_enabled && !connect?.connected && (
            <label className="mt-3 flex items-start gap-2 text-xs leading-5 text-slate-600">
              <input
                type="checkbox"
                checked={tosAgreed}
                onChange={(e) => setTosAgreed(e.target.checked)}
                className="mt-0.5 accent-purple-600"
              />
              <span>
                {msg("pay.tosAgree")
                  .split("{terms}")
                  .flatMap((part, i) =>
                    i === 0
                      ? [part]
                      : [
                          <a
                            key="terms"
                            href="/legal/terms"
                            target="_blank"
                            rel="noreferrer"
                            className="text-purple-600 underline"
                          >
                            {msg("pay.tosTerms")}
                          </a>,
                          part,
                        ],
                  )}
              </span>
            </label>
          )}
          {!connect?.charges_enabled && (
            <button
              type="button"
              onClick={startOnboarding}
              disabled={connectBusy || (!connect?.connected && !tosAgreed)}
              className="btn btn-primary mt-3 px-4 text-sm"
            >
              {connectBusy
                ? msg("pay.opening")
                : connect?.connected
                  ? msg("pay.resume")
                  : msg("pay.connect")}
            </button>
          )}
          {connectError && <p className="mt-2 text-xs text-red-600">{connectError}</p>}
        </div>
      )}

      {/* Default method for new divisions. */}
      <fieldset>
        <legend className="label">{msg("pay.methodLegend")}</legend>
        <p className="mb-2 text-xs text-slate-500">{msg("pay.methodHint")}</p>
        <div className="flex gap-2">
          {(
            [
              { key: "offline", label: msg("pay.methodOffline") },
              { key: "stripe", label: msg("pay.methodStripe") },
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
        <span className="label">{msg("pay.cashTitle")}</span>
        <p className="mb-2 text-xs text-slate-500">
          {msg("pay.cashHintPre")}
          <code className="rounded bg-slate-100 px-1">{"{{reference}}"}</code>
          {msg("pay.cashHintPost")}
        </p>
        <ProseEditor
          value={value}
          onChange={(md) => {
            setValue(md);
            setSaved(false);
          }}
          orgId={orgId}
          placeholder={"Bank: Example Bank\nAccount name: Riverside FC\nSort code: 00-00-00\nAccount no: 12345678\nReference: {{reference}}"}
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={saveInstructions}
            disabled={busy || !dirty}
            className="btn btn-primary px-4"
          >
            {busy ? msg("pay.saving") : msg("pay.save")}
          </button>
          {error && <span className="text-xs text-red-600">{error}</span>}
          {saved && !error && <span className="text-xs text-green-600">{msg("pay.saved")}</span>}
        </div>
      </label>
    </div>
  );
}
