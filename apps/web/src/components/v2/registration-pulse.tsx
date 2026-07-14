"use client";

// Registration pulse (PROMPT-52): one glanceable strip per division —
// entries against capacity, card-money state, next expiry. Every number is
// a button that jumps the list to the matching tab, so the strip doubles as
// navigation. Pure render over the derived Pulse; the refresh button calls
// back into the panel's loader (payments land out-of-band via Stripe).
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import type { Pulse } from "@/lib/registration-derive";
import { currencySymbol } from "./registration-settings";

export type Tab = "confirmed" | "pending" | "waitlist" | "disputed" | "all";

function hoursUntil(iso: string): string {
  const h = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 3_600_000));
  return `${h}h`;
}

function Metric({
  label,
  value,
  tone = "text-slate-800",
  onClick,
  testId,
}: {
  label: string;
  value: string;
  tone?: string;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="rounded-md px-2 py-1 text-left transition hover:bg-slate-100"
    >
      <span className={`block text-base font-semibold tabular-nums ${tone}`}>{value}</span>
      <span className="block text-[11px] uppercase tracking-wide text-slate-400">{label}</span>
    </button>
  );
}

export function RegistrationPulse({
  pulse,
  currency,
  onJump,
  onRefresh,
}: {
  pulse: Pulse;
  currency: string;
  onJump: (tab: Tab) => void;
  onRefresh?: () => Promise<void>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const sym = currencySymbol(currency);
  const money = (cents: number) => `${sym}${(cents / 100).toFixed(2)}`;
  const anyMoney =
    pulse.paidCents > 0 || pulse.dueCents > 0 || pulse.refundIncomplete > 0 || pulse.disputed > 0;

  return (
    <div className="card mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 p-3" data-testid="reg-pulse">
      <Metric
        label={pulse.capacity !== null ? `confirmed of ${pulse.capacity}` : "confirmed"}
        value={String(pulse.confirmed)}
        tone="text-emerald-700"
        onClick={() => onJump("confirmed")}
        testId="pulse-confirmed"
      />
      <Metric
        label={
          pulse.nextExpiry !== null
            ? `holding · next expiry ${hoursUntil(pulse.nextExpiry)}`
            : "holding a spot"
        }
        value={String(pulse.holding)}
        tone="text-amber-700"
        onClick={() => onJump("pending")}
        testId="pulse-holding"
      />
      <Metric
        label="waitlisted"
        value={String(pulse.waitlisted)}
        tone="text-sky-700"
        onClick={() => onJump("waitlist")}
        testId="pulse-waitlisted"
      />
      {anyMoney && (
        <>
          <span aria-hidden className="mx-1 hidden h-8 w-px bg-slate-200 sm:block" />
          <Metric label="paid" value={money(pulse.paidCents)} onClick={() => onJump("all")} />
          {pulse.dueCents > 0 && (
            <Metric
              label="due"
              value={money(pulse.dueCents)}
              tone="text-amber-700"
              onClick={() => onJump("pending")}
            />
          )}
          {pulse.refundIncomplete > 0 && (
            <Metric
              label="refund needs retry"
              value={String(pulse.refundIncomplete)}
              tone="text-amber-800"
              onClick={() => onJump("all")}
            />
          )}
          {pulse.disputed > 0 && (
            <Metric
              label="disputed"
              value={String(pulse.disputed)}
              tone="text-rose-700"
              onClick={() => onJump("disputed")}
            />
          )}
        </>
      )}
      {onRefresh && (
        <button
          type="button"
          aria-label="Refresh registrations"
          title="Refresh registrations"
          disabled={refreshing}
          onClick={async () => {
            setRefreshing(true);
            try {
              await onRefresh();
            } finally {
              setRefreshing(false);
            }
          }}
          className="ml-auto rounded-md p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}
