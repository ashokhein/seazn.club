"use client";

// Organiser registration settings (PROMPT-52): the old single-column form
// regrouped into four staged-disclosure groups ordered by "what matters
// when" — Open & close → Capacity → Money → Sign-up form. Presentation only;
// every field writes the same PUT payload as before. Connect state stays a
// LINK to Settings → Payments (never duplicated here).
import { useState } from "react";
import { PlanBadge } from "@/components/plan-badge";
import type { Pulse } from "@/lib/registration-derive";
import type { FormField, Settings } from "./registrations-panel";

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

function Group({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="card p-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-2 px-5 py-3 text-left"
      >
        <span className="text-sm font-semibold text-slate-700">{title}</span>
        <span className="flex items-center gap-2">
          {summary && !open && (
            <span className="max-w-40 truncate text-xs text-slate-400">{summary}</span>
          )}
          <span aria-hidden className="text-xs text-slate-400">{open ? "▾" : "▸"}</span>
        </span>
      </button>
      {open && <div className="space-y-3 px-5 pb-5">{children}</div>}
    </section>
  );
}

export function RegistrationSettings({
  settings,
  pulse,
  feeText,
  onFeeText,
  onPatch,
  onSave,
  canEdit,
  paidAllowed,
  busy,
  saved,
}: {
  settings: Settings;
  /** Derived counts for the inline capacity meter (null while rows load). */
  pulse: Pulse | null;
  feeText: string;
  onFeeText: (v: string) => void;
  onPatch: (patch: Partial<Settings>) => void;
  onSave: () => void;
  canEdit: boolean;
  paidAllowed: boolean;
  busy: boolean;
  saved: boolean;
}) {
  const set = onPatch;
  const paidConfigured = settings.fee_cents > 0;
  const taken = pulse ? pulse.confirmed + pulse.holding : null;

  return (
    <div className="space-y-3">
      <Group
        title="Open & close"
        defaultOpen
        summary={settings.enabled ? "Open" : "Closed"}
      >
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
      </Group>

      <Group
        title="Capacity"
        summary={
          settings.capacity === null
            ? "Uncapped"
            : `${settings.capacity} spots`
        }
      >
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
        {pulse && taken !== null && (
          <p className="text-xs text-slate-500" data-testid="capacity-meter">
            {taken} taken
            {settings.capacity !== null ? ` of ${settings.capacity}` : ""} · {pulse.waitlisted}{" "}
            waiting
          </p>
        )}
      </Group>

      <Group
        title="Money"
        summary={
          paidConfigured
            ? `${currencySymbol(settings.currency)}${(settings.fee_cents / 100).toFixed(2)} · ${settings.payment_method === "stripe" ? "card" : "pay organiser"}`
            : "Free"
        }
      >
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
                  onFeeText(t);
                  const pounds = parseFloat(t);
                  set({ fee_cents: Number.isFinite(pounds) ? Math.round(pounds * 100) : 0 });
                }}
                onBlur={() => {
                  // Normalise "1.5" → "1.50", "" → "0" on leaving the field.
                  onFeeText((settings.fee_cents / 100).toFixed(2));
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
          <p className="text-[11px] text-slate-400">
            Fee changes apply to new sign-ups; current entries keep their price.
          </p>
        )}

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
                  onChange={(e) => set({ payment_instructions: e.target.value || null })}
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
                  <a href="/settings/payments" className="mt-1 block font-medium text-purple-700 underline">
                    Connect Stripe in Settings → Payments first
                  </a>
                )}
              </span>
            </label>
          </fieldset>
        )}

        {paidConfigured && (
          <label className="block text-xs text-slate-500">
            Refund lock (withdrawals stop auto-refunding after this)
            <input
              type="datetime-local"
              disabled={!canEdit}
              value={toLocalInput(settings.refund_lock_at)}
              onChange={(e) => set({ refund_lock_at: fromLocalInput(e.target.value) })}
              className="input mt-1 w-full"
            />
          </label>
        )}
      </Group>

      <Group title="Sign-up form" summary={`${settings.form_fields.length} extra questions`}>
        <FormBuilder
          fields={settings.form_fields}
          canEdit={canEdit}
          onChange={(form_fields) => set({ form_fields })}
        />
      </Group>

      {canEdit && (
        <button type="button" disabled={busy} onClick={onSave} className="btn btn-primary w-full">
          {busy ? "…" : "Save settings"}
        </button>
      )}
      {saved && <p className="text-xs text-emerald-600">Saved.</p>}
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
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-400">
          Ask registrants anything beyond name, email and date of birth.
        </p>
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
    </div>
  );
}
