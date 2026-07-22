"use client";

// A billing group someone wants to hand to YOU — surfaced to the RECIPIENT.
//
// The accept UI used to live inside BillingGroupPanel, which the billing page
// mounts only for a group's PAYER (`isPayer`). A non-payer recipient — which is
// the whole point of an offer — therefore never saw it, and there is no email
// yet, so the offer was invisible. This component is mounted UNCONDITIONALLY on
// the billing page so an incoming offer reaches whoever it was addressed to.
//
// Its data arrives in an effect and the vitest env here is `node` with no jsdom
// (see lib/billing-group-view.ts), so a render test would assert the null this
// returns before the fetch lands. The DECISION — which offers are "incoming"
// versus the caller's own outgoing ones — lives in the pure `incomingOnly` and
// is tested directly.
import { useEffect, useState } from "react";
import { useLocale, useMsg } from "@/components/i18n/dict-provider";
import { TransferOfferAccept } from "@/components/transfer-offer-accept";
import { asCurrency, formatMinor } from "@/lib/currency";
import { fmtDate, UTC } from "@/lib/format";
import { planLabel } from "@/lib/plan-label";

/** The recipient-facing cost of taking a group over — mirrors the server's
 *  TransferOfferSummary. `charge_now_minor` is always 0 (accepting bills
 *  nothing now); `renewal` is a best-effort Stripe quote, null for a group with
 *  no live subscription or when Stripe could not be reached. */
export interface IncomingSummary {
  plan_key: string;
  org_count: number;
  currency: string;
  renewal_date: number | null;
  charge_now_minor: 0;
  renewal: { amount_minor: number; interval: "monthly" | "annual" } | null;
}

/** The fields this surface reads off a transfer offer. `GET
 *  /api/billing/group/transfer` returns more (see listGroupTransferOffers);
 *  only these are modelled here. `client_secret` is populated only on offers
 *  made TO the caller — it is what the recipient confirms a card against, and
 *  `direction` is the server's canonical "is this mine" (never re-derived from
 *  to_user_id here). `summary` rides along only on incoming offers. */
export interface IncomingOffer {
  setup_intent_id: string;
  client_secret: string | null;
  direction: "made_by_me" | "made_to_me";
  summary?: IncomingSummary | null;
}

/** Offers addressed TO this user — the incoming ones. The same payload also
 *  carries the caller's OWN outgoing offers (kept in BillingGroupPanel), so
 *  they are filtered out here on the server's canonical `direction`: a payer who
 *  is also mid-offer must not read their own outgoing claim as a bill being
 *  handed to them. */
export function incomingOnly<T extends { direction: "made_by_me" | "made_to_me" }>(
  offers: T[],
): T[] {
  return offers.filter((o) => o.direction === "made_to_me");
}

export function IncomingTransferOffers({ currentUserId: _currentUserId }: { currentUserId: string }) {
  const msg = useMsg();
  const [incoming, setIncoming] = useState<IncomingOffer[]>([]);
  // The incoming offer whose card form is open (setup_intent_id), if any.
  const [acceptingId, setAcceptingId] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/billing/group/transfer");
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      data?: IncomingOffer[];
    };
    const offers = json.ok ? (json.data ?? []) : [];
    setIncoming(incomingOnly(offers));
  }

  useEffect(() => {
    void load();
  }, []);

  // Nothing to hand you: the recipient card only exists while a live offer does.
  if (incoming.length === 0) return null;

  return (
    // A bill someone wants to hand to YOU. The recipient enters a card (their
    // own) before it moves — the second phase of the handover. Purple accent to
    // match the app's billing surfaces; kept high on the page so a non-payer
    // recipient meets it first.
    <section
      data-testid="incoming-transfer-offers"
      className="mb-6 rounded-2xl border border-purple-200 bg-purple-50 p-5"
    >
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-purple-700">
        {msg("billing.group.transfer.incomingTitle")}
      </p>
      {incoming.map((o) => (
        <div key={o.setup_intent_id} className="text-sm text-slate-700">
          <p>{msg("billing.group.transfer.incomingBody")}</p>
          {o.summary ? <OfferSummary summary={o.summary} /> : null}
          {acceptingId === o.setup_intent_id && o.client_secret ? (
            <TransferOfferAccept
              clientSecret={o.client_secret}
              setupIntentId={o.setup_intent_id}
              onDone={() => {
                setAcceptingId(null);
                void load();
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setAcceptingId(o.setup_intent_id)}
              // A secret that could not be fetched (Stripe outage) leaves the
              // offer visible but not yet acceptable — see listGroupTransferOffers.
              disabled={!o.client_secret}
              className="btn btn-primary mt-2 text-sm"
            >
              {msg("billing.group.transfer.incomingAccept")}
            </button>
          )}
        </div>
      ))}
    </section>
  );
}

/**
 * The cost the recipient is taking on, shown ABOVE the Accept button. The one
 * thing it must land plainly: accepting bills NOTHING now (handOverGroup only
 * makes the incoming card the default; the current period is already paid), so
 * "No charge today" leads and is emphasised. The renewal — the only future money
 * — is muted below it. A group with no live subscription has no renewal to state.
 *
 * The org-count phrase is built in JS (a one/other key pair picked on `n`) rather
 * than an ICU plural key, keeping it plural-safe across the four locales without
 * threading plural rules through this surface.
 */
export function OfferSummary({ summary }: { summary: IncomingSummary }) {
  const msg = useMsg();
  const locale = useLocale();
  const currency = asCurrency(summary.currency);
  const orgs = msg(
    summary.org_count === 1
      ? "billing.group.transfer.summary.orgOne"
      : "billing.group.transfer.summary.orgOther",
    { n: summary.org_count },
  );

  let renewalLine: string;
  if (summary.renewal) {
    const interval =
      summary.renewal.interval === "annual"
        ? msg("billing.group.transfer.summary.intervalAnnual")
        : msg("billing.group.transfer.summary.intervalMonthly");
    renewalLine = msg("billing.group.transfer.summary.renewal", {
      amount: formatMinor(summary.renewal.amount_minor, currency, locale),
      date: summary.renewal_date
        ? fmtDate(UTC, summary.renewal_date * 1000, { day: "numeric", month: "long", year: "numeric" })
        : "",
      interval,
    });
  } else {
    // No renewal quote: a community/no-live group genuinely has nothing to bill;
    // a live group whose Stripe quote missed still renews, just at an amount we
    // could not fetch — one neutral fallback covers the latter.
    renewalLine =
      summary.renewal_date === null
        ? msg("billing.group.transfer.summary.noRenewal")
        : msg("billing.group.transfer.summary.renewalFallback");
  }

  return (
    <div className="mt-3 rounded-xl border border-purple-100 bg-white/70 p-3">
      <p className="font-semibold text-slate-900">
        {msg("billing.group.transfer.summary.noChargeToday")}
      </p>
      <p className="mt-1 text-slate-700">
        {msg("billing.group.transfer.summary.takingOver", {
          orgs,
          plan: planLabel(summary.plan_key),
        })}
      </p>
      <p className="mt-1 text-xs text-slate-500">{renewalLine}</p>
    </div>
  );
}
