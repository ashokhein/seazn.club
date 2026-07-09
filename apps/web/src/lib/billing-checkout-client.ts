// Client-side helper to start an embedded checkout. Kept free of React/Stripe
// imports so it unit-tests under the node vitest env. The billing page fetches
// the client_secret UP FRONT (here) and only mounts <EmbeddedCheckout> once it
// resolves — if the checkout call fails (e.g. an environment whose plans price
// ids were never stripe-synced → 503), we surface the error instead of leaving
// Stripe's embedded spinner loading forever with nothing to render.

export type CheckoutSecretResult =
  | { ok: true; clientSecret: string }
  | { ok: false; error: string };

const FALLBACK_ERROR = "Checkout is unavailable right now. Please try again.";

/** POST /api/billing/checkout and return the client_secret, or a display error.
 *  Never throws — a rejected fetch or a non-ok body maps to `{ ok: false }`. */
export async function fetchCheckoutClientSecret(
  interval: "monthly" | "annual",
  fetchFn: typeof fetch = fetch,
): Promise<CheckoutSecretResult> {
  try {
    const res = await fetchFn("/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan_key: "pro", interval }),
    });
    const data = await res.json().catch(() => null);
    const clientSecret = data?.data?.client_secret;
    if (!data?.ok || typeof clientSecret !== "string" || !clientSecret) {
      return { ok: false, error: (data?.error as string) || FALLBACK_ERROR };
    }
    return { ok: true, clientSecret };
  } catch {
    return { ok: false, error: FALLBACK_ERROR };
  }
}
