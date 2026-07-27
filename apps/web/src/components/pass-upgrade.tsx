"use client";

import { useState } from "react";
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from "@stripe/react-stripe-js";
import { track, EVENTS } from "@/lib/analytics";
import { fetchPassCheckoutClientSecret } from "@/lib/billing-checkout-client";
import type { CheckoutSecretResult } from "@/lib/billing-checkout-client";
import { stripePromise } from "@/lib/stripe-browser";
import { Modal } from "@/components/modal";
import { formatMinor, type Currency, type PassKey } from "@/lib/currency";
// Client-safe i18n: `@/lib/i18n` pulls in `server-only`, which breaks the build
// for a "use client" island. Same convention as buy-credits.tsx.
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import {
  PASS_RUNG_NAME_KEY,
  PASS_RUNG_SIZE_KEY,
  passCheckoutErrorKey,
  type PassRungOption,
} from "@/lib/pass-ladder";

/**
 * The Event Pass checkout sheet (spec D11) — the same chrome the Pro checkout
 * uses on the billing page (billing-actions.tsx): `<Modal size="lg">`, so the
 * two purchases differ only in what is being sold.
 *
 * Deliberately NOT titled "Complete your upgrade" like Pro's. Pro's title
 * describes a plan change; this is one payment for one competition and leaves
 * the org on community. D12/D13 exist precisely because buyers conflate the
 * pass with a subscription, so the chrome must not add to that. Parity here is
 * of presentation, not of wording.
 *
 * Split out from the picker because it holds no state of its own: the picker
 * owns the client_secret, this owns how it is shown.
 */
export function PassCheckoutSheet({
  clientSecret,
  onClose,
}: {
  clientSecret: string;
  onClose: () => void;
}) {
  return (
    <Modal title="Complete your purchase" size="lg" onClose={onClose}>
      {/* Stripe's iframe measures and resizes itself, so this container must not
          impose a height — Modal already caps the sheet at 85vh and scrolls. The
          provider is mounted only once we hold a secret; remounting it would
          restart the checkout session. */}
      <EmbeddedCheckoutProvider stripe={stripePromise} options={{ clientSecret }}>
        <EmbeddedCheckout />
      </EmbeddedCheckoutProvider>
    </Modal>
  );
}

/** The seam the chosen rung crosses on its way to Stripe. Injectable so it can
 *  be asserted without a DOM. */
export interface PassCheckoutDeps {
  fetchSecret: typeof fetchPassCheckoutClientSecret;
  trackEvent: typeof track;
}

const LIVE_DEPS: PassCheckoutDeps = {
  fetchSecret: fetchPassCheckoutClientSecret,
  trackEvent: track,
};

/**
 * Turn a chosen rung into a checkout session.
 *
 * Extracted from the component for one reason: this is the only place the
 * buyer's SELECTION becomes money, and it is the one line where selling L at
 * M's price would be a single-token mistake. A `useState` component cannot be
 * driven outside React's render loop in this workspace (node vitest env, no
 * jsdom), so the money seam is pulled out to where it can be asserted.
 *
 * `plan_key` rides along for the same reason: analytics that always reported
 * `event_pass` would make the L rung look like it never sold.
 */
export async function beginPassCheckout(
  competitionId: string,
  passKey: PassKey,
  deps: PassCheckoutDeps = LIVE_DEPS,
): Promise<CheckoutSecretResult> {
  deps.trackEvent(EVENTS.CHECKOUT_STARTED, { plan_key: passKey });
  return deps.fetchSecret(competitionId, passKey);
}

/** What the picker knows about a failed attempt. `null` = nothing has failed. */
export interface PassCheckoutFailure {
  /** HTTP status, or null when no response arrived at all. */
  status: number | null;
}

/**
 * The ladder, rendered — hookless, so every decision it makes can be asserted
 * by calling it directly (the established convention for islands in this
 * workspace: `__tests__/run-your-own-cta.test.tsx`).
 *
 * It owns "which rung the button means", which is why `onBuy` is HANDED the
 * selection instead of reading it from a closure: one value drives the checked
 * radio, the button's label and the purchase, so those three cannot drift.
 *
 * ── Why an inline ladder and not a modal ────────────────────────────────────
 * `apps/web/e2e/event-pass.spec.ts:325` and `:922` click `[data-pass-buy]` and
 * wait DIRECTLY for the Stripe iframe. A "choose, then pay" step between those
 * two moments would break the whole money-path suite, so the picker sits inside
 * the stub and the button still starts checkout on its first click — for
 * whichever rung is selected at that moment.
 */
export function PassRungLadder({
  options,
  currency,
  dict,
  selected,
  onSelect,
  onBuy,
  canBuy,
  loading,
  failure,
}: {
  /** Both rungs, smallest first — `passLadderOptions()`'s order. */
  options: PassRungOption[];
  currency: Currency;
  dict: Dict;
  selected: PassKey;
  onSelect: (key: PassKey) => void;
  onBuy: (key: PassKey) => void;
  /**
   * Owners buy; everyone else reads. The prices stay on screen either way — a
   * non-owner's job on this page is to take a number to whoever can spend it,
   * and with two rungs that means BOTH numbers.
   */
  canBuy: boolean;
  loading: boolean;
  failure: PassCheckoutFailure | null;
}) {
  return (
    <div className="text-left">
      <p className="app-eyebrow justify-center text-[0.6875rem]">{t(dict, "upgrade.oneTime")}</p>

      {/* `disabled` on the fieldset rather than on each input: it is one
          control, and for a non-owner the whole control is inert. */}
      <fieldset className="mt-3 space-y-2" disabled={!canBuy}>
        <legend className="sr-only">{t(dict, "upgrade.ladder.legend")}</legend>
        {options.map((option) => {
          // Checked in the DOM either way — a radio group must have one — but
          // only DRESSED as chosen when there is someone to choose. A reader who
          // cannot buy did not pick M, and a lime stamp in a control they cannot
          // operate claims they did; for them these two rows are a price list.
          const checked = option.key === selected;
          const active = checked && canBuy;
          return (
            <label
              key={option.key}
              data-pass-rung={option.key}
              data-pass-rung-active={active || undefined}
              // WHITE ring, not lime. Lime already means "this is the rung you
              // chose" on this row, and a lime focus ring on top of a lime
              // selection border is two signals wearing the same colour.
              //
              // `focus-within` rather than `has-focus-visible:`: the latter
              // compiles to a fully transparent ring in this build (verified in
              // the browser — `:has(:focus-visible)` matches but no box-shadow
              // lands), which would silently leave keyboard users with no focus
              // indicator at all on a purchase control. A ring that also shows
              // on click is the safe side of that trade.
              className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 transition focus-within:ring-2 focus-within:ring-white ${
                canBuy ? "cursor-pointer" : "cursor-default"
              } ${
                active
                  ? "border-lime-300/60 bg-white/[0.09]"
                  : `border-white/15 ${canBuy ? "hover:border-white/30" : ""}`
              }`}
            >
              {/* The visible control is the size stamp below; the input stays in
                  the accessibility tree and keeps native radio-group keyboard
                  behaviour (arrow keys move the selection). The label's ring is
                  what keeps focus visible while the input itself is not. */}
              <input
                type="radio"
                name="pass-rung"
                value={option.key}
                checked={checked}
                onChange={() => onSelect(option.key)}
                className="sr-only"
              />
              {/* A ticket's class stamp. Lime when chosen — the console's one
                  "this is on" colour, spent here on the buyer's own choice and
                  on nothing else. This ladder carries NO best-value badge
                  (#294, owner's decision), so the only emphasis on the stub
                  belongs to the reader. */}
              <span
                aria-hidden
                className={`app-display mt-0.5 grid h-5 w-6 shrink-0 place-items-center rounded-md text-[0.6875rem] font-bold ${
                  active ? "bg-lime-400 text-[#150b36]" : "bg-white/10 text-white/70"
                }`}
              >
                {t(dict, PASS_RUNG_SIZE_KEY[option.key])}
              </span>
              <span className="min-w-0 flex-1">
                {/* The radio's accessible name reads "Event Pass L, $59, …":
                    the stamp is decorative, so the full name has to be here. */}
                <span className="sr-only">{t(dict, PASS_RUNG_NAME_KEY[option.key])}</span>
                <span className="app-display block text-2xl font-bold leading-none text-white tabular-nums">
                  {formatMinor(option.amountMinor, currency)}
                </span>
                {/* The difference, led with — an L buyer is buying entrants and
                    divisions, not a letter. Read live from plan_entitlements by
                    the page and never written down (lib/pass-comparison.ts). */}
                <span className="mt-1.5 block text-[0.6875rem] leading-snug text-white/60">
                  <span className="block">
                    {option.divisions === null
                      ? t(dict, "upgrade.ladder.divisionsUnlimited")
                      : t(dict, "upgrade.ladder.divisionsCapped", { count: option.divisions })}
                  </span>
                  <span className="block">
                    {option.entrants === null
                      ? t(dict, "upgrade.ladder.entrantsUnlimited")
                      : t(dict, "upgrade.ladder.entrantsCapped", { count: option.entrants })}
                  </span>
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>

      {canBuy ? (
        <>
          <button
            type="button"
            onClick={() => onBuy(selected)}
            disabled={loading}
            className="btn btn-primary mt-3 w-full px-4 py-2.5"
            data-pass-buy
          >
            {loading
              ? t(dict, "upgrade.ladder.preparing")
              : t(dict, "upgrade.buyCta", { rung: t(dict, PASS_RUNG_SIZE_KEY[selected]) })}
          </button>
          {failure && (
            // Localised copy chosen from the STATUS. The route's own strings are
            // English-only in a four-locale product and, on an unexpected 500,
            // are a raw exception message — so they are never rendered here.
            // The button stays live underneath: all three states are retryable.
            <p
              role="alert"
              data-pass-buy-error
              className="mt-2 text-[0.6875rem] leading-snug text-red-200"
            >
              {t(dict, passCheckoutErrorKey(failure.status))}
            </p>
          )}
        </>
      ) : (
        <p className="mt-3 text-center text-xs text-white/70">{t(dict, "upgrade.ownerOnly")}</p>
      )}
    </div>
  );
}

/**
 * In-page Event Pass purchase (spec D11; rungs per v17 #294) — the M/L ladder
 * plus the embedded Stripe sheet it opens.
 *
 * M is pre-selected because `options` arrives smallest-first, so the default
 * sale is exactly what it was before the L rung existed. That is what lets the
 * money-path e2e suite keep driving this button without knowing a picker is
 * there.
 */
export function PassUpgradeButton({
  competitionId,
  options,
  currency,
  dict,
  canBuy,
}: {
  competitionId: string;
  options: PassRungOption[];
  currency: Currency;
  dict: Dict;
  canBuy: boolean;
}) {
  const [selected, setSelected] = useState<PassKey>(options[0]!.key);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<PassCheckoutFailure | null>(null);

  async function start(passKey: PassKey) {
    setFailure(null);
    setLoading(true);
    const result = await beginPassCheckout(competitionId, passKey);
    setLoading(false);
    if (result.ok) setClientSecret(result.clientSecret);
    else setFailure({ status: result.status });
  }

  if (clientSecret) {
    return <PassCheckoutSheet clientSecret={clientSecret} onClose={() => setClientSecret(null)} />;
  }

  return (
    <PassRungLadder
      options={options}
      currency={currency}
      dict={dict}
      selected={selected}
      onSelect={setSelected}
      onBuy={start}
      canBuy={canBuy}
      loading={loading}
      failure={failure}
    />
  );
}
