"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Create form for a new coupon + promotion code. Superadmin only. */
export function AdminCouponCreate() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [code, setCode] = useState("");
  const [discountKind, setDiscountKind] = useState<"percent" | "amount">("percent");
  const [percentOff, setPercentOff] = useState("20");
  const [amountOff, setAmountOff] = useState("10");
  const [currency, setCurrency] = useState("GBP");
  const [duration, setDuration] = useState<"once" | "repeating" | "forever">("once");
  const [durationInMonths, setDurationInMonths] = useState("3");
  const [maxRedemptions, setMaxRedemptions] = useState("");
  const [expiresAt, setExpiresAt] = useState(""); // yyyy-mm-dd

  async function submit() {
    setLoading(true);
    setError("");
    try {
      const body: Record<string, unknown> = {
        code: code.trim(),
        duration,
      };
      if (discountKind === "percent") {
        body.percentOff = Number(percentOff);
      } else {
        body.amountOff = Number(amountOff);
        body.currency = currency.trim().toUpperCase();
      }
      if (duration === "repeating") body.durationInMonths = Number(durationInMonths);
      if (maxRedemptions) body.maxRedemptions = Number(maxRedemptions);
      if (expiresAt) body.expiresAt = Math.floor(new Date(expiresAt).getTime() / 1000);

      const res = await fetch("/api/admin/coupons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? "Failed");
      }
      setCode("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }

  const inputCls =
    "rounded border border-slate-600 bg-slate-700 px-2 py-1 text-sm text-white placeholder:text-slate-500";

  return (
    <div className="space-y-3 rounded-lg bg-slate-800 p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
        New coupon
      </h2>

      <div className="flex flex-wrap gap-2">
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="CODE (e.g. LAUNCH20)"
          className={`${inputCls} w-48 font-mono`}
        />

        <select
          value={discountKind}
          onChange={(e) => setDiscountKind(e.target.value as "percent" | "amount")}
          className={inputCls}
        >
          <option value="percent">% off</option>
          <option value="amount">amount off</option>
        </select>

        {discountKind === "percent" ? (
          <input
            type="number"
            value={percentOff}
            onChange={(e) => setPercentOff(e.target.value)}
            className={`${inputCls} w-20`}
            min={0}
            max={100}
          />
        ) : (
          <>
            <input
              type="number"
              value={amountOff}
              onChange={(e) => setAmountOff(e.target.value)}
              className={`${inputCls} w-24`}
              min={0}
              step="0.01"
            />
            <input
              type="text"
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              className={`${inputCls} w-16`}
              maxLength={3}
            />
          </>
        )}

        <select
          value={duration}
          onChange={(e) =>
            setDuration(e.target.value as "once" | "repeating" | "forever")
          }
          className={inputCls}
        >
          <option value="once">once</option>
          <option value="repeating">repeating</option>
          <option value="forever">forever</option>
        </select>

        {duration === "repeating" && (
          <input
            type="number"
            value={durationInMonths}
            onChange={(e) => setDurationInMonths(e.target.value)}
            className={`${inputCls} w-20`}
            min={1}
            max={60}
            title="months"
          />
        )}

        <input
          type="number"
          value={maxRedemptions}
          onChange={(e) => setMaxRedemptions(e.target.value)}
          placeholder="max uses"
          className={`${inputCls} w-24`}
          min={1}
        />

        <input
          type="date"
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
          className={inputCls}
          title="expires at"
        />

        <button
          onClick={submit}
          disabled={loading || !code.trim()}
          className="rounded bg-purple-700 px-4 py-1 text-sm text-white hover:bg-purple-600 disabled:opacity-50"
        >
          {loading ? "…" : "Create"}
        </button>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

/** Toggle button for a single promotion code's active state. */
export function AdminCouponToggle({
  promoId,
  active,
}: {
  promoId: string;
  active: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function toggle() {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/coupons/${promoId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !active }),
      });
      if (res.ok) router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={toggle}
      disabled={loading}
      className={`rounded px-2 py-1 text-xs text-white disabled:opacity-50 ${
        active ? "bg-red-800 hover:bg-red-700" : "bg-emerald-700 hover:bg-emerald-600"
      }`}
    >
      {loading ? "…" : active ? "Deactivate" : "Activate"}
    </button>
  );
}
