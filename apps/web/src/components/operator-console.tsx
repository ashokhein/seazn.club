"use client";

// Operator console / multi-org command center (SPEC-6 §B1/B2, SPEC-5 §1).
//
// A Pro Plus operator (federation/academy/county) funds ONE shared credit
// wallet for a group of member orgs. This is their command center: the pool
// balance + a top-up, and a per-member table of the monthly credit cap and the
// burn against it, with an inline editor to raise/lower/clear a member's cap.
//
// Payer-only: it is mounted from the billing page behind the same payer gate as
// BillingGroupPanel, and every mutation re-checks payer ownership server-side
// (`PUT /api/billing/group/allocation` → setOrgAllocation → subscriptionIsOwnedBy).
// Nothing here is a permission gate; it is UI over an already-gated API.
//
// Client-safe i18n: `@/lib/i18n` pulls in `server-only`, so this "use client"
// island imports the pure runtime + types the same way the other islands do.
import { useState } from "react";
import { Building2, Plus } from "lucide-react";
import { Modal } from "@/components/modal";
import { BuyCredits } from "@/components/buy-credits";
import type { Currency, CreditPackOption } from "@/lib/currency";
import { t, plural } from "@/lib/i18n-runtime";
import type { Dict, Locale } from "@/lib/i18n-constants";

interface Member {
  orgId: string;
  orgName: string;
  /** null = unlimited share of the shared pool. */
  monthlyCap: number | null;
  spentThisPeriod: number;
}

export function OperatorConsole({
  poolBalance,
  members: initialMembers,
  resetsInDays,
  addOrgHref,
  packs,
  currency,
  dict,
  locale,
}: {
  poolBalance: number;
  members: Member[];
  /** Days until the monthly caps + grant reset (same calendar-month boundary). */
  resetsInDays: number;
  /** The billing-group panel (attach/detach) — where an org joins the bill. */
  addOrgHref: string;
  packs: CreditPackOption[];
  currency: Currency;
  dict: Dict;
  locale: Locale;
}) {
  const [members, setMembers] = useState<Member[]>(initialMembers);
  const [editing, setEditing] = useState<Member | null>(null);

  return (
    <section data-operator-console className="card mb-6 p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-purple-600">
            {t(dict, "billing.operator.title")}
          </h2>
          <p className="mt-0.5 text-sm text-slate-500">
            {plural(dict, "billing.operator.orgCount", members.length, locale)}
            {" · "}
            {t(dict, "billing.operator.pool")}{" "}
            <span className="font-semibold text-slate-700 tabular-nums">
              {plural(dict, "billing.credits.creditsCount", poolBalance, locale)}
            </span>
          </p>
        </div>
        <BuyCredits
          packs={packs}
          currency={currency}
          dict={dict}
          locale={locale}
          triggerLabel={t(dict, "billing.operator.topUp")}
        />
      </div>

      {/* Members table lives in a scroll-x container so the page never
          h-scrolls at 375px; the four columns keep a sensible min width. */}
      <div className="scroll-x scroll-x-fade -mx-1 px-1">
        <table className="w-full min-w-[32rem] text-left text-sm">
          <thead>
            <tr className="border-b border-purple-100 text-xs uppercase tracking-wide text-slate-400">
              <th className="py-2 pr-3 font-medium">{t(dict, "billing.operator.col.org")}</th>
              <th className="py-2 pr-3 font-medium">{t(dict, "billing.operator.col.cap")}</th>
              <th className="py-2 font-medium">{t(dict, "billing.operator.col.used")}</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const unlimited = m.monthlyCap === null;
              const pct =
                m.monthlyCap === null || m.monthlyCap === 0
                  ? null
                  : Math.min((m.spentThisPeriod / m.monthlyCap) * 100, 100);
              return (
                <tr key={m.orgId} className="border-b border-purple-50 last:border-0">
                  <td className="py-3 pr-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <Building2 className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                      <span className="truncate text-slate-800">{m.orgName}</span>
                    </span>
                  </td>
                  <td className="whitespace-nowrap py-3 pr-3">
                    <button
                      type="button"
                      onClick={() => setEditing(m)}
                      className="inline-flex items-center gap-1 rounded-lg px-2 py-1 font-medium text-purple-700 transition hover:bg-purple-50 focus-visible:ring-2 focus-visible:ring-purple-300"
                    >
                      <span className="tabular-nums">
                        {unlimited ? t(dict, "billing.operator.unlimited") : m.monthlyCap}
                      </span>
                      <span className="text-xs text-purple-400">{t(dict, "billing.operator.edit")}</span>
                    </button>
                  </td>
                  <td className="py-3">
                    <div className="flex items-center gap-2 tabular-nums text-slate-700">
                      <span className="font-medium">{m.spentThisPeriod}</span>
                      <span className="text-xs text-slate-400">
                        {unlimited
                          ? t(dict, "billing.operator.ofPool")
                          : t(dict, "billing.operator.ofCap", { cap: m.monthlyCap ?? 0 })}
                      </span>
                    </div>
                    {pct !== null && (
                      <div className="mt-1 h-1.5 w-full max-w-[10rem] rounded-full bg-slate-100">
                        <div
                          className={`h-1.5 rounded-full ${pct >= 90 ? "bg-amber-500" : "bg-purple-400"}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <a href={addOrgHref} className="btn btn-secondary text-sm">
          <Plus className="mr-1 h-4 w-4" aria-hidden />
          {t(dict, "billing.operator.addOrg")}
        </a>
        <span className="text-xs text-slate-400">{t(dict, "billing.operator.sharedNote")}</span>
      </div>

      {editing && (
        <AllocationEditor
          key={editing.orgId}
          member={editing}
          resetsInDays={resetsInDays}
          dict={dict}
          locale={locale}
          onClose={() => setEditing(null)}
          onSaved={(cap) => {
            setMembers((prev) =>
              prev.map((m) => (m.orgId === editing.orgId ? { ...m, monthlyCap: cap } : m)),
            );
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}

/**
 * Per-org allocation editor (SPEC-6 §B2). A radio between an unlimited share and
 * a hard monthly cap (non-negative whole number), with the member's burn this
 * period for context. Save PUTs `{ org_id, monthly_cap }` and is disabled until
 * the value actually changes.
 */
function AllocationEditor({
  member,
  resetsInDays,
  dict,
  locale,
  onClose,
  onSaved,
}: {
  member: Member;
  resetsInDays: number;
  dict: Dict;
  locale: Locale;
  onClose: () => void;
  onSaved: (cap: number | null) => void;
}) {
  const [unlimited, setUnlimited] = useState(member.monthlyCap === null);
  const [capText, setCapText] = useState(
    member.monthlyCap === null ? "" : String(member.monthlyCap),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = capText.trim() === "" ? NaN : Number(capText);
  const validNumber = Number.isInteger(parsed) && parsed >= 0;
  const invalid = !unlimited && !validNumber;
  // Only meaningful when not `invalid`; guarded by `changed` below.
  const nextCap: number | null = unlimited ? null : parsed;
  const changed = !invalid && nextCap !== member.monthlyCap;

  async function save() {
    if (invalid || !changed) return;
    setSaving(true);
    setError(null);
    const res = await fetch("/api/billing/group/allocation", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org_id: member.orgId, monthly_cap: unlimited ? null : parsed }),
    });
    setSaving(false);
    if (res.ok) {
      onSaved(unlimited ? null : parsed);
      return;
    }
    setError(t(dict, "billing.operator.editor.error"));
  }

  return (
    <Modal
      title={t(dict, "billing.operator.editor.title", { org: member.orgName })}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="btn btn-ghost">
            {t(dict, "confirm.cancel")}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || invalid || !changed}
            className="btn btn-primary disabled:opacity-40"
          >
            {saving ? t(dict, "billing.operator.editor.saving") : t(dict, "billing.operator.editor.save")}
          </button>
        </>
      }
    >
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium text-slate-700">
          {t(dict, "billing.operator.editor.capLabel")}
        </legend>
        <label
          className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition ${
            unlimited ? "border-purple-500 bg-purple-50" : "border-slate-200 hover:border-purple-300"
          }`}
        >
          <input
            type="radio"
            name="cap-mode"
            checked={unlimited}
            onChange={() => setUnlimited(true)}
            className="h-4 w-4 accent-purple-600"
          />
          <span className="text-sm text-slate-700">{t(dict, "billing.operator.editor.unlimited")}</span>
        </label>
        <label
          className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition focus-within:ring-2 focus-within:ring-purple-500 ${
            !unlimited ? "border-purple-500 bg-purple-50" : "border-slate-200 hover:border-purple-300"
          }`}
        >
          <input
            type="radio"
            name="cap-mode"
            checked={!unlimited}
            onChange={() => setUnlimited(false)}
            className="h-4 w-4 accent-purple-600"
          />
          <span className="text-sm text-slate-700">{t(dict, "billing.operator.editor.limited")}</span>
          <input
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={capText}
            onFocus={() => setUnlimited(false)}
            onChange={(e) => {
              setUnlimited(false);
              setCapText(e.target.value);
            }}
            className="input w-24"
            aria-label={t(dict, "billing.operator.editor.capLabel")}
          />
        </label>
      </fieldset>

      {invalid && (
        <p className="mt-2 text-xs text-amber-600">{t(dict, "billing.operator.editor.invalid")}</p>
      )}

      <p className="mt-3 text-xs text-slate-500">
        {t(dict, "billing.operator.editor.usedThisPeriod", { used: member.spentThisPeriod })}
        {" · "}
        {plural(dict, "billing.credits.resets", resetsInDays, locale)}
      </p>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </Modal>
  );
}
