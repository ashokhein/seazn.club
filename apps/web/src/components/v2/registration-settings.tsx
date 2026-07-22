"use client";

// Organiser registration settings (PROMPT-52): the old single-column form
// regrouped into four staged-disclosure groups ordered by "what matters
// when" — Open & close → Capacity → Money → Sign-up form. Presentation only;
// every field writes the same PUT payload as before. Connect state stays a
// LINK to Settings → Connect (never duplicated here).
import { useState } from "react";
import { PlanBadge } from "@/components/plan-badge";
import { Tip } from "@/components/ui/tip";
import type { Pulse } from "@/lib/registration-derive";
import type { FormField, Settings } from "./registrations-panel";
import { useMsg } from "@/components/i18n/dict-provider";

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
export function currencySymbol(code: string): string {
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
  const msg = useMsg();
  const set = onPatch;
  const paidConfigured = settings.fee_cents > 0;
  const taken = pulse ? pulse.confirmed + pulse.holding : null;

  return (
    <div className="space-y-3">
      <Group
        title={msg("reg.settings.openClose")}
        defaultOpen
        summary={settings.enabled ? msg("reg.settings.open") : msg("reg.settings.closed")}
      >
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            disabled={!canEdit}
            checked={settings.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          {msg("reg.settings.openForPublic")}
        </label>

        <label className="block text-xs text-slate-500">
          {msg("reg.settings.entrantType")}
          <select
            disabled={!canEdit}
            value={settings.entrant_kind}
            onChange={(e) => set({ entrant_kind: e.target.value as Settings["entrant_kind"] })}
            className="input mt-1 w-full"
          >
            <option value="individual">{msg("reg.settings.entrant.individual")}</option>
            <option value="team">{msg("reg.settings.entrant.team")}</option>
            <option value="pair">{msg("reg.settings.entrant.pair")}</option>
          </select>
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs text-slate-500">
            {msg("reg.settings.opens")}
            <input
              type="datetime-local"
              disabled={!canEdit}
              value={toLocalInput(settings.opens_at)}
              onChange={(e) => set({ opens_at: fromLocalInput(e.target.value) })}
              className="input mt-1 w-full"
            />
          </label>
          <label className="block text-xs text-slate-500">
            {msg("reg.settings.closes")}
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
        title={msg("reg.settings.capacity")}
        summary={
          settings.capacity === null
            ? msg("reg.settings.uncapped")
            : msg("reg.settings.spots", { n: settings.capacity })
        }
      >
        <label className="block text-xs text-slate-500">
          {msg("reg.settings.capacityHint")}
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
            {settings.capacity !== null
              ? msg("reg.settings.meterOf", { taken, cap: settings.capacity, waiting: pulse.waitlisted })
              : msg("reg.settings.meter", { taken, waiting: pulse.waitlisted })}
          </p>
        )}
      </Group>

      <Group
        title={msg("reg.settings.money")}
        summary={
          paidConfigured
            ? `${currencySymbol(settings.currency)}${(settings.fee_cents / 100).toFixed(2)} · ${settings.payment_method === "stripe" ? msg("reg.settings.methodCard") : msg("reg.settings.methodOrganiser")}`
            : msg("reg.settings.free")
        }
      >
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs text-slate-500">
            <span className="flex items-center gap-1.5">
              {msg("reg.settings.entryFee", { sym: currencySymbol(settings.currency) })}
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
            {msg("reg.settings.currency")}
            <input
              maxLength={3}
              disabled={!canEdit}
              value={settings.currency}
              onChange={(e) => set({ currency: e.target.value.toLowerCase() })}
              className="input mt-1 w-full"
            />
          </label>
        </div>
        {/* The 8/5/2/1 platform-fee ladder is the commercial fact an organiser
            meets the moment they price an entry — it lives in the tip, not
            inline, so all four locales stay in one registry. */}
        {paidConfigured && (
          <p className="flex items-start gap-1 text-[11px] text-slate-400">
            {msg("reg.settings.feeNote")}
            <Tip id="registration.platform-fee" small className="mt-px shrink-0" />
          </p>
        )}

        {paidConfigured && (
          <fieldset className="space-y-2">
            <legend className="text-xs text-slate-500">{msg("reg.settings.howCollected")}</legend>
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
                <span className="block font-medium text-slate-800">{msg("reg.settings.payOrganiser")}</span>
                <span className="mt-0.5 block text-slate-500">{msg("reg.settings.payOrganiserDesc")}</span>
              </span>
            </label>
            {settings.payment_method === "offline" && (
              <label className="block text-xs text-slate-500">
                {msg("reg.settings.payInstructions")}
                <textarea
                  disabled={!canEdit}
                  value={settings.payment_instructions ?? ""}
                  onChange={(e) => set({ payment_instructions: e.target.value || null })}
                  rows={3}
                  maxLength={5000}
                  placeholder={
                    settings.org_payment_instructions
                      ? msg("reg.settings.payInstructionsPlaceholderOrg")
                      : msg("reg.settings.payInstructionsPlaceholder")
                  }
                  className="input mt-1 w-full font-mono text-xs"
                />
                <span className="mt-1 block text-[11px] text-slate-400">
                  {msg("reg.settings.markdownNote", { reference: "{{reference}}" })}
                </span>
                {!settings.payment_instructions && settings.org_payment_instructions && (
                  <span className="mt-1 block text-[11px] text-slate-400">{msg("reg.settings.usingOrgInstructions")}</span>
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
                  {msg("reg.settings.cardPayment")}
                  {!paidAllowed && <PlanBadge feature="registration.paid" />}
                </span>
                <span className="mt-0.5 block text-slate-500">{msg("reg.settings.cardPaymentDesc")}</span>
                {!settings.charges_enabled && (
                  <a href="/settings/connect" className="mt-1 block font-medium text-purple-700 underline">
                    {msg("reg.settings.connectStripeFirst")}
                  </a>
                )}
              </span>
            </label>
          </fieldset>
        )}

        {paidConfigured && (
          <label className="block text-xs text-slate-500">
            {msg("reg.settings.refundLock")}
            <input
              type="datetime-local"
              disabled={!canEdit}
              value={toLocalInput(settings.refund_lock_at)}
              onChange={(e) => set({ refund_lock_at: fromLocalInput(e.target.value) })}
              className="input mt-1 w-full"
            />
            <span className="mt-1 block text-[11px] text-slate-400">
              {settings.refund_lock_at
                ? msg("reg.settings.refundLockSet")
                : msg("reg.settings.refundLockNone")}
            </span>
          </label>
        )}
      </Group>

      <Group title={msg("reg.settings.signupForm")} summary={msg("reg.settings.extraQuestions", { n: settings.form_fields.length })}>
        <FormBuilder
          fields={settings.form_fields}
          canEdit={canEdit}
          onChange={(form_fields) => set({ form_fields })}
        />
      </Group>

      {canEdit && (
        <button type="button" disabled={busy} onClick={onSave} className="btn btn-primary w-full">
          {busy ? "…" : msg("reg.settings.save")}
        </button>
      )}
      {saved && <p className="text-xs text-emerald-600">{msg("reg.settings.saved")}</p>}
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
  const msg = useMsg();
  function update(i: number, patch: Partial<FormField>) {
    onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  }

  function add() {
    // A blank label fails validation and blocks the whole save, so seed a
    // valid default the organiser can rename.
    const n = fields.length + 1;
    onChange([...fields, { key: `question_${n}`, label: msg("reg.form.questionN", { n }), kind: "text", required: false }]);
  }

  // Lives inside a ~340px accordion column: every control gets the full row
  // (a shared row collapsed the label input to nothing), and the add button
  // sits full-width under the list where it can't crowd the intro copy.
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-400">{msg("reg.form.intro")}</p>
      {fields.length === 0 && (
        <p className="text-xs text-slate-400">{msg("reg.form.examples")}</p>
      )}
      {fields.map((f, i) => (
        <div key={i} className="space-y-2 rounded-md border border-slate-200 p-3">
          <label className="block text-xs text-slate-500">
            {msg("reg.form.label")}
            <input
              placeholder={msg("reg.form.labelPlaceholder")}
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
              className="input mt-1 w-full text-sm"
            />
          </label>
          {f.kind === "select" && (
            <input
              placeholder={msg("reg.form.options")}
              aria-label={msg("reg.form.optionsAria")}
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
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label={msg("reg.form.type")}
              disabled={!canEdit}
              value={f.kind}
              onChange={(e) =>
                update(i, {
                  kind: e.target.value as FormField["kind"],
                  options: e.target.value === "select" ? (f.options ?? [""]) : undefined,
                })
              }
              className="input min-w-0 flex-1 text-sm"
            >
              <option value="text">{msg("reg.form.type.text")}</option>
              <option value="select">{msg("reg.form.type.select")}</option>
              <option value="checkbox">{msg("reg.form.type.checkbox")}</option>
            </select>
            <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-slate-500">
              <input
                type="checkbox"
                disabled={!canEdit}
                checked={f.required}
                onChange={(e) => update(i, { required: e.target.checked })}
              />
              {msg("reg.form.required")}
            </label>
            {canEdit && (
              <button
                type="button"
                onClick={() => onChange(fields.filter((_, j) => j !== i))}
                className="ml-auto text-xs text-red-500 hover:underline"
              >
                {msg("reg.form.remove")}
              </button>
            )}
          </div>
        </div>
      ))}
      {canEdit && fields.length < 12 && (
        <button type="button" onClick={add} className="btn btn-ghost w-full text-xs">
          {msg("reg.form.add")}
        </button>
      )}
      <p className="text-[11px] text-slate-400">{msg("reg.form.saveNote")}</p>
    </div>
  );
}
