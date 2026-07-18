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
import { useMsg } from "@/components/i18n/dict-provider";
import { normalizeRefCode } from "@/lib/ref-code";
import {
  duplicateContactIds,
  registrationPulse,
  waitlistPositions,
} from "@/lib/registration-derive";
import { RegistrationSettings } from "./registration-settings";
import { RegistrationPulse, type Tab } from "./registration-pulse";
import { RegistrationList, type ActionVerb } from "./registration-list";

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
  const msg = useMsg();
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
  const positions = useMemo(() => waitlistPositions(regs), [regs]);
  const duplicates = useMemo(() => duplicateContactIds(regs), [regs]);
  // Status tab; until the organiser picks one, an empty division opens on
  // All (nothing to confirm yet) and a busy one on Confirmed.
  const [pickedTab, setPickedTab] = useState<Tab | null>(null);
  const tab: Tab = pickedTab ?? (regs.length === 0 ? "all" : "confirmed");

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
      setError(err instanceof Error ? err.message : msg("reg.failedLoad")),
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
        setError(err instanceof Error ? err.message : msg("reg.failed"));
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

  async function action(r: Registration, verb: ActionVerb) {
    const id = r.id;
    // SPOT vs MONEY copy (PROMPT-52): each confirm states exactly what
    // changes — the spot, the money, or both — under the current refund
    // lock. Semantics unchanged; endpoints are the same as ever.
    const lockPassed =
      settings?.refund_lock_at != null && new Date(settings.refund_lock_at).getTime() < Date.now();
    const paidCard = r.payment_intent_id !== null && r.refunded_cents < r.amount_cents;
    const withdrawMoneyLine = !paidCard
      ? ""
      : lockPassed
        ? ` ${msg("reg.withdraw.moneyLockPassed")}`
        : ` ${msg("reg.withdraw.moneyRefunds")}`;
    const dialogFor: Partial<Record<typeof verb, Parameters<typeof confirmDialog>[0]>> = {
      withdraw: {
        title: msg("confirm.withdrawRegistration.title"),
        body: `${msg("reg.withdraw.body")}${withdrawMoneyLine}`,
        confirmLabel: msg("confirm.withdrawRegistration.label"),
        tone: "danger",
      },
      refund: {
        title: msg("confirm.refundRegistration.title"),
        body:
          r.status === "confirmed" || r.status === "paid"
            ? msg("reg.refund.bodyConfirmed", { name: r.display_name })
            : msg("confirm.refundRegistration.body"),
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
      setNotice(res.sent ? msg("reg.remind.sent") : msg("reg.remind.notSent"));
    });
  }

  if (!settings) {
    return <p className="text-sm text-slate-400">{error ?? msg("reg.loading")}</p>;
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
            {msg("reg.stripeOffline.pre")}
            <a href="/settings/connect" className="underline">{msg("reg.stripeOffline.link")}</a>
            {msg("reg.stripeOffline.post")}
          </div>
        )}
        {regs.some((r) => r.disputed_at) && (
          <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
            {msg("reg.disputed", { n: regs.filter((r) => r.disputed_at).length })}
          </div>
        )}
        <RegistrationPulse
          pulse={pulse}
          currency={settings.currency}
          onJump={setPickedTab}
          onRefresh={refresh}
        />
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
            {msg("reg.heading")} <span className="text-slate-500">({regs.length})</span>
            <Tip id="registration.ref-number" />
          </h2>
          {/* Search by ref (v3/05 §3) — day-of check-in lookup. Names match
              too, so one box serves both. */}
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={msg("reg.searchPlaceholder")}
            aria-label={msg("reg.searchAria")}
            className="input w-48 px-2 py-1 text-xs"
            data-testid="reg-search"
          />
          <a
            href={`/api/v1/divisions/${divisionId}/registrations/export`}
            className="btn btn-ghost text-xs"
          >
            {msg("reg.exportCsv")}
          </a>
        </div>
        <RegistrationList
          regs={regs}
          shown={shownRegs}
          query={query}
          tab={tab}
          onTab={setPickedTab}
          positions={positions}
          duplicates={duplicates}
          canEdit={canEdit}
          busy={busy}
          onAction={action}
          onRemind={remind}
        />
      </section>
    </div>
  );
}
