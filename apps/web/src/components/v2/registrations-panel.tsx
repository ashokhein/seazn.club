"use client";

// Organiser registration console (doc 16 §1.1, PROMPT-20a item 4):
// settings (window, fee, capacity, bounded form-field builder), the
// registration list with approve / waitlist / withdraw / refund, CSV export,
// and the Stripe Connect onboarding banner that gates entry fees.
import { useCallback, useEffect, useRef, useState } from "react";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { PlanBadge } from "@/components/plan-badge";
import { useConfirm } from "@/components/ui/confirm-provider";
import { Tip } from "@/components/ui/tip";
import { msg } from "@/lib/messages";
import { normalizeRefCode } from "@/lib/ref-code";

interface FormField {
  key: string;
  label: string;
  kind: "text" | "select" | "checkbox";
  options?: string[];
  required: boolean;
}

interface Settings {
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

interface Registration {
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

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(v: string): string | null {
  return v ? new Date(v).toISOString() : null;
}

const CURRENCY_SYMBOLS: Record<string, string> = { gbp: "£", usd: "$", eur: "€" };
function currencySymbol(code: string): string {
  return CURRENCY_SYMBOLS[code?.toLowerCase()] ?? (code || "").toUpperCase();
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

  const refresh = useCallback(async () => {
    const [s, r] = await Promise.all([
      apiV1<Settings>(`/api/v1/divisions/${divisionId}/registration-settings`),
      apiV1<Registration[]>(`/api/v1/divisions/${divisionId}/registrations`),
    ]);
    setSettings(s);
    setRegs(r);
  }, [divisionId]);

  useEffect(() => {
    refresh().catch((err) =>
      setError(err instanceof Error ? err.message : "Failed to load"),
    );
  }, [refresh]);

  // Seed the pounds field once, from the loaded settings. Never-saved
  // divisions preselect the org's default payment method (spec §3).
  useEffect(() => {
    if (settings && !feeInited.current) {
      feeInited.current = true;
      setFeeText((settings.fee_cents / 100).toString());
      if (
        settings.updated_at === null &&
        settings.org_default_payment_method === "stripe" &&
        settings.charges_enabled
      ) {
        setSettings((s) => (s ? { ...s, payment_method: "stripe" } : s));
      }
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
  const paidConfigured = settings.fee_cents > 0;

  return (
    <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
      <aside className="space-y-4">
        <section className="card space-y-3 p-5">
          <h2 className="text-sm font-semibold text-slate-700">Registration settings</h2>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              disabled={!canEdit}
              checked={settings.enabled}
              onChange={(e) => set({ enabled: e.target.checked })}
            />
            Open for public registration
          </label>

          <label className="block text-xs text-slate-500">
            Entrant type
            <select
              disabled={!canEdit}
              value={settings.entrant_kind}
              onChange={(e) => set({ entrant_kind: e.target.value as Settings["entrant_kind"] })}
              className="input mt-1 w-full"
            >
              <option value="individual">Individual (creates a player)</option>
              <option value="team">Team</option>
              <option value="pair">Pair</option>
            </select>
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-slate-500">
              Opens
              <input
                type="datetime-local"
                disabled={!canEdit}
                value={toLocalInput(settings.opens_at)}
                onChange={(e) => set({ opens_at: fromLocalInput(e.target.value) })}
                className="input mt-1 w-full"
              />
            </label>
            <label className="block text-xs text-slate-500">
              Closes
              <input
                type="datetime-local"
                disabled={!canEdit}
                value={toLocalInput(settings.closes_at)}
                onChange={(e) => set({ closes_at: fromLocalInput(e.target.value) })}
                className="input mt-1 w-full"
              />
            </label>
          </div>

          <label className="block text-xs text-slate-500">
            Capacity (blank = uncapped; overflow joins the waitlist)
            <input
              type="number"
              min={1}
              disabled={!canEdit}
              value={settings.capacity ?? ""}
              onChange={(e) =>
                set({ capacity: e.target.value === "" ? null : Number(e.target.value) })
              }
              className="input mt-1 w-full"
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-slate-500">
              <span className="flex items-center gap-1.5">
                Entry fee ({currencySymbol(settings.currency)}; 0 = free)
                {!paidAllowed && <PlanBadge feature="registration.paid" />}
              </span>
              <div className="mt-1 flex items-center">
                <span className="rounded-l-md border border-r-0 border-slate-200 bg-slate-50 px-2.5 py-2 text-sm text-slate-500">
                  {currencySymbol(settings.currency)}
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  disabled={!canEdit}
                  value={feeText}
                  onChange={(e) => {
                    const t = e.target.value;
                    // Allow empty, whole, or up to 2 decimals while typing.
                    if (!/^\d*\.?\d{0,2}$/.test(t)) return;
                    setFeeText(t);
                    const pounds = parseFloat(t);
                    set({ fee_cents: Number.isFinite(pounds) ? Math.round(pounds * 100) : 0 });
                  }}
                  onBlur={() => {
                    // Normalise "1.5" → "1.50", "" → "0" on leaving the field.
                    setFeeText((settings.fee_cents / 100).toFixed(2));
                  }}
                  className="input w-full rounded-l-none"
                />
              </div>
            </label>
            <label className="block text-xs text-slate-500">
              Currency
              <input
                maxLength={3}
                disabled={!canEdit}
                value={settings.currency}
                onChange={(e) => set({ currency: e.target.value.toLowerCase() })}
                className="input mt-1 w-full"
              />
            </label>
          </div>

          {paidConfigured && (
            <fieldset className="space-y-2">
              <legend className="text-xs text-slate-500">How is the fee collected?</legend>
              <label
                className={`flex items-start gap-2.5 rounded-md border p-3 text-xs transition ${
                  settings.payment_method === "offline"
                    ? "border-purple-300 bg-purple-50"
                    : "border-slate-200 bg-white hover:border-slate-300"
                } ${canEdit ? "cursor-pointer" : ""}`}
              >
                <input
                  type="radio"
                  name="payment_method"
                  className="mt-0.5"
                  disabled={!canEdit}
                  checked={settings.payment_method === "offline"}
                  onChange={() => set({ payment_method: "offline" })}
                />
                <span>
                  <span className="block font-medium text-slate-800">Pay the organiser</span>
                  <span className="mt-0.5 block text-slate-500">
                    Cash or bank transfer. Entries are pending until you mark them paid.
                  </span>
                </span>
              </label>
              {settings.payment_method === "offline" && (
                <label className="block text-xs text-slate-500">
                  Payment instructions for this division
                  <textarea
                    disabled={!canEdit}
                    value={settings.payment_instructions ?? ""}
                    onChange={(e) =>
                      set({ payment_instructions: e.target.value || null })
                    }
                    rows={3}
                    maxLength={2000}
                    placeholder={
                      settings.org_payment_instructions
                        ? "Leave blank to use your organisation's instructions"
                        : "e.g. bank details or “pay cash on the day” — or set organisation-wide instructions in Settings → Payments"
                    }
                    className="input mt-1 w-full font-mono text-xs"
                  />
                  {!settings.payment_instructions && settings.org_payment_instructions && (
                    <span className="mt-1 block text-[11px] text-slate-400">
                      Using your organisation&apos;s instructions.
                    </span>
                  )}
                </label>
              )}
              <label
                className={`flex items-start gap-2.5 rounded-md border p-3 text-xs transition ${
                  settings.payment_method === "stripe"
                    ? "border-purple-300 bg-purple-50"
                    : "border-slate-200 bg-white hover:border-slate-300"
                } ${!settings.charges_enabled ? "opacity-60" : canEdit ? "cursor-pointer" : ""}`}
              >
                <input
                  type="radio"
                  name="payment_method"
                  className="mt-0.5"
                  disabled={!canEdit || !settings.charges_enabled}
                  checked={settings.payment_method === "stripe"}
                  onChange={() => set({ payment_method: "stripe" })}
                />
                <span>
                  <span className="flex items-center gap-1.5 font-medium text-slate-800">
                    Card payment at sign-up
                    {!paidAllowed && <PlanBadge feature="registration.paid" />}
                  </span>
                  <span className="mt-0.5 block text-slate-500">
                    Paid via Stripe when they register · confirmed automatically · unpaid
                    entries expire after 48h and the waitlist moves up.
                  </span>
                  {!settings.charges_enabled && (
                    <a href="/settings" className="mt-1 block font-medium text-purple-700 underline">
                      Connect Stripe in Settings → Payments first
                    </a>
                  )}
                </span>
              </label>
            </fieldset>
          )}

          {canEdit && (
            <button type="button" disabled={busy} onClick={save} className="btn btn-primary w-full">
              {busy ? "…" : "Save settings"}
            </button>
          )}
          {saved && <p className="text-xs text-emerald-600">Saved.</p>}
        </section>

        <FormBuilder
          fields={settings.form_fields}
          canEdit={canEdit}
          onChange={(form_fields) => set({ form_fields })}
        />

        {paywall && <UpgradeGate feature={paywall} />}
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}
        {notice && <p className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{notice}</p>}
      </aside>

      <section>
        {settings.payment_method === "stripe" && !settings.charges_enabled && (
          <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
            Card payments are offline — registrants can&apos;t pay until Stripe is reconnected
            under <a href="/settings" className="underline">Settings → Payments</a>. The public
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

// ---------------------------------------------------------------------------
// Bounded form-field builder (doc 16 §1.1): text / select / checkbox only.
// ---------------------------------------------------------------------------

function FormBuilder({
  fields,
  canEdit,
  onChange,
}: {
  fields: FormField[];
  canEdit: boolean;
  onChange: (fields: FormField[]) => void;
}) {
  function update(i: number, patch: Partial<FormField>) {
    onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  }

  function add() {
    // A blank label fails validation and blocks the whole save, so seed a
    // valid default the organiser can rename.
    const n = fields.length + 1;
    onChange([...fields, { key: `question_${n}`, label: `Question ${n}`, kind: "text", required: false }]);
  }

  return (
    <section className="card space-y-3 p-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">Extra sign-up questions</h2>
          <p className="text-xs text-slate-400">
            Ask registrants anything beyond name, email and date of birth.
          </p>
        </div>
        {canEdit && fields.length < 12 && (
          <button type="button" onClick={add} className="btn btn-ghost text-xs">
            + Add question
          </button>
        )}
      </div>
      {fields.length === 0 && (
        <p className="text-xs text-slate-400">
          e.g. shirt size, dietary needs, emergency contact, club membership number, or a
          &ldquo;I agree to the code of conduct&rdquo; checkbox.
        </p>
      )}
      {fields.map((f, i) => (
        <div key={i} className="space-y-2 rounded-md border border-slate-200 p-3">
          <div className="flex gap-2">
            <input
              placeholder="Label"
              disabled={!canEdit}
              value={f.label}
              onChange={(e) =>
                update(i, {
                  label: e.target.value,
                  key:
                    e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, "_")
                      .replace(/^_+|_+$/g, "")
                      .slice(0, 40) || f.key,
                })
              }
              className="input flex-1 text-sm"
            />
            <select
              disabled={!canEdit}
              value={f.kind}
              onChange={(e) =>
                update(i, {
                  kind: e.target.value as FormField["kind"],
                  options: e.target.value === "select" ? (f.options ?? [""]) : undefined,
                })
              }
              className="input text-sm"
            >
              <option value="text">Text</option>
              <option value="select">Select</option>
              <option value="checkbox">Checkbox</option>
            </select>
          </div>
          {f.kind === "select" && (
            <input
              placeholder="Options, comma-separated"
              disabled={!canEdit}
              value={(f.options ?? []).join(", ")}
              onChange={(e) =>
                update(i, {
                  options: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              className="input w-full text-sm"
            />
          )}
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-1.5 text-xs text-slate-500">
              <input
                type="checkbox"
                disabled={!canEdit}
                checked={f.required}
                onChange={(e) => update(i, { required: e.target.checked })}
              />
              Required
            </label>
            {canEdit && (
              <button
                type="button"
                onClick={() => onChange(fields.filter((_, j) => j !== i))}
                className="text-xs text-red-500 hover:underline"
              >
                Remove
              </button>
            )}
          </div>
        </div>
      ))}
      <p className="text-[11px] text-slate-400">Save settings to apply form changes.</p>
    </section>
  );
}
