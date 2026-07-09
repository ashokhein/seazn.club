"use client";

// Organiser registration console (doc 16 §1.1, PROMPT-20a item 4):
// settings (window, fee, capacity, bounded form-field builder), the
// registration list with approve / waitlist / withdraw / refund, CSV export,
// and the Stripe Connect onboarding banner that gates entry fees.
import { useCallback, useEffect, useRef, useState } from "react";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { PlanBadge } from "@/components/plan-badge";

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
  charges_enabled: boolean;
}

interface Registration {
  id: string;
  status: string;
  display_name: string;
  contact_email: string;
  dob: string | null;
  guardian_name: string | null;
  answers: Record<string, unknown>;
  amount_cents: number;
  currency: string | null;
  payment_intent_id: string | null;
  refunded_cents: number;
  entrant_id: string | null;
  created_at: string;
}

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700",
  paid: "bg-emerald-100 text-emerald-700",
  confirmed: "bg-emerald-100 text-emerald-700",
  waitlisted: "bg-sky-100 text-sky-700",
  withdrawn: "bg-slate-100 text-slate-500",
};

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
  const [settings, setSettings] = useState<Settings | null>(null);
  const [regs, setRegs] = useState<Registration[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
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
        },
      });
      setSaved(true);
    });
  }

  function action(id: string, verb: "confirm" | "waitlist" | "withdraw" | "refund") {
    if (verb === "withdraw" && !window.confirm("Withdraw this registration?")) return;
    if (verb === "refund" && !window.confirm("Refund the remaining amount?")) return;
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
            <div className="rounded-md border border-purple-200 bg-purple-50 p-3 text-xs text-purple-800">
              <p className="font-medium">Entry fees are collected offline</p>
              <p className="mt-1">
                Registrations are accepted immediately and marked pending. Registrants see
                your cash / bank-transfer instructions on their confirmation page and email —
                set these once under{" "}
                <a href="/settings" className="underline">Settings → Payment details</a>.
              </p>
            </div>
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
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">
            Registrations <span className="text-slate-400">({regs.length})</span>
          </h2>
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
        ) : (
          <ul className="space-y-2">
            {regs.map((r) => {
              const refundable =
                r.payment_intent_id !== null && r.refunded_cents < r.amount_cents;
              return (
                <li key={r.id} className="card flex flex-wrap items-center gap-3 p-3 text-sm">
                  <span className={`badge ${STATUS_STYLE[r.status] ?? ""}`}>{r.status}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-slate-800">
                      {r.display_name}
                      {r.entrant_id && (
                        <span className="ml-2 text-xs font-normal text-emerald-600">entrant ✓</span>
                      )}
                    </span>
                    <span className="block truncate text-xs text-slate-400">
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
                      {(r.status === "pending" || r.status === "waitlisted") && (
                        <button type="button" disabled={busy} onClick={() => action(r.id, "confirm")} className="btn btn-ghost text-xs">
                          Approve
                        </button>
                      )}
                      {r.status === "pending" && (
                        <button type="button" disabled={busy} onClick={() => action(r.id, "waitlist")} className="btn btn-ghost text-xs">
                          Waitlist
                        </button>
                      )}
                      {r.status === "pending" && r.amount_cents > 0 && (
                        <button type="button" disabled={busy} onClick={() => remind(r.id)} className="btn btn-ghost text-xs" title="Email the registrant a payment reminder">
                          Send reminder
                        </button>
                      )}
                      {r.status !== "withdrawn" && (
                        <button type="button" disabled={busy} onClick={() => action(r.id, "withdraw")} className="btn btn-ghost text-xs text-red-600">
                          Withdraw
                        </button>
                      )}
                      {refundable && (
                        <button type="button" disabled={busy} onClick={() => action(r.id, "refund")} className="btn btn-ghost text-xs">
                          Refund
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
