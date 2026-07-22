import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  IncomingTransferOffers,
  OfferSummary,
  incomingOnly,
  type IncomingOffer,
  type IncomingSummary,
} from "../incoming-transfer-offers";
import { DictProvider } from "@/components/i18n/dict-provider";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";

// Same reasoning as create-org-form.test.tsx: this component's offer list
// arrives in an effect and the vitest env here is `node` with no jsdom, so a
// render test would run no effect and assert against the null returned before
// the fetch lands. The DECISION — which offers are "incoming" (the server's
// canonical direction === "made_to_me") versus the caller's own outgoing ones —
// is the logic worth testing, so it lives in the pure `incomingOnly` and is
// asserted directly. The cost-summary block is rendered directly below.
const enDict = uiEn as unknown as Dict;

const summary = (over: Partial<IncomingSummary> = {}): IncomingSummary => ({
  plan_key: "pro",
  org_count: 2,
  currency: "gbp",
  renewal_date: null,
  charge_now_minor: 0,
  renewal: null,
  ...over,
});

const offer = (over: Partial<IncomingOffer>): IncomingOffer => ({
  setup_intent_id: "seti_1",
  client_secret: "seti_1_secret",
  direction: "made_to_me",
  summary: summary(),
  ...over,
});

describe("incomingOnly", () => {
  it("keeps offers made to the current user (direction made_to_me)", () => {
    const offers = [offer({ setup_intent_id: "seti_a", direction: "made_to_me" })];
    expect(incomingOnly(offers).map((o) => o.setup_intent_id)).toEqual(["seti_a"]);
  });

  it("drops the caller's own outgoing offers (direction made_by_me)", () => {
    const offers = [
      offer({ setup_intent_id: "seti_in", direction: "made_to_me" }),
      offer({ setup_intent_id: "seti_out", direction: "made_by_me", summary: null }),
    ];
    expect(incomingOnly(offers).map((o) => o.setup_intent_id)).toEqual(["seti_in"]);
  });
});

describe("IncomingTransferOffers (SSR baseline)", () => {
  it("renders nothing before any offer loads", () => {
    const html = renderToStaticMarkup(
      <DictProvider dict={enDict} locale="en">
        <IncomingTransferOffers currentUserId="u_me" />
      </DictProvider>,
    );
    // No fetch has run in the node env, so there are no incoming offers and the
    // component returns null — the recipient card only appears once one lands.
    expect(html).toBe("");
    expect(html).not.toContain("A bill offered to you");
  });
});

// The cost summary block is a pure function of its `summary` prop, so it renders
// synchronously with no effect — asserting its copy needs no fetch.
const renderSummary = (s: IncomingSummary): string =>
  renderToStaticMarkup(
    <DictProvider dict={enDict} locale="en">
      <OfferSummary summary={s} />
    </DictProvider>,
  );

describe("OfferSummary copy", () => {
  it("leads with 'No charge today' and states the org count for a made_to_me offer", () => {
    const html = renderSummary(summary({ org_count: 3 }));
    expect(html).toContain("No charge today.");
    expect(html).toContain("3 organisations");
    // No live subscription → the neutral no-renewal line, never a made-up amount.
    expect(html).toContain("no paid subscription");
  });

  it("shows the renewal amount and interval when the offer carries a live quote", () => {
    const html = renderSummary(
      summary({ renewal_date: 1_800_000_000, renewal: { amount_minor: 3700, interval: "monthly" } }),
    );
    expect(html).toContain("No charge today.");
    expect(html).toContain("£37");
    expect(html).toContain("monthly");
  });
});
