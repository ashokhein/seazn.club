"use client";

// Sponsor monetization console (v10 PROMPT-56 follow-on): the owner-facing
// surface for the packages/orders rail. Create a priced package, send the
// sponsor a pay-now invoice (order row + Stripe Checkout link + email), and
// watch orders move pending → paid as placements activate. Pro
// `sponsors.monetize`; checkout itself also requires Stripe Connect.
import { useCallback, useEffect, useState } from "react";
import Link from "@/components/ui/console-link";
import { Copy, Send, Undo2, XCircle } from "lucide-react";
import { useMsg } from "@/components/i18n/dict-provider";
import { useConfirm } from "@/components/ui/confirm-provider";
import type { MessageKey } from "@/lib/messages";
import { SPONSOR_TIERS, type SponsorTier } from "@/components/org-sponsors";

interface PackageItem {
  id: string;
  competition_id: string | null;
  name: string;
  description: string | null;
  price_cents: number;
  currency: string;
  tier: SponsorTier;
  active: boolean;
}

interface OrderItem {
  id: string;
  package_id: string;
  sponsor_name: string;
  sponsor_email: string;
  amount_cents: number;
  currency: string;
  status: "pending" | "paid" | "failed" | "refunded";
  disputed_at: string | null;
  dispute_id: string | null;
  created_at: string;
}

const TIER_MSG: Record<SponsorTier, MessageKey> = {
  title: "sponsors.tier.titleTier",
  gold: "sponsors.tier.gold",
  silver: "sponsors.tier.silver",
  partner: "sponsors.tier.partner",
};

const STATUS_MSG: Record<OrderItem["status"], MessageKey> = {
  pending: "sponsors.order.status.pending",
  paid: "sponsors.order.status.paid",
  failed: "sponsors.order.status.failed",
  refunded: "sponsors.order.status.refunded",
};

const STATUS_BADGE: Record<OrderItem["status"], string> = {
  pending: "bg-amber-50 text-amber-700",
  paid: "bg-emerald-50 text-emerald-700",
  failed: "bg-red-50 text-red-600",
  refunded: "bg-slate-100 text-slate-500",
};

const CURRENCIES = ["gbp", "eur", "usd"] as const;

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

export function SponsorPackages({
  orgId,
  competitions,
  hasMonetize,
  billingHref,
}: {
  orgId: string;
  competitions: { id: string; name: string }[];
  hasMonetize: boolean;
  billingHref: string;
}) {
  const msg = useMsg();
  const confirm = useConfirm();
  const [packages, setPackages] = useState<PackageItem[]>([]);
  const [orders, setOrders] = useState<OrderItem[]>([]);
  const [draft, setDraft] = useState({
    name: "", price: "", currency: "gbp" as string, tier: "gold" as SponsorTier, competition_id: "",
  });
  const [invoiceFor, setInvoiceFor] = useState<string | null>(null);
  const [invoice, setInvoice] = useState({ name: "", email: "" });
  const [sentUrl, setSentUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const api = useCallback(
    async (path: string, init?: RequestInit): Promise<unknown> => {
      const res = await fetch(`/api/v1/orgs/${orgId}${path}`, {
        headers: { "Content-Type": "application/json" },
        ...init,
      });
      const json = (await res.json().catch(() => ({}))) as {
        data?: unknown;
        error?: string | { message?: string };
      };
      if (!res.ok) {
        const message = typeof json.error === "string" ? json.error : json.error?.message;
        throw new Error(message ?? "Request failed");
      }
      return json.data;
    },
    [orgId],
  );

  const load = useCallback(async () => {
    const [pkgs, ords] = await Promise.all([
      api("/sponsor-packages") as Promise<PackageItem[]>,
      api("/sponsor-orders") as Promise<OrderItem[]>,
    ]);
    setPackages(pkgs);
    setOrders(ords);
  }, [api]);

  useEffect(() => {
    if (hasMonetize) void load().catch(() => {});
  }, [hasMonetize, load]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  function createPackage() {
    void run(async () => {
      const price_cents = Math.round(Number.parseFloat(draft.price) * 100);
      await api("/sponsor-packages", {
        method: "POST",
        body: JSON.stringify({
          name: draft.name.trim(),
          price_cents,
          currency: draft.currency,
          tier: draft.tier,
          ...(draft.competition_id ? { competition_id: draft.competition_id } : {}),
        }),
      });
      setDraft({ name: "", price: "", currency: "gbp", tier: "gold", competition_id: "" });
      await load();
    });
  }

  function retirePackage(pkg: PackageItem) {
    void (async () => {
      const ok = await confirm({
        title: msg("sponsors.pkg.retireConfirm.title"),
        body: msg("sponsors.pkg.retireConfirm.body", { name: pkg.name }),
        confirmLabel: msg("sponsors.pkg.retireConfirm.label"),
      });
      if (!ok) return;
      await run(async () => {
        await api(`/sponsor-packages/${pkg.id}`, { method: "DELETE" });
        await load();
      });
    })();
  }

  function refundOrder(order: OrderItem) {
    void (async () => {
      const amount = money(order.amount_cents, order.currency);
      const ok = await confirm({
        title: msg("sponsors.order.refundConfirm.title"),
        body: msg("sponsors.order.refundConfirm.body", { amount, name: order.sponsor_name }),
        confirmLabel: msg("sponsors.order.refundConfirm.label", { amount }),
        tone: "danger",
      });
      if (!ok) return;
      await run(async () => {
        await api(`/sponsor-orders/${order.id}/refund`, { method: "POST" });
        await load();
      });
    })();
  }

  function sendInvoice(pkg: PackageItem) {
    void (async () => {
      // Each invoice is its own payable order — warn before minting a
      // second one for the same sponsor + package, or they can pay twice.
      const email = invoice.email.trim().toLowerCase();
      const duplicate = orders.some(
        (o) =>
          o.status === "pending" &&
          o.package_id === pkg.id &&
          o.sponsor_email.toLowerCase() === email,
      );
      if (duplicate) {
        const ok = await confirm({
          title: msg("sponsors.order.dupConfirm.title"),
          body: msg("sponsors.order.dupConfirm.body", { email: invoice.email.trim() }),
          confirmLabel: msg("sponsors.order.dupConfirm.label"),
          tone: "danger",
        });
        if (!ok) return;
      }
      await run(async () => {
        const result = (await api("/sponsor-orders", {
          method: "POST",
          body: JSON.stringify({
            package_id: pkg.id,
            sponsor_name: invoice.name.trim(),
            sponsor_email: invoice.email.trim(),
          }),
        })) as { checkout_url: string };
        setSentUrl(result.checkout_url);
        setInvoice({ name: "", email: "" });
        setInvoiceFor(null);
        await load();
      });
    })();
  }

  const priceInvalid = draft.price.trim() !== "" && !(Number.parseFloat(draft.price) > 0);

  if (!hasMonetize) {
    return (
      <p className="text-sm text-slate-500">
        {msg("sponsors.sell.upsell")}{" "}
        <Link href={billingHref} className="text-purple-600 underline">
          {msg("settings.upgrade.link")}
        </Link>
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">{msg("sponsors.sell.hint")}</p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {sentUrl ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <span>{msg("sponsors.order.sent")}</span>
          <code className="max-w-72 truncate text-xs">{sentUrl}</code>
          <button
            type="button"
            aria-label={msg("sponsors.order.copyLink")}
            onClick={() => void navigator.clipboard?.writeText(sentUrl)}
            className="grid h-6 w-6 place-items-center rounded text-emerald-700 hover:bg-emerald-100"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      {/* Create a package */}
      <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
        <p className="mb-3 text-sm font-semibold text-slate-800">{msg("sponsors.pkg.create")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="label">{msg("sponsors.pkg.name")}</span>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              maxLength={120}
              className="input w-full"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="label">{msg("sponsors.pkg.price")}</span>
              <input
                value={draft.price}
                onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                inputMode="decimal"
                placeholder="250"
                aria-invalid={priceInvalid || undefined}
                className={`input w-full ${priceInvalid ? "border-red-400" : ""}`}
              />
            </label>
            <label className="block">
              <span className="label">{msg("sponsors.pkg.currency")}</span>
              <select
                value={draft.currency}
                onChange={(e) => setDraft({ ...draft, currency: e.target.value })}
                className="input w-full"
              >
                {CURRENCIES.map((cur) => (
                  <option key={cur} value={cur}>
                    {cur.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block">
            <span className="label">{msg("sponsors.tierLabel")}</span>
            <select
              value={draft.tier}
              onChange={(e) => setDraft({ ...draft, tier: e.target.value as SponsorTier })}
              className="input w-full"
            >
              {SPONSOR_TIERS.map((t) => (
                <option key={t} value={t}>
                  {msg(TIER_MSG[t])}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">{msg("sponsors.scopeLabel")}</span>
            <select
              value={draft.competition_id}
              onChange={(e) => setDraft({ ...draft, competition_id: e.target.value })}
              className="input w-full"
            >
              <option value="">{msg("sponsors.scopeAll")}</option>
              {competitions.map((comp) => (
                <option key={comp.id} value={comp.id}>
                  {comp.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            disabled={busy || !draft.name.trim() || !(Number.parseFloat(draft.price) > 0)}
            onClick={createPackage}
            className="btn btn-primary"
          >
            {busy ? "…" : msg("sponsors.pkg.create")}
          </button>
        </div>
      </div>

      {/* Packages */}
      {packages.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-sm text-slate-400">
          {msg("sponsors.sell.empty")}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
          {packages.map((pkg) => (
            <li key={pkg.id} className="px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">
                    {pkg.name}
                    {!pkg.active ? (
                      <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-500">
                        {msg("sponsors.pkg.retired")}
                      </span>
                    ) : null}
                  </p>
                  <p className="truncate text-xs text-slate-400">
                    {msg(TIER_MSG[pkg.tier])} · {money(pkg.price_cents, pkg.currency)}
                    {pkg.competition_id
                      ? ` · ${competitions.find((c) => c.id === pkg.competition_id)?.name ?? "…"}`
                      : ""}
                  </p>
                </div>
                {pkg.active ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setInvoiceFor(invoiceFor === pkg.id ? null : pkg.id);
                        setSentUrl(null);
                      }}
                      className="btn flex items-center gap-1.5 text-xs"
                    >
                      <Send className="h-3.5 w-3.5" />
                      {msg("sponsors.pkg.invoice")}
                    </button>
                    <button
                      type="button"
                      aria-label={msg("sponsors.pkg.retire", { name: pkg.name })}
                      disabled={busy}
                      onClick={() => retirePackage(pkg)}
                      className="grid h-7 w-7 place-items-center rounded text-slate-400 hover:bg-red-50 hover:text-red-500"
                    >
                      <XCircle className="h-4 w-4" />
                    </button>
                  </div>
                ) : null}
              </div>
              {invoiceFor === pkg.id ? (
                <div className="mt-3 grid items-end gap-3 sm:grid-cols-3">
                  <label className="block">
                    <span className="label">{msg("sponsors.order.name")}</span>
                    <input
                      value={invoice.name}
                      onChange={(e) => setInvoice({ ...invoice, name: e.target.value })}
                      maxLength={80}
                      className="input w-full"
                    />
                  </label>
                  <label className="block">
                    <span className="label">{msg("sponsors.order.email")}</span>
                    <input
                      value={invoice.email}
                      onChange={(e) => setInvoice({ ...invoice, email: e.target.value })}
                      type="email"
                      className="input w-full"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={busy || !invoice.name.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(invoice.email)}
                    onClick={() => sendInvoice(pkg)}
                    className="btn btn-primary"
                  >
                    {busy ? "…" : msg("sponsors.order.send")}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {/* Orders */}
      <div>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
          {msg("sponsors.orders.title")}
        </p>
        {orders.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-sm text-slate-400">
            {msg("sponsors.orders.empty")}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {orders.map((order) => (
              <li key={order.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{order.sponsor_name}</p>
                  <p className="truncate text-xs text-slate-400">{order.sponsor_email}</p>
                </div>
                <span className="text-sm tabular-nums text-slate-600">
                  {money(order.amount_cents, order.currency)}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                    order.disputed_at
                      ? "bg-rose-100 text-rose-700"
                      : order.status === "refunded" && order.dispute_id
                        ? "bg-rose-200 text-rose-900"
                        : STATUS_BADGE[order.status]
                  }`}
                >
                  {msg(
                    order.disputed_at
                      ? "sponsors.order.status.disputed"
                      : order.status === "refunded" && order.dispute_id
                        ? "sponsors.order.status.disputeLost"
                        : STATUS_MSG[order.status],
                  )}
                </span>
                {order.status === "paid" && !order.disputed_at ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => refundOrder(order)}
                    className="btn flex items-center gap-1.5 text-xs text-red-500 hover:bg-red-50"
                  >
                    <Undo2 className="h-3.5 w-3.5" />
                    {msg("sponsors.order.refund")}
                  </button>
                ) : null}
                {order.disputed_at || order.dispute_id ? (
                  // Same rail as registrations: one document, mapped to
                  // Stripe's evidence fields, downloaded from the flagged row.
                  <a
                    href={`/api/v1/orgs/${orgId}/sponsor-orders/${order.id}/evidence`}
                    download
                    className="btn btn-ghost text-xs font-medium text-rose-700"
                    title={msg("sponsors.order.evidenceTitle")}
                  >
                    {msg("sponsors.order.evidence")}
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
