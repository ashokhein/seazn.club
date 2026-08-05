export const dynamic = "force-dynamic";
// Competition shell (v3/07 §3): resolves the Event Pass state for THIS
// competition once per request and provides it to every client island
// underneath, so gates stop being unable to ask. Every page below already
// declares force-dynamic; this repeats it because the layout itself does an
// uncached DB read.
//
// THREE facts, not one. "Is there a pass row" alone left an org already on a
// paid plan reading false, and the gate then offered it the Event Pass — which
// for a paid org is a DOWNGRADE, not a redundant sale: Pro's matrix is a strict
// superset of the pass's at every key the pass lifts. So the org's resolved plan
// rides along in the same read.
//
// The third is the pass's own RUNG plus the org's CURRENCY (v17 #294). Both
// exist only on the server — the rung is a column, the currency is a
// subscription/cookie/header resolution — and both are needed by client islands
// that were guessing: the paywall priced every reader on earth in hardcoded usd,
// and the "pass active" signals named the product family while two rungs sell at
// $29 and $59.
//
// The fourth is whether the pass STILL APPLIES (v17 gap #301). The read here
// was row existence and nothing more, so a pass the resolver had already
// stopped honouring — its competition completed or archived, or run past
// `ends_on` plus grace — reached every island underneath looking exactly like a
// live one, and they said "Event Pass active" to an org that was back on
// Community caps. Fixing it at the six surfaces would have been six copies of
// the rule; the join lives here, and `passLockReason` judges it.
//
// Deliberately NOT auth-gated. `requireCompetitionPage` 404s scorers and
// non-members, but the /o layout lets both through on purpose so an accepted
// official's fixture deep-link (design v2 §A2) can reach `requireFixturePage`
// further down. A layout that gated here would break that link before the page
// that owns the decision ever ran. Every child page still runs its own gate, so
// this adds no surface — only a boolean about a competition already in the URL.
//
// Anything unresolvable (missing org, missing competition, or a slug that only
// exists in slug_history) yields `false` and renders children untouched: the
// child page owns the 404 / permanent-redirect, and a pass state is never worth
// pre-empting it.
import { sql } from "@/lib/db";
import { isPaidPlan, orgPlanKey, passLockReason, type PassLockReason } from "@/lib/entitlements";
import { isPassKey, PASS_KEYS, type Currency, type PassKey } from "@/lib/currency";
import { sellablePassRungs } from "@/lib/pass-vs-plan";
import { preferredCurrency } from "@/lib/currency-server";
import { orgBySlug, compBySlug } from "@/server/slug-resolve";
import { CompetitionPassProvider } from "@/components/competition-pass-provider";

/**
 * `params` is a PROMISE in this version of Next and must be awaited —
 * confirmed in `node_modules/next/dist/docs/01-app/03-api-reference/
 * 03-file-conventions/layout.md` ("Props → params (optional): A promise that
 * resolves to an object containing the dynamic route parameters … You must use
 * async/await or React's `use` function"). The docs also offer a generated
 * `LayoutProps<'/o/[orgSlug]/c/[compSlug]'>` helper, but it only exists after
 * `next dev` / `next build` / `next typegen` has run, so `npx tsc --noEmit` on
 * a clean checkout would not see it. The explicit Promise type is what the rest
 * of this tree uses (see the sibling `/o/[orgSlug]/layout.tsx`).
 */
export default async function CompetitionLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; compSlug: string }>;
}) {
  const { orgSlug, compSlug } = await params;
  const { passKey, paidPlan, sellableRungs, currency, lockReason } = await passState(
    orgSlug,
    compSlug,
  );
  return (
    <CompetitionPassProvider
      passKey={passKey}
      paidPlan={paidPlan}
      sellableRungs={sellableRungs}
      currency={currency}
      lockReason={lockReason}
    >
      {children}
    </CompetitionPassProvider>
  );
}

/**
 * Which pass rung does this competition hold, is the org on a paid plan, what
 * currency does it buy in, and is this competition past the line where a pass
 * applies (or may be sold) at all?
 *
 * The slug lookups go through the React-`cache()`d resolvers, which the org
 * layout and the child page already call with the same arguments — so in the
 * common request the extra work is the three reads below, issued CONCURRENTLY:
 * one round trip in wall-clock terms, and none depends on another.
 *
 * `pass_key` rather than `select 1`: same row, same index, one more column, and
 * it is the only place a client island can learn the rung (v17 #294).
 * `isPassKey` guards it rather than a cast — the column is `not null default
 * 'event_pass'` and a row written by a future rung this build predates must
 * degrade to a real label, not to a missing dictionary key.
 *
 * `status`/`ends_on` (v17 gap #301) ride the same lookup rather than adding a
 * query: the layout is already inside the competition, and the two columns are
 * what decides whether a pass may apply — or be sold — here at all. The read is
 * FROM `competitions` and LEFT JOINs the pass (#376): the earlier INNER join
 * through `competition_passes` returned no row whatsoever for a competition
 * that had never been sold one, so the lock could not be judged in the very
 * case it now has to be. The lock belongs to the COMPETITION; the pass row only
 * decides which side of it the org is on.
 *
 * The judgement itself is `passLockReason`'s, never this file's. The same rule
 * is enforced in three places that must agree exactly — the TS resolver, the
 * `org_has_feature` SQL (V338), and now the UI — and the only defence against
 * them drifting is that two of them call the same function and the third is
 * pinned to it by `entitlements-sql-parity.test.ts`. A status list or a date
 * comparison written here would be a fourth copy.
 *
 * `stripe_payment_intent` is NOT consulted: it is nullable by design (V271),
 * and a staff-granted pass with a null intent is fully active.
 *
 * The plan comes from `orgPlanKey`, the entitlement resolver's own derivation,
 * NOT from `subscriptions.plan_key` raw. The difference is customer-visible in
 * both directions: a live staff comp carries the Pro matrix with no Stripe
 * subscription at all (so must not be sold a pass), while a LAPSED comp and a
 * past_due subscription beyond its 14-day grace both still read `plan_key =
 * 'pro'` on the row yet resolve as community (so the pass genuinely lifts them
 * and must still be offered). Sharing the resolver's derivation is the only way
 * "what we sell" and "what we grant" cannot drift.
 */
async function passState(
  orgSlug: string,
  compSlug: string,
): Promise<{
  passKey: PassKey | null;
  paidPlan: boolean;
  sellableRungs: PassKey[];
  currency: Currency;
  lockReason: PassLockReason | null;
}> {
  const none = {
    passKey: null,
    paidPlan: false,
    // Unresolvable org/competition: the child page owns the 404, and every rung
    // stays nominally for sale, which is what shipped before #327.
    sellableRungs: [...PASS_KEYS] as PassKey[],
    currency: "usd" as Currency,
    lockReason: null,
  };
  const org = await orgBySlug(orgSlug);
  if (!org || "renamedTo" in org) return none;
  const comp = await compBySlug(org.id, compSlug);
  if (!comp || "renamedTo" in comp) return none;
  const [[row], planKey, currency] = await Promise.all([
    // LEFT JOIN, and FROM the competition (#376). The old INNER join through
    // `competition_passes` meant a competition with no pass returned no row at
    // all — so `status` and `ends_on` were never read, and the lock could not
    // be judged even in principle. The lock is a fact about the COMPETITION;
    // the pass row only decides which side of it the org is on. Same single
    // round trip.
    sql<{ pass_key: string | null; status: string; ends_on: Date | string | null }[]>`
      select cp.pass_key, c.status, c.ends_on
      from competitions c
      left join competition_passes cp on cp.competition_id = c.id
      where c.id = ${comp.id}
      limit 1`,
    orgPlanKey(org.id),
    preferredCurrency(org.id),
  ]);
  const hasPass = row?.pass_key != null;
  // Judged for every competition now, pass or no pass.
  const lockReason = row ? passLockReason(row.status, row.ends_on) : null;
  // `paidPlan` here means "the plan already covers everything a pass could add
  // to this competition", which is what every consumer of the flag actually
  // uses it for: `usePassGateState` returns `paid_plan` and the buy chip
  // disappears. Since v17 #327 that is no longer the same as "the org pays" —
  // the L rung lifts Pro's 256-entrant ceiling — and treating them as the same
  // would leave the sale the checkout now accepts with no way to reach it.
  //
  // Asked only when the org IS on a paid plan, so a community competition pays
  // for no extra query. A pass already held short-circuits it too: there is
  // nothing more to sell for that competition either way.
  const paid = isPaidPlan(planKey);
  // Nothing is sellable past the line — the route refuses it (410), so a rung
  // column here could only ever advertise a refusal. A held pass short-circuits
  // for the older reason: one pass per competition, forever (#248 Q4).
  const sellableRungs =
    hasPass || lockReason !== null
      ? []
      : ((await sellablePassRungs(PASS_KEYS, planKey, paid)) as PassKey[]);
  const covered = paid && sellableRungs.length === 0;
  return {
    passKey: hasPass && isPassKey(row.pass_key) ? (row.pass_key as PassKey) : hasPass ? "event_pass" : null,
    paidPlan: covered,
    sellableRungs,
    currency,
    lockReason,
  };
}
