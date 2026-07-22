import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  IncomingTransferOffers,
  incomingOnly,
  type IncomingOffer,
} from "../incoming-transfer-offers";
import { DictProvider } from "@/components/i18n/dict-provider";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";

// Same reasoning as create-org-form.test.tsx: this component's offer list
// arrives in an effect and the vitest env here is `node` with no jsdom, so a
// render test would run no effect and assert against the null returned before
// the fetch lands. The DECISION — which offers are "incoming" (addressed to
// me) versus the caller's own outgoing ones — is the logic worth testing, so
// it lives in the pure `incomingOnly` and is asserted directly.
const enDict = uiEn as unknown as Dict;

const ME = "u_me";
const offer = (over: Partial<IncomingOffer>): IncomingOffer => ({
  setup_intent_id: "seti_1",
  client_secret: "seti_1_secret",
  to_user_id: ME,
  ...over,
});

describe("incomingOnly", () => {
  it("keeps offers addressed to the current user", () => {
    const offers = [offer({ setup_intent_id: "seti_a", to_user_id: ME })];
    expect(incomingOnly(offers, ME).map((o) => o.setup_intent_id)).toEqual(["seti_a"]);
  });

  it("drops the caller's own outgoing offers (addressed to someone else)", () => {
    const offers = [
      offer({ setup_intent_id: "seti_in", to_user_id: ME }),
      offer({ setup_intent_id: "seti_out", to_user_id: "u_other" }),
      offer({ setup_intent_id: "seti_null", to_user_id: null }),
    ];
    expect(incomingOnly(offers, ME).map((o) => o.setup_intent_id)).toEqual(["seti_in"]);
  });
});

describe("IncomingTransferOffers (SSR baseline)", () => {
  it("renders nothing before any offer loads", () => {
    const html = renderToStaticMarkup(
      <DictProvider dict={enDict} locale="en">
        <IncomingTransferOffers currentUserId={ME} />
      </DictProvider>,
    );
    // No fetch has run in the node env, so there are no incoming offers and the
    // component returns null — the recipient card only appears once one lands.
    expect(html).toBe("");
    expect(html).not.toContain("A bill offered to you");
  });
});
