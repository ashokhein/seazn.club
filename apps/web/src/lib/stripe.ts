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
  _stripe = new Stripe(key, {
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
