"use client";

// Organiser registration console (doc 16 §1.1, PROMPT-20a item 4; PROMPT-52
// reshape): composition shell owning state + API calls, rendering the
// settings accordion (registration-settings.tsx) beside the registration
// list. All derived numbers come from lib/registration-derive over the row
// set this panel already loads.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useConfirm } from "@/components/ui/confirm-provider";
import { Tip } from "@/components/ui/tip";
import { msg } from "@/lib/messages";
import { normalizeRefCode } from "@/lib/ref-code";
import { registrationPulse } from "@/lib/registration-derive";
import { RegistrationSettings } from "./registration-settings";

export interface FormField {
  key: string;
  label: string;
  kind: "text" | "select" | "checkbox";
  options?: string[];
  required: boolean;
}

export interface Settings {
  enabled: boolean;
  entrant_kind: "team" | "individual" | "pair";
  opens_at: string | null;
  closes_at: string | null;
  capacity: number | null;
  fee_cents: number;
  currency: string;
  refund_lock_at: string | null;
  form_fields: FormField[];
  payment_method: "offline" | "stripe";
  payment_instructions: string | null;
  org_payment_instructions: string | null;
  org_default_payment_method: string;
  charges_enabled: boolean;
  updated_at: string | null;
}

export interface Registration {
  id: string;
  status: string;
  ref_code: string | null;
  display_name: string;
  contact_email: string;
  dob: string | null;
  guardian_name: string | null;
  answers: Record<string, unknown>;
  amount_cents: number;
  currency: string | null;
  payment_method: "offline" | "stripe" | null;
  payment_intent_id: string | null;
  refunded_cents: number;
  /** Set once any refund ran — with refunded < amount it means incomplete. */
  refunded_at: string | null;
  expires_at: string | null;
  offline_marked_paid_at: string | null;
  disputed_at: string | null;
  entrant_id: string | null;
  created_at: string;
}

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700",
  paid: "bg-emerald-100 text-emerald-700",
  confirmed: "bg-emerald-100 text-emerald-700",
  waitlisted: "bg-sky-100 text-sky-700",
  withdrawn: "bg-slate-100 text-slate-500",
  expired: "bg-zinc-100 text-zinc-500",
};

/** Payment chip per row (spec §8): one glanceable money state. */
function paymentChip(r: Registration): { label: string; cls: string } | null {
  if (r.amount_cents <= 0 && !r.payment_intent_id) return null;
  if (r.disputed_at) return { label: "⚠ disputed", cls: "bg-rose-100 text-rose-700" };
  const partiallyRefunded = r.refunded_cents > 0 && r.refunded_cents < r.amount_cents;
  if (r.refunded_cents >= r.amount_cents && r.refunded_cents > 0)
    return { label: "refunded", cls: "bg-slate-100 text-slate-600" };
  if (r.status === "withdrawn" && r.payment_intent_id && r.refunded_cents < r.amount_cents)
    return { label: "refund incomplete", cls: "bg-amber-100 text-amber-800" };
  if (partiallyRefunded)
    return { label: "partly refunded", cls: "bg-amber-100 text-amber-700" };
  if (r.offline_marked_paid_at) return { label: "paid · cash", cls: "bg-emerald-100 text-emerald-700" };
  if (r.payment_intent_id && (r.status === "paid" || r.status === "confirmed"))
    return { label: "paid · card", cls: "bg-emerald-100 text-emerald-700" };
  if (r.status === "pending") {
    return r.payment_method === "stripe"
      ? { label: `due · card${hoursLeft(r.expires_at)}`, cls: "bg-amber-100 text-amber-700" }
      : { label: "due · cash", cls: "bg-amber-100 text-amber-700" };
  }
  return null;
}

function hoursLeft(iso: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return " · expiring";
  const h = Math.round(ms / 3_600_000);
  return h >= 48 ? "" : ` · ${h}h left`;
}


export function RegistrationsPanel({
  divisionId,
  canEdit,
  paidAllowed = true,
}: {
  divisionId: string;
  canEdit: boolean;
  /** registration.paid entitlement — false shows the plan badge on the fee field. */
  paidAllowed?: boolean;
}) {
  const confirmDialog = useConfirm();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [regs, setRegs] = useState<Registration[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // Ref-or-name filter (v3/05 §3). Refs match dash/case-insensitively so a
  // code quoted over the phone ("sz abcd efgh") still finds the row.
  const q = query.trim().toLowerCase();
  const qAsRef = normalizeRefCode(query).toLowerCase();
  const shownRegs =
    q === ""
      ? regs
      : regs.filter(
          (r) =>
            r.display_name.toLowerCase().includes(q) ||
            r.contact_email.toLowerCase().includes(q) ||
            (r.ref_code !== null &&
              (r.ref_code.toLowerCase().includes(q) || r.ref_code.toLowerCase() === qAsRef)),
        );
  // Fee is entered in major units (pounds) but stored as integer minor units
  // (pence). A local string keeps mid-typing states like "1." / "1.5" intact.
  const [feeText, setFeeText] = useState("");
  const feeInited = useRef(false);

  // PROMPT-52 derived numbers — pure lenses over the already-loaded rows;
  // no extra API round trip.
  const capacity = settings?.capacity ?? null;
  const pulse = useMemo(() => registrationPulse(regs, capacity), [regs, capacity]);

  const refresh = useCallback(async () => {
    const [s, r] = await Promise.all([
      apiV1<Settings>(`/api/v1/divisions/${divisionId}/registration-settings`),
      apiV1<Registration[]>(`/api/v1/divisions/${divisionId}/registrations`),
    ]);
    // Never-saved divisions preselect the org's default method (spec §3).
    const preselectStripe =
      s.updated_at === null && s.org_default_payment_method === "stripe" && s.charges_enabled;
    setSettings(preselectStripe ? { ...s, payment_method: "stripe" } : s);
    setRegs(r);
  }, [divisionId]);

  useEffect(() => {
    refresh().catch((err) =>
      setError(err instanceof Error ? err.message : "Failed to load"),
    );
  }, [refresh]);

  // Seed the pounds field once, from the loaded settings.
  useEffect(() => {
    if (settings && !feeInited.current) {
      feeInited.current = true;
      setFeeText((settings.fee_cents / 100).toString());
    }
  }, [settings]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setPaywall(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywall((err.extra.feature_key as string) ?? "registration.paid");
      } else {
        setError(err instanceof Error ? err.message : "Failed");
      }
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!settings) return;
    setSaved(false);
    // Sanitise questions so one incomplete row can't 400 the whole save:
    // drop blank labels, snake_case + de-duplicate keys, keep select options.
    const seen = new Set<string>();
    const form_fields = settings.form_fields
      .filter((f) => f.label.trim())
      .map((f) => {
        let key = (f.key || f.label).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "field";
        while (seen.has(key)) key = `${key}_x`.slice(0, 40);
        seen.add(key);
        const base = { key, label: f.label.trim(), kind: f.kind, required: f.required };
        return f.kind === "select"
          ? { ...base, options: (f.options ?? []).filter(Boolean).length ? f.options!.filter(Boolean) : ["Option 1"] }
          : base;
      });
    await run(async () => {
      await apiV1(`/api/v1/divisions/${divisionId}/registration-settings`, {
        method: "PUT",
        json: {
          enabled: settings.enabled,
          entrant_kind: settings.entrant_kind,
          opens_at: settings.opens_at,
          closes_at: settings.closes_at,
          capacity: settings.capacity,
          fee_cents: settings.fee_cents,
          currency: settings.currency,
          refund_lock_at: settings.refund_lock_at,
          form_fields,
          payment_method: settings.payment_method,
          payment_instructions: settings.payment_instructions?.trim() || null,
        },
      });
      setSaved(true);
    });
  }

  async function action(
    id: string,
    verb: "confirm" | "waitlist" | "withdraw" | "refund" | "mark-paid" | "waive",
  ) {
    const dialogFor: Partial<Record<typeof verb, Parameters<typeof confirmDialog>[0]>> = {
      withdraw: {
        title: msg("confirm.withdrawRegistration.title"),
        body: msg("confirm.withdrawRegistration.body"),
        confirmLabel: msg("confirm.withdrawRegistration.label"),
        tone: "danger",
      },
      refund: {
        title: msg("confirm.refundRegistration.title"),
        body: msg("confirm.refundRegistration.body"),
        confirmLabel: msg("confirm.refundRegistration.label"),
      },
      "mark-paid": {
        title: msg("confirm.markPaidRegistration.title"),
        body: msg("confirm.markPaidRegistration.body"),
        confirmLabel: msg("confirm.markPaidRegistration.label"),
      },
      waive: {
        title: msg("confirm.waiveRegistration.title"),
        body: msg("confirm.waiveRegistration.body"),
        confirmLabel: msg("confirm.waiveRegistration.label"),
      },
    };
    const dialog = dialogFor[verb];
    if (dialog && !(await confirmDialog(dialog))) return;
    void run(() => apiV1(`/api/v1/registrations/${id}/${verb}`, { method: "POST", json: {} }));
  }

  function remind(id: string) {
    setNotice(null);
    void run(async () => {
      const res = await apiV1<{ sent: boolean }>(`/api/v1/registrations/${id}/remind`, {
        method: "POST",
        json: {},
      });
      setNotice(res.sent ? "Payment reminder sent." : "Reminder not sent — email isn't configured.");
    });
  }

  if (!settings) {
    return <p className="text-sm text-slate-400">{error ?? "Loading…"}</p>;
  }

  const set = (patch: Partial<Settings>) => setSettings({ ...settings, ...patch });

  return (
    <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
      <aside className="space-y-4">
        <RegistrationSettings
          settings={settings}
          pulse={pulse}
          feeText={feeText}
          onFeeText={setFeeText}
          onPatch={set}
          onSave={save}
          canEdit={canEdit}
          paidAllowed={paidAllowed}
          busy={busy}
          saved={saved}
        />

        {paywall && <UpgradeGate feature={paywall} />}
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}
        {notice && <p className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{notice}</p>}
      </aside>

      <section>
        {settings.payment_method === "stripe" && !settings.charges_enabled && (
          <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
            Card payments are offline — registrants can&apos;t pay until Stripe is reconnected
            under <a href="/settings/payments" className="underline">Settings → Payments</a>. The public
            page shows the division as temporarily unavailable.
          </div>
        )}
        {regs.some((r) => r.disputed_at) && (
          <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
            {regs.filter((r) => r.disputed_at).length} payment(s) disputed — check your email
            and Stripe dashboard. Disputed rows are flagged below.
          </div>
        )}
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
            Registrations <span className="text-slate-500">({regs.length})</span>
            <Tip id="registration.ref-number" />
          </h2>
          {/* Search by ref (v3/05 §3) — day-of check-in lookup. Names match
              too, so one box serves both. */}
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search ref or name…"
            aria-label="Search registrations by reference or name"
            className="input w-48 px-2 py-1 text-xs"
            data-testid="reg-search"
          />
          <a
            href={`/api/v1/divisions/${divisionId}/registrations/export`}
            className="btn btn-ghost text-xs"
          >
            Export CSV
          </a>
        </div>

        {regs.length === 0 ? (
          <div className="card p-6 text-sm text-slate-500">
            No registrations yet. Share the public competition page — the Register button
            appears while a division is open.
          </div>
        ) : shownRegs.length === 0 ? (
          <div className="card p-6 text-sm text-slate-500">
            Nothing matches “{query}” — check the reference for typos (letters O/I are never
            used; try 0/1).
          </div>
        ) : (
          <ul className="space-y-2">
            {shownRegs.map((r) => {
              const refundable =
                r.payment_intent_id !== null && r.refunded_cents < r.amount_cents;
              const chip = paymentChip(r);
              return (
                <li key={r.id} className="card flex flex-wrap items-center gap-3 p-3 text-sm">
                  <span className={`badge ${STATUS_STYLE[r.status] ?? ""}`}>{r.status}</span>
                  {chip && (
                    <span className={`badge ${chip.cls}`} data-testid="payment-chip">
                      {chip.label}
                    </span>
                  )}
                  {r.ref_code && (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-slate-700">
                      {r.ref_code}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-slate-800">
                      {r.display_name}
                      {r.entrant_id && (
                        <span className="ml-2 text-xs font-normal text-emerald-600">entrant ✓</span>
                      )}
                    </span>
                    <span className="block truncate text-xs text-slate-500">
                      {r.contact_email}
                      {r.guardian_name ? ` · guardian: ${r.guardian_name}` : ""}
                      {r.amount_cents > 0
                        ? ` · ${(r.amount_cents / 100).toFixed(2)} ${r.currency ?? ""}` +
                          (r.refunded_cents > 0 ? ` (refunded ${(r.refunded_cents / 100).toFixed(2)})` : "")
                        : ""}
                    </span>
                  </span>
                  {canEdit && (
                    <span className="flex gap-1">
                      {r.status === "pending" && r.amount_cents > 0 && !r.payment_intent_id && (
                        <button type="button" disabled={busy} onClick={() => action(r.id, "mark-paid")} className="btn btn-ghost text-xs font-medium text-emerald-700" title="Record a cash/bank payment and confirm the entry">
                          Mark paid
                        </button>
                      )}
                      {(r.status === "pending" || r.status === "waitlisted") &&
                        (r.amount_cents > 0 && !r.payment_intent_id ? (
                          <button type="button" disabled={busy} onClick={() => action(r.id, "waive")} className="btn btn-ghost text-xs" title="Confirm without payment (fee waived, logged)">
                            Waive fee
                          </button>
                        ) : (
                          <button type="button" disabled={busy} onClick={() => action(r.id, "confirm")} className="btn btn-ghost text-xs">
                            Approve
                          </button>
                        ))}
                      {r.status === "pending" && (
                        <button type="button" disabled={busy} onClick={() => action(r.id, "waitlist")} className="btn btn-ghost text-xs">
                          Waitlist
                        </button>
                      )}
                      {r.status === "pending" && r.amount_cents > 0 && r.payment_method !== "stripe" && (
                        <button type="button" disabled={busy} onClick={() => remind(r.id)} className="btn btn-ghost text-xs" title="Email the registrant a payment reminder">
                          Send reminder
                        </button>
                      )}
                      {r.status !== "withdrawn" && r.status !== "expired" && (
                        <button type="button" disabled={busy} onClick={() => action(r.id, "withdraw")} className="btn btn-ghost text-xs text-red-600">
                          Withdraw
                        </button>
                      )}
                      {refundable && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => action(r.id, "refund")}
                          className={`btn btn-ghost text-xs ${chip?.label === "refund incomplete" ? "font-medium text-amber-700" : ""}`}
                          title={chip?.label === "refund incomplete" ? "The automatic refund failed — retry it" : "Refund the remaining amount"}
                        >
                          {chip?.label === "refund incomplete" ? "Retry refund" : "Refund"}
                        </button>
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
