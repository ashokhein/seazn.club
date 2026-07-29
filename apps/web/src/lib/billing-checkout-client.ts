// Client-side helper to start an embedded checkout. Kept free of React/Stripe
// imports so it unit-tests under the node vitest env. The billing page fetches
// the client_secret UP FRONT (here) and only mounts <EmbeddedCheckout> once it
// resolves — if the checkout call fails (e.g. an environment whose plans price
// ids were never stripe-synced → 503), we surface the error instead of leaving
// Stripe's embedded spinner loading forever with nothing to render.

import type { PassKey } from "@/lib/currency";
import { orgScopeHeaders } from "@/lib/org-scope";

export type CheckoutSecretResult =
  | { ok: true; clientSecret: string }
  /**
   * `error` is the SERVER's own sentence — hardcoded English, and on an
   * unexpected 500 a raw `err.message` (lib/http.ts). Do not render it to a
   * buyer in a localised surface; render copy chosen from `status` instead
   * (`passCheckoutErrorKey`, lib/pass-ladder.ts). It is kept because a status
   * cannot say *which* 400 this was, so it is still the useful thing to log.
   *
   * `status` is null when no response was received at all — a rejected fetch.
   */
  | { ok: false; error: string; status: number | null };

const FALLBACK_ERROR = "Checkout is unavailable right now. Please try again.";

async function fetchClientSecret(
  path: string,
  body: unknown,
  fetchFn: typeof fetch,
): Promise<CheckoutSecretResult> {
  try {
    const res = await fetchFn(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // WHICH organisation this write is for, from the console URL on
        // screen rather than the `seazn_org` cookie the route would otherwise
        // read — that cookie lags a navigation by one client effect, so a save
        // made inside the window landed on the PREVIOUS billing group (v17 gap
        // #334).
        ...orgScopeHeaders(),
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    const clientSecret = data?.data?.client_secret;
    if (!data?.ok || typeof clientSecret !== "string" || !clientSecret) {
      return {
        ok: false,
        error: (data?.error as string) || FALLBACK_ERROR,
        // A real Response always carries one; a hand-rolled double in a test
        // may not, and `undefined` leaking into a `number | null` field would
        // route a known 503 into the generic "something went wrong" copy.
        status: typeof res.status === "number" ? res.status : null,
      };
    }
    return { ok: true, clientSecret };
  } catch {
    return { ok: false, error: FALLBACK_ERROR, status: null };
  }
}

/** POST /api/billing/checkout and return the client_secret, or a display error.
 *  Never throws — a rejected fetch or a non-ok body maps to `{ ok: false }`. */
export async function fetchCheckoutClientSecret(
  plan: "pro" | "pro_plus",
  interval: "monthly" | "annual",
  fetchFn: typeof fetch = fetch,
): Promise<CheckoutSecretResult> {
  return fetchClientSecret("/api/billing/checkout", { plan_key: plan, interval }, fetchFn);
}

/** POST /api/billing/pass-checkout for a one-time Event Pass (v3/07 §3).
 *  `passKey` selects the RUNG — M (`'event_pass'`) or L (`'event_pass_l'`,
 *  v17 #294).
 *
 *  **Required, deliberately not defaulted.** The key is the only thing that
 *  picks the PRICE OBJECT: the route resolves `plans.stripe_price_id_onetime`
 *  by exactly this value and stamps it into the session metadata the webhook
 *  records. So a forgotten key here does not fail — it MISCHARGES, selling L's
 *  caps at M's $29 or billing M's caps at L's $59. A default would buy nothing
 *  (there is one call site) and would permanently disarm `tsc` for every future
 *  one; same ruling as `passPrice` (T2) and `recordPassPurchase` (T3), and
 *  stronger here because those only misquote.
 *
 *  Typed as `PassKey` rather than a local union so a third rung added to
 *  PASS_KEYS widens this helper instead of routing through an enumerator that
 *  has gone stale (this wave's whole bug class). Type-only import: no runtime
 *  dependency reaches the client bundle.
 *
 *  A rung the server has no synced price for is a 503, and an unknown key a
 *  400 — both arrive as `{ ok: false, error, status }`. Render copy chosen from
 *  `status`, never the server's `error` string: see the type above. */
export async function fetchPassCheckoutClientSecret(
  competitionId: string,
  passKey: PassKey,
  fetchFn: typeof fetch = fetch,
): Promise<CheckoutSecretResult> {
  return fetchClientSecret(
    "/api/billing/pass-checkout",
    { competition_id: competitionId, pass_key: passKey },
    fetchFn,
  );
}

/** POST /api/billing/credit-pack-checkout for a one-time AI credit pack
 *  (v17 SPEC-6 §A4). Same embedded-secret contract as the plan/pass checkouts. */
export async function fetchCreditPackCheckoutClientSecret(
  packKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<CheckoutSecretResult> {
  return fetchClientSecret(
    "/api/billing/credit-pack-checkout",
    { pack_key: packKey },
    fetchFn,
  );
}
