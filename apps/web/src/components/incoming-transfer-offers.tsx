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
import { useMsg } from "@/components/i18n/dict-provider";
import { TransferOfferAccept } from "@/components/transfer-offer-accept";

/** The fields this surface reads off a transfer offer. `GET
 *  /api/billing/group/transfer` returns more (see listGroupTransferOffers);
 *  only these are modelled here. `client_secret` is populated only on offers
 *  made TO the caller — it is what the recipient confirms a card against. */
export interface IncomingOffer {
  setup_intent_id: string;
  client_secret: string | null;
  to_user_id: string | null;
}

/** Offers addressed TO this user — the incoming ones. The same payload also
 *  carries the caller's OWN outgoing offers (kept in BillingGroupPanel), so
 *  they are filtered out here: a payer who is also mid-offer must not read
 *  their own outgoing claim as a bill being handed to them. */
export function incomingOnly<T extends { to_user_id: string | null }>(
  offers: T[],
  currentUserId: string,
): T[] {
  return offers.filter((o) => o.to_user_id === currentUserId);
}

export function IncomingTransferOffers({ currentUserId }: { currentUserId: string }) {
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
    setIncoming(incomingOnly(offers, currentUserId));
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
