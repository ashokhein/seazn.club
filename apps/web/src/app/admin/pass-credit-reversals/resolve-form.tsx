"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Record a staff decision about ONE undetermined pass-credit reversal
 * (#305, #286 phase 2).
 *
 * The two decisions are deliberately not symmetric in the UI either:
 * `clawed_back` releases the group's lifetime pass-credit cap and so demands
 * the amount actually removed in Stripe, and is only offered to a superadmin
 * (the route enforces it — this just avoids showing support staff a control
 * that would 403). `kept` moves nothing.
 */
export function ResolveUndeterminedForm({
  redemptionId,
  grantedMinor,
  currency,
  canClawBack,
}: {
  redemptionId: string;
  grantedMinor: number;
  currency: string;
  canClawBack: boolean;
}) {
  const router = useRouter();
  const [resolution, setResolution] = useState<"clawed_back" | "kept">(
    canClawBack ? "clawed_back" : "kept",
  );
  const [reversedMinor, setReversedMinor] = useState(String(grantedMinor));
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const inputCls =
    "rounded border border-slate-600 bg-slate-700 px-2 py-1 text-xs text-white placeholder:text-slate-500";

  async function submit() {
    setLoading(true);
    setError("");
    try {
      const body: Record<string, unknown> = { redemption_id: redemptionId, resolution, reason };
      if (resolution === "clawed_back") body.reversed_minor = Number(reversedMinor);
      const res = await fetch("/api/admin/pass-credit-reversals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? `Failed (${res.status})`);
      }
      setReason("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* max-w-full: a <select> is sized by its widest OPTION, which at 375px
          would otherwise push the card wider than the viewport. */}
      <select
        aria-label="Resolution"
        className={`${inputCls} max-w-full`}
        value={resolution}
        onChange={(e) => setResolution(e.target.value as "clawed_back" | "kept")}
      >
        {canClawBack && <option value="clawed_back">Clawed back — free the cap</option>}
        <option value="kept">Kept — cap stays held</option>
      </select>
      {resolution === "clawed_back" && (
        <input
          aria-label={`Minor units removed (${currency})`}
          className={`${inputCls} w-28`}
          inputMode="numeric"
          value={reversedMinor}
          onChange={(e) => setReversedMinor(e.target.value)}
          placeholder={`minor ${currency}`}
        />
      )}
      <input
        aria-label="Reason"
        className={`${inputCls} min-w-0 flex-1`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="What you checked, and where"
      />
      <button
        type="button"
        disabled={loading || reason.trim().length === 0}
        onClick={submit}
        className="rounded bg-purple-700 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
      >
        {loading ? "Saving…" : "Record"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
