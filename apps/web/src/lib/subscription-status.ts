/** Statuses in which a Stripe subscription still owns the org's billing. Our
 *  STATUS_MAP collapses incomplete/unpaid/paused into past_due, so this list
 *  is the whole non-terminal set. `canceled` is terminal — a departed customer
 *  must be able to come back.
 *
 *  Lives in its own leaf module (no imports) because BOTH sides of a cycle need
 *  it: lib/billing.ts imports invalidateOrgEntitlements from lib/entitlements.ts,
 *  and lib/entitlements.ts builds its comp-expiry SQL from this list. Keeping it
 *  here also keeps the stripe SDK and `server-only` out of the entitlements hot
 *  path. Consumers may import it from either module — lib/billing.ts re-exports.
 *
 *  Typed `readonly string[]` (not `as const`) so `.includes(someString)` type-
 *  checks; spread it for postgres.js list interpolation: `sql([...LIST])`.
 */
export const LIVE_SUBSCRIPTION_STATUSES: readonly string[] = [
  "trialing",
  "active",
  "past_due",
];
