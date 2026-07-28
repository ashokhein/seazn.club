"use client";

import { useState } from "react";
import { Building2, Minus, Plus } from "lucide-react";
import { postJson } from "@/lib/api-post";
import { extraOrgsErrorKey } from "@/lib/extra-orgs-copy";
import { formatMinor, type Currency } from "@/lib/currency";
// Client-safe i18n: `@/lib/i18n` pulls in `server-only`, which breaks the build
// for a "use client" island. Same convention as buy-credits.tsx / pass-upgrade.
import { t } from "@/lib/i18n-runtime";
import type { Dict, Locale } from "@/lib/i18n-constants";

/**
 * The Extra organisations control (v17 gap #293, SPEC-6 §A5).
 *
 * Rides the group's EXISTING subscription (`POST /api/billing/extra-orgs`,
 * Task 3) rather than opening a checkout: the payer already has a payment
 * method on file, so this is a quantity change on a live bill, not a purchase
 * flow. `count` is the TOTAL the group should hold, never a delta.
 *
 * THREE THINGS HERE ARE LOAD-BEARING, and each one is a bug that has already
 * been made once in this feature:
 *
 *  1. `min` is the server's floor (`extraOrgsInUse`), computed WITHOUT the
 *     entitlement resolver. It makes the route's 423 a backstop instead of the
 *     first thing a customer meets. It is never derived from a cap on screen.
 *  2. Failures are chosen by STATUS, never rendered from the response body. The
 *     route's `error` is hardcoded English written for logs, and three of its
 *     refusals have three different remedies (`extraOrgsErrorKey`).
 *  3. `priceMinor` is the rider SKU's MONTHLY rate for the group's CURRENT
 *     plan. Not the plan's per-organisation tier (which is annual on an annual
 *     plan) and not what the customer last paid (a tier change re-prices the
 *     rider). The copy says "per month" for the same reason.
 *
 * Rendered only for the payer of a group with a live paid subscription — the
 * page decides that; this component does not re-litigate it. It IS rendered for
 * a group in dunning, deliberately: cancelling a rider they can no longer
 * afford is exactly what such a customer is here to do.
 */
export function ExtraOrgsControl({
  initialCount,
  min,
  max,
  priceMinor,
  currency,
  dict,
  locale,
}: {
  initialCount: number;
  /** Lowest total this group may reduce to — organisations already standing on
   *  a rider. 0 for a group with room to spare. */
  min: number;
  /** `MAX_EXTRA_ORGS`, passed down rather than restated: the usecase that owns
   *  it is `server-only` and cannot be imported here, and two copies of an edge
   *  drift. */
  max: number;
  priceMinor: number;
  currency: Currency;
  dict: Dict;
  locale: Locale;
}) {
  // The BASELINE is state, not the prop, because the org_addons row this page
  // reads is written by the WEBHOOK, not by the route we just called. A
  // router.refresh() after a successful save would re-read the OLD count and
  // flip the form back to "unsaved changes" for a change that succeeded. So the
  // saved value is remembered locally and the copy says the page may lag.
  const [baseline, setBaseline] = useState(initialCount);
  const [draft, setDraft] = useState(String(initialCount));
  const [busy, setBusy] = useState(false);
  const [failedStatus, setFailedStatus] = useState<number | null | undefined>(undefined);
  const [saved, setSaved] = useState(false);

  const parsed = Number.parseInt(draft, 10);
  const inRange = Number.isInteger(parsed) && parsed >= min && parsed <= max;
  // Falls back to the baseline so the price preview never reads NaN while the
  // field is mid-edit or empty.
  const count = inRange ? parsed : baseline;
  const dirty = inRange && parsed !== baseline;

  function step(by: number) {
    setSaved(false);
    setFailedStatus(undefined);
    setDraft(String(Math.min(max, Math.max(min, count + by))));
  }

  async function save() {
    if (!dirty || busy) return;
    setBusy(true);
    setFailedStatus(undefined);
    setSaved(false);
    const result = await postJson("/api/billing/extra-orgs", { count: parsed });
    setBusy(false);
    if (result.ok) {
      setBaseline(parsed);
      setSaved(true);
    } else {
      setFailedStatus(result.status);
    }
  }

  function reset() {
    setDraft(String(baseline));
    setFailedStatus(undefined);
    setSaved(false);
  }

  const price = formatMinor(priceMinor, currency, locale);
  const newTotal = formatMinor(priceMinor * count, currency, locale);

  return (
    <div className="card p-4 sm:p-5">
      <div className="flex flex-wrap items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-purple-50 text-purple-600">
          <Building2 className="h-4 w-4" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-800">
            {t(dict, "addOns.extraOrg.label")}
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-slate-600">
            {t(dict, "addOns.extraOrg.help")}
          </p>
        </div>
      </div>

      {/* Stepper + price. `flex-wrap` with a full-width price on the narrowest
          screens is what keeps this off a horizontal scrollbar at 375px. */}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-purple-100 pt-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => step(-1)}
            disabled={busy || count <= min}
            aria-label={t(dict, "addOns.extraOrg.decrease")}
            className="btn btn-ghost h-9 w-9 p-0"
          >
            <Minus className="h-4 w-4" strokeWidth={2} />
          </button>
          <input
            type="number"
            inputMode="numeric"
            value={draft}
            min={min}
            max={max}
            step={1}
            disabled={busy}
            onChange={(e) => {
              setSaved(false);
              setFailedStatus(undefined);
              setDraft(e.target.value);
            }}
            aria-label={t(dict, "addOns.extraOrg.label")}
            aria-invalid={draft !== "" && !inRange}
            className="input w-16 text-center font-semibold tabular-nums"
            data-extra-org-count
          />
          <button
            type="button"
            onClick={() => step(1)}
            disabled={busy || count >= max}
            aria-label={t(dict, "addOns.extraOrg.increase")}
            className="btn btn-ghost h-9 w-9 p-0"
          >
            <Plus className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>

        <p className="text-sm text-slate-600">
          {t(dict, "addOns.extraOrg.priceEach", { price })}
        </p>

        {dirty && (
          <div className="flex items-center gap-2 sm:ml-auto">
            <button type="button" onClick={reset} disabled={busy} className="btn btn-ghost text-sm">
              {t(dict, "addOns.extraOrg.cancel")}
            </button>
            <button type="button" onClick={save} disabled={busy} className="btn btn-primary text-sm">
              {busy ? t(dict, "addOns.extraOrg.saving") : t(dict, "addOns.extraOrg.save")}
            </button>
          </div>
        )}
      </div>

      {/* What the customer is about to agree to, in the order they need it:
          the new charge, then WHEN it lands. The two proration rules are the
          route's own (raising prorates; lowering never refunds mid-cycle), so
          neither sentence is a promise this page invents. */}
      {dirty && (
        <div className="mt-3 rounded-xl bg-purple-50/70 p-3 text-sm text-purple-900">
          <p className="font-medium">{t(dict, "addOns.extraOrg.newTotal", { total: newTotal })}</p>
          <p className="mt-0.5 text-purple-800">
            {t(
              dict,
              parsed > baseline ? "addOns.extraOrg.prorateUp" : "addOns.extraOrg.prorateDown",
            )}
          </p>
        </div>
      )}

      {min > 0 && (
        <p className="mt-3 text-sm text-slate-500">
          {t(dict, "addOns.extraOrg.floorNote", { min })}
        </p>
      )}

      {draft !== "" && !inRange && (
        <p className="mt-3 text-sm text-red-600" role="alert">
          {t(dict, "addOns.extraOrg.outOfRange", { min, max })}
        </p>
      )}

      {/* `undefined` = nothing has been attempted; `null` = a rejected fetch,
          which is NOT a 500 and must not borrow a server diagnosis. */}
      {failedStatus !== undefined && (
        <p className="mt-3 text-sm text-red-600" role="alert" data-extra-org-error>
          {t(dict, extraOrgsErrorKey(failedStatus), { max })}
        </p>
      )}

      {saved && (
        <p className="mt-3 text-sm text-emerald-700" role="status" data-extra-org-saved>
          {t(dict, "addOns.extraOrg.saved")}
        </p>
      )}
    </div>
  );
}
