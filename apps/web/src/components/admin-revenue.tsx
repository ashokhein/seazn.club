"use client";

// /admin/revenue client (design/v7 PROMPT-51). All data comes through
// /api/admin/revenue so preset changes, custom ranges, and test fixtures
// share one path; amounts stay in minor units until formatMinor renders
// them. Currencies are never summed — every surface groups by currency.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { asCurrency, formatMinor } from "@/lib/currency";

interface Bucket {
  gross: number;
  refunded: number;
  net: number;
  count: number;
}
interface OrgBucket extends Bucket {
  name: string;
  slug: string | null;
}
interface RevenueData {
  from: string;
  to: string;
  byMonth: Record<string, Record<string, Bucket>>;
  byOrg: Record<string, Record<string, OrgBucket>>;
  rows: unknown[];
}

type Preset = "12m" | "year" | "all" | "custom";

const PRESETS: { key: Exclude<Preset, "custom">; label: string }[] = [
  { key: "12m", label: "Last 12 months" },
  { key: "year", label: "This year" },
  { key: "all", label: "All time (24m cap)" },
];

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function presetQuery(preset: Preset, custom: { from: string; to: string }): string {
  if (preset === "12m") return "";
  if (preset === "year") return `?from=${new Date().getUTCFullYear()}-01-01&to=${todayUtc()}`;
  if (preset === "all") {
    // 24 calendar months incl. the current one — the widest range the
    // usecase accepts (its cap is measured against from + 24 months).
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 23, 1));
    return `?from=${from.toISOString().slice(0, 10)}&to=${todayUtc()}`;
  }
  return `?from=${custom.from}&to=${custom.to}`;
}

const money = (minor: number, currency: string) => formatMinor(minor, asCurrency(currency));

export function AdminRevenue() {
  const [preset, setPreset] = useState<Preset>("12m");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [query, setQuery] = useState("");
  const [data, setData] = useState<RevenueData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Loading/error flips happen in the range handlers (and initial state),
  // not synchronously here — react-hooks/set-state-in-effect.
  useEffect(() => {
    let alive = true;
    fetch(`/api/admin/revenue${query}`)
      .then(async (res) => {
        const body = (await res.json()) as { ok: boolean; data?: RevenueData; error?: string };
        if (!res.ok || !body.ok || !body.data) {
          throw new Error(body.error ?? `Load failed (${res.status})`);
        }
        if (alive) setData(body.data);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : "Load failed");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [query]);

  const currencies = useMemo(() => (data ? Object.keys(data.byMonth).sort() : []), [data]);
  const multiCurrency = currencies.length > 1;

  const totals = useMemo(
    () =>
      currencies.map((currency) => {
        const total = { gross: 0, refunded: 0, net: 0, count: 0 };
        for (const bucket of Object.values(data!.byMonth[currency]!)) {
          total.gross += bucket.gross;
          total.refunded += bucket.refunded;
          total.net += bucket.net;
          total.count += bucket.count;
        }
        return { currency, ...total };
      }),
    [currencies, data],
  );

  const monthRows = useMemo(() => {
    if (!data) return [];
    return currencies
      .flatMap((currency) =>
        Object.entries(data.byMonth[currency]!).map(([month, bucket]) => ({ month, currency, ...bucket })),
      )
      .sort((a, b) => b.month.localeCompare(a.month) || a.currency.localeCompare(b.currency));
  }, [currencies, data]);

  const orgRows = useMemo(() => {
    if (!data) return [];
    return currencies.flatMap((currency) =>
      Object.entries(data.byOrg[currency] ?? {})
        .map(([orgId, bucket]) => ({ orgId, currency, ...bucket }))
        .sort((a, b) => b.net - a.net),
    );
  }, [currencies, data]);

  const applyRange = (next: Preset) => {
    setPreset(next);
    setLoading(true);
    setError(null);
    setQuery(presetQuery(next, custom));
  };

  const csvHref = `/api/admin/revenue${query ? `${query}&` : "?"}format=csv`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => applyRange(key)}
            className={
              preset === key
                ? "rounded bg-purple-700 px-3 py-1.5 text-sm font-medium text-white"
                : "rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-300 hover:text-white"
            }
          >
            {label}
          </button>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={custom.from}
            aria-label="From date"
            onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-white [color-scheme:dark]"
          />
          <span className="text-xs text-slate-500">to</span>
          <input
            type="date"
            value={custom.to}
            aria-label="To date"
            onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-white [color-scheme:dark]"
          />
          <button
            type="button"
            disabled={!custom.from || !custom.to}
            onClick={() => applyRange("custom")}
            className="rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-300 hover:text-white disabled:opacity-50"
          >
            Apply
          </button>
        </div>
        <a
          href={csvHref}
          className="ml-auto rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-300 hover:text-white"
        >
          Download CSV
        </a>
      </div>

      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/50 p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading && !data && <div className="rounded-lg bg-slate-800 p-6 text-sm text-slate-400">Loading…</div>}

      {data && data.rows.length === 0 && !error && (
        <div className="rounded-lg bg-slate-800 p-6 text-sm text-slate-400">
          No card entry fees collected yet — fees appear once organisers take card registrations.
        </div>
      )}

      {data && data.rows.length > 0 && (
        <>
          {totals.map((total) => (
            <section key={total.currency} className="space-y-2">
              {multiCurrency && (
                <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500">
                  {total.currency.toUpperCase()}
                </h2>
              )}
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <div className="rounded-lg bg-slate-800 p-4">
                  <div className="text-xs uppercase tracking-wider text-slate-400">Net collected</div>
                  <div className="mt-1 text-2xl font-bold tabular-nums text-white">
                    {money(total.net, total.currency)}
                  </div>
                </div>
                <div className="rounded-lg bg-slate-800 p-4">
                  <div className="text-xs uppercase tracking-wider text-slate-400">Gross</div>
                  <div className="mt-1 text-2xl font-bold tabular-nums text-slate-200">
                    {money(total.gross, total.currency)}
                  </div>
                </div>
                <div className="rounded-lg bg-slate-800 p-4">
                  <div className="text-xs uppercase tracking-wider text-slate-400">Refunded</div>
                  <div className="mt-1 text-2xl font-bold tabular-nums text-slate-200">
                    {money(total.refunded, total.currency)}
                  </div>
                </div>
                <div className="rounded-lg bg-slate-800 p-4">
                  <div className="text-xs uppercase tracking-wider text-slate-400">Fees</div>
                  <div className="mt-1 text-2xl font-bold tabular-nums text-slate-200">{total.count}</div>
                </div>
              </div>
            </section>
          ))}

          <section className="rounded-lg bg-slate-800 p-4">
            <h2 className="text-sm font-semibold text-white">By month</h2>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
                    <th className="py-1.5 pr-3 font-medium">Month</th>
                    {multiCurrency && <th className="py-1.5 pr-3 font-medium">Currency</th>}
                    <th className="py-1.5 pr-3 text-right font-medium">Gross</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Refunded</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Net</th>
                    <th className="py-1.5 text-right font-medium">Fees</th>
                  </tr>
                </thead>
                <tbody>
                  {monthRows.map((row) => (
                    <tr key={`${row.month}-${row.currency}`} className="border-t border-slate-700/60">
                      <td className="py-1.5 pr-3 text-slate-200">{row.month}</td>
                      {multiCurrency && (
                        <td className="py-1.5 pr-3 text-slate-400">{row.currency.toUpperCase()}</td>
                      )}
                      <td className="py-1.5 pr-3 text-right tabular-nums text-slate-300">
                        {money(row.gross, row.currency)}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-slate-300">
                        {money(row.refunded, row.currency)}
                      </td>
                      <td className="py-1.5 pr-3 text-right font-medium tabular-nums text-white">
                        {money(row.net, row.currency)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-slate-300">{row.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg bg-slate-800 p-4">
            <h2 className="text-sm font-semibold text-white">By organisation</h2>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
                    <th className="py-1.5 pr-3 font-medium">Organisation</th>
                    {multiCurrency && <th className="py-1.5 pr-3 font-medium">Currency</th>}
                    <th className="py-1.5 pr-3 text-right font-medium">Gross</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Refunded</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Net</th>
                    <th className="py-1.5 text-right font-medium">Fees</th>
                  </tr>
                </thead>
                <tbody>
                  {orgRows.map((row) => (
                    <tr key={`${row.orgId}-${row.currency}`} className="border-t border-slate-700/60">
                      <td className="py-1.5 pr-3">
                        {row.orgId === "disconnected" ? (
                          <span className="text-slate-400">{row.name}</span>
                        ) : (
                          <Link
                            href={`/admin/orgs/${row.orgId}`}
                            className="text-purple-300 hover:text-white"
                          >
                            {row.name}
                          </Link>
                        )}
                      </td>
                      {multiCurrency && (
                        <td className="py-1.5 pr-3 text-slate-400">{row.currency.toUpperCase()}</td>
                      )}
                      <td className="py-1.5 pr-3 text-right tabular-nums text-slate-300">
                        {money(row.gross, row.currency)}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-slate-300">
                        {money(row.refunded, row.currency)}
                      </td>
                      <td className="py-1.5 pr-3 text-right font-medium tabular-nums text-white">
                        {money(row.net, row.currency)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-slate-300">{row.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
