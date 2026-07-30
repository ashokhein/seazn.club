/** Statuses in which a Stripe subscription still owns the org's billing. Our
 *  STATUS_MAP collapses unpaid/paused into past_due and keeps `incomplete`
 *  distinct (a never-paid first invoice — live, but entitled to nothing until it
 *  pays), so this list is the whole non-terminal set of STRIPE-SOURCED statuses.
 *  `canceled` is terminal — a departed customer must be able to come back.
 *
 *  No 'suspended' here, and that is not an omission. Staff suspension USED to
 *  stamp subscriptions.status = 'suspended', which was harmless only while a
 *  subscription belonged to exactly one org. V314 §2b ended that: the row is a
 *  shared billing GROUP, so writing it would stop billing and degrade
 *  entitlements for every sibling org. api/admin/orgs/[id]/suspend now writes
 *  organizations.status and nothing else, V314 reset every legacy 'suspended'
 *  subscription row to 'active', and nothing in the application writes that
 *  value to this column any more. Suspension bites through the resolver's
 *  `o.status = 'suspended'` arm (entitlements.ts orgPlanKey, and org_has_feature
 *  in SQL) — org-scoped, so the group keeps billing and siblings are untouched.
 *
 *  This list is still consumed by NEGATION rather than by enumerating the dead
 *  statuses, because subscriptions.status is plain text with no CHECK
 *  constraint (default 'active'). Anything outside this list — a legacy row, a
 *  hand-edited one — therefore reads as non-live and degrades safely. Stripe
 *  statuses cannot widen the column: STATUS_MAP maps the ones we know and
 *  falls back to 'incomplete', which is in this list.
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
  // A never-paid first invoice still owns a real subscription (blocks a second
  // checkout); the entitlement resolver grants it nothing until it pays (#206).
  "incomplete",
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

/**
 * Is a STRIPE status terminal — the subscription is over and will not bill again?
 *
 * The argument is a status straight off Stripe, BEFORE `STATUS_MAP` translates
 * it, which is why `incomplete_expired` appears here and nowhere in the app's
 * own vocabulary: STATUS_MAP folds it into `canceled`, so no row we write ever
 * carries it (lib/billing.ts, #375).
 *
 * One definition, two callers phrasing it opposite ways: `isLiveStripeStatus` in
 * usecases/billing-events.ts (the webhook write guard) and `sweepOrphanGroups`
 * in usecases/billing-groups.ts ("did Stripe finish this off?"). They cannot
 * import each other — billing-events already imports billing-groups — so it
 * lives in this leaf module, which is also what stops the two from keeping
 * hand-written copies of the same two strings.
 */
export function isTerminalStripeStatus(status: string): boolean {
  return status === "canceled" || status === "incomplete_expired";
}
