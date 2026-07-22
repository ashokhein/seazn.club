import Stripe from "stripe";

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      "STRIPE_SECRET_KEY is not set. Add it to .env.local (use a test key for local dev).",
    );
  }
  // e2e ONLY: point the client at a local Stripe fixture server so the charge
  // paths (subscription-item quantity, proration preview) execute end to end
  // without touching the real Stripe API — the same trick e2e/ai-fixture-server
  // uses for the model endpoint. Never set in production; api.stripe.com is the
  // default the moment STRIPE_MOCK_HOST is absent.
  const mockHost = process.env.STRIPE_MOCK_HOST;
  const mockOverride = mockHost
    ? {
        host: mockHost,
        port: Number(process.env.STRIPE_MOCK_PORT ?? 12111),
        protocol: "http" as const,
      }
    : {};

  _stripe = new Stripe(key, {
    ...mockOverride,
    // PINNED. An unpinned client follows whatever version the account is set to
    // and silently changes shape under us on a Stripe-side upgrade — this
    // codebase already carries several "in v22 X moved to Y" comments
    // (invoice.parent.subscription_details, item-level current_period_end) that
    // exist because a response shape moved. Matches the installed SDK's types,
    // so a bump is a deliberate, type-checked change.
    apiVersion: "2026-06-24.dahlia",
    // The billing-group quantity sync holds a `select ... for update` on the
    // subscription row ACROSS a Stripe round trip (see syncGroupQuantity — it is
    // what makes retrieve-then-update atomic). The SDK's default is an 80s
    // timeout WITH a retry, so a hanging Stripe would pin that row lock, an org
    // row lock and a pool connection for minutes, with attaches queued behind
    // it. Fail fast instead: the reconcile sweep exists to pick the work up.
    timeout: 10_000,
    // Retries are wrong for this workload specifically: an automatic retry of a
    // subscription-item update is a retry of a CHARGE. Callers here are
    // idempotent by re-derivation (quantity is absolute, never incremented), so
    // a failure is safely retried by the sweep rather than blindly by the SDK.
    maxNetworkRetries: 0,
  });
  return _stripe;
}
