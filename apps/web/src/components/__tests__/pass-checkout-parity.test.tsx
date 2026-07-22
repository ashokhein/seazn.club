// D11 — "The Event Pass checkout opens in the same Modal and theme as the Pro
// checkout — one checkout presentation across the product."
//
// What was wrong: the pass mounted <EmbeddedCheckout> INLINE inside the pricing
// card, escaped that card with a `-mx-9 w-auto sm:mx-0` full-bleed hack, and
// offered a bare `text-xs text-slate-500` "Cancel" link to back out. Pro
// (billing-actions.tsx:49) opens `<Modal title=… size="lg">`, which caps the
// sheet at 85vh, scrolls its body, dims the page behind an overlay, and ships
// three ways out (×, overlay click, Escape). One product, two checkouts.
//
// Rendered through react-dom/server — vitest runs `environment: "node"` and this
// workspace has no jsdom (see competition-pass-entry.test.tsx for the same
// pattern). Stripe's own components are stubbed on purpose: D11 is about OUR
// chrome. Inside the iframe both checkouts already agree, because both builders
// send the same CHECKOUT_BRANDING (lib/billing.ts:18).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { sharedStripe, providerProps } = vi.hoisted(() => ({
  sharedStripe: Promise.resolve(null),
  providerProps: [] as { stripe: unknown }[],
}));

vi.mock("@stripe/react-stripe-js", () => ({
  EmbeddedCheckoutProvider: (props: { stripe: unknown; children?: React.ReactNode }) => {
    providerProps.push({ stripe: props.stripe });
    return <div data-stripe-provider>{props.children}</div>;
  },
  EmbeddedCheckout: () => <div data-stripe-embedded-checkout />,
}));
vi.mock("@/lib/stripe-browser", () => ({ stripePromise: sharedStripe }));

import { PassCheckoutSheet, PassUpgradeButton } from "@/components/pass-upgrade";

const SECRET = "cs_test_a1_secret_b2";

const sheet = (onClose: () => void = () => {}) =>
  renderToStaticMarkup(<PassCheckoutSheet clientSecret={SECRET} onClose={onClose} />);

describe("Event Pass checkout — presentation parity with Pro (D11)", () => {
  it("opens the checkout in a modal dialog rather than inline in the page", () => {
    const html = sheet();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
  });

  it("uses the same lg sheet as the Pro checkout", () => {
    // Pro passes size="lg" so the Stripe iframe gets a 2xl column instead of
    // Modal's default md. A pass checkout in an md sheet would be visibly
    // narrower than the Pro one at the same viewport.
    expect(sheet()).toContain("sm:max-w-2xl");
  });

  it("lets the Modal own the height, exactly as the Pro checkout does", () => {
    // Stripe's iframe measures and resizes ITSELF. The container must impose no
    // height of its own; Modal's max-h-[85vh] + overflow-y-auto body is the cap.
    const html = sheet();
    expect(html).toContain("max-h-[85vh]");
    expect(html).toContain("overflow-y-auto");
  });

  it("drops the full-bleed hack — Modal already handles phone widths", () => {
    // `-mx-9 w-auto sm:mx-0` dragged the iframe out through the card's padding
    // to fake a full-bleed sheet. Modal is a real bottom sheet under `sm`
    // (w-full, rounded-t-2xl, safe-area padding), so the escape is now a bug:
    // negative margins inside a sheet that is already flush would overhang it.
    const html = sheet();
    expect(html).not.toContain("-mx-9");
    expect(html).not.toContain("w-auto");
  });

  it("closes through the Modal's own affordance, not a bare text link", () => {
    const html = sheet();
    expect(html).toContain('aria-label="Close"');
    // The 12px slate "Cancel" link is gone — it was the only way out of the old
    // inline checkout, and it read as body copy rather than a control.
    expect(html).not.toContain(">Cancel<");
    expect(html).not.toContain("text-xs text-slate-500");
  });

  it("hands the same onClose to the Modal, so ×, overlay and Escape all back out", () => {
    // PassCheckoutSheet holds no state, so it can be called directly and its
    // element props inspected (the run-your-own-cta.test.tsx pattern).
    const onClose = vi.fn();
    const el = PassCheckoutSheet({ clientSecret: SECRET, onClose });
    expect(el.props.size).toBe("lg");
    expect(el.props.onClose).toBe(onClose);
  });

  it("names a one-time purchase honestly, and never calls it a plan change", () => {
    // Deliberate divergence from Pro's "Complete your upgrade": the pass is a
    // single $29 payment for one competition, not a subscription. D12/D13 exist
    // because buyers already confuse the two; the chrome must not add to it.
    const html = sheet();
    expect(html).toContain("Complete your purchase");
    expect(html).not.toContain("upgrade");
    expect(html).not.toContain("Upgrade");
  });

  it("loads Stripe.js from the app's single shared instance, like Pro does", () => {
    // The pass used to call loadStripe() again at module scope with the same
    // publishable key, so a session that touched both surfaces pulled Stripe.js
    // in twice. lib/stripe-browser.ts exists to be the one instance ("Load
    // Stripe.js once for the whole app"); billing-actions.tsx already uses it.
    providerProps.length = 0;
    sheet();
    expect(providerProps).toHaveLength(1);
    expect(providerProps[0].stripe).toBe(sharedStripe);
  });

  it("mounts the embedded checkout exactly once, inside the sheet", () => {
    // Remounting EmbeddedCheckoutProvider restarts the Stripe session, so the
    // provider must live in one place under the dialog — not one copy per branch.
    const html = sheet();
    expect(html.match(/data-stripe-provider/g)).toHaveLength(1);
    expect(html.match(/data-stripe-embedded-checkout/g)).toHaveLength(1);
    expect(html.indexOf('role="dialog"')).toBeLessThan(html.indexOf("data-stripe-provider"));
  });
});

describe("Event Pass checkout — the button that opens it", () => {
  it("keeps the [data-pass-buy] hook and the priced label before checkout opens", () => {
    // Unchanged contract: the closed state is still the primary CTA on the
    // upgrade page. pricing-v3.spec.ts owns [data-pass-cta]/[data-pass-owned]
    // and task 19 added [data-pass-entry] — this one is separate from all three.
    const html = renderToStaticMarkup(
      <PassUpgradeButton competitionId="comp_1" label="Upgrade this event — $29" />,
    );
    expect(html).toContain("data-pass-buy");
    expect(html).toContain("Upgrade this event — $29");
    expect(html).not.toContain('role="dialog"');
  });
});

describe("…and the Pro checkout it is matched to", () => {
  it("still opens the same Modal size, so parity is a fact and not a snapshot", () => {
    // Parity has two sides. If the Pro checkout is ever restyled without the
    // pass following, the assertions above would keep passing against a
    // presentation that no longer matches anything. Read the reference.
    const pro = fs.readFileSync(
      path.resolve(__dirname, "../billing-actions.tsx"),
      "utf8",
    );
    expect(pro).toMatch(/<Modal[^>]*\bsize="lg"/);
    expect(pro).toMatch(/from "@\/components\/modal"/);
  });
});
