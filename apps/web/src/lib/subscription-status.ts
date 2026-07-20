/** Statuses in which a Stripe subscription still owns the org's billing. Our
 *  STATUS_MAP collapses incomplete/unpaid/paused into past_due, so this list
 *  is the whole non-terminal set of STRIPE-SOURCED statuses. `canceled` is
 *  terminal — a departed customer must be able to come back.
 *
 *  STATUS_MAP is NOT the whole vocabulary of subscriptions.status: 'suspended'
 *  is written in-app by the staff suspend route (api/admin/orgs/[id]/suspend)
 *  and never comes from Stripe, so it appears in no map here. It is not live —
 *  which is what makes a suspended org's lapsed comp expire like any other.
 *
 *  Lives in its own leaf module (no imports) because BOTH sides of a cycle need
 *  it: lib/billing.ts imports invalidateOrgEntitlements from lib/entitlements.ts,
 *  and lib/entitlements.ts builds its comp-expiry SQL from this list. Keeping it
 *  here also keeps the stripe SDK out of the entitlements hot path (`server-only`
 *  already reaches entitlements via lib/cache.ts, so that is not a reason).
 *  Consumers may import it from either module — lib/billing.ts re-exports.
 *
 *  Typed `readonly string[]` (not `as const`) so `.includes(someString)` type-
 *  checks; spread it for postgres.js list interpolation: `sql([...LIST])`.
 */
export const LIVE_SUBSCRIPTION_STATUSES: readonly string[] = [
  "trialing",
  "active",
  "past_due",
];

/**
 * Is this org billed by a subscription right now? A cancelled subscription
 * keeps its id on the row forever, so the id alone is NOT the test — anything
 * branching on `stripe_subscription_id` would treat a long-departed customer as
 * Stripe-billed. Shared by the checkout guard, the staff trial grant, AND the
 * admin plan panel (a CLIENT component) so none of the three can drift apart.
 *
 * Lives beside LIVE_SUBSCRIPTION_STATUSES rather than in lib/billing.ts for the
 * same reason: this module has no imports, so a client component can import it
 * directly. lib/billing.ts re-exports it for the historical server-side import
 * site.
 *
 * Type predicate: a true result means both columns are non-null, so callers can
 * read `sub.stripe_subscription_id` / `sub.status` without a `!` assertion.
 */
export function hasLiveSubscription(
  sub: { stripe_subscription_id: string | null; status: string | null } | undefined,
): sub is { stripe_subscription_id: string; status: string } {
  return (
    !!sub?.stripe_subscription_id &&
    LIVE_SUBSCRIPTION_STATUSES.includes(sub.status ?? "")
  );
}
