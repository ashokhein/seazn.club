export const dynamic = "force-dynamic";
// The Event Pass page (v3/07 §3, spec D10). One-time embedded checkout that
// upgrades THIS competition for its lifetime, reconciled on return like the
// billing page (webhook optional).
//
// It was built for one visitor — a community owner who had not bought yet — and
// served four others badly. A non-owner got a price they cannot pay. A buyer who
// came back after hitting the pass's OWN ceiling got the same "you're all set"
// green box as one who came to admire the purchase, with no receipt, no next
// step and nothing to click but "back". And an org on a paid plan was shown
// "You're on Pro" and nothing else, on a page whose whole job is to explain what
// their competition can do.
//
// Seven states now, decided once in `upgradePageState()` and rendered here:
//
//   offer (owner)     the ticket, priced, with the buy button
//   offer (non-owner) the same ticket, no button — the price stays visible so
//                     they can take a number to whoever can spend it
//   owned             the stub flips to floodlit "active": bought-on date,
//                     receipt link, and the Pro step the dead end never offered
//   ceiling           a pass is held and something still blocked them; Pro only,
//                     with the credit line and the blocked limit picked out
//   ended             the pass is on the record but has stopped applying — the
//                     competition reached a terminal status, or ran past its
//                     end date plus the grace week (v17 gap #301). The stub
//                     keeps the rung, the date and the receipt (nothing bought
//                     is deleted) but loses the floodlight, and the page stops
//                     claiming the pass is active. It is never re-offered, so
//                     the two doors out are the plan and next year's edition.
//   closed            past the same line as `ended`, but NOTHING WAS EVER
//                     BOUGHT (#376). Its own panel rather than the ticket: the
//                     ticket carries a rung name, a purchase date and a receipt
//                     stub, and all three would be invented for a competition
//                     that never held a pass. No price, no buy button and no
//                     pass column in the table either — the checkout answers
//                     this sale with 410 Gone whatever the plan, so every one
//                     of them would advertise a refusal.
//   paid_plan         NO TICKET AND NO PRICE ANYWHERE. Every boolean the pass
//                     lifts is already true on a paid plan, and Pro raises the
//                     caps the pass raises (128 entrants per division against
//                     256, 10 divisions against no ceiling at all), so an offer
//                     here sells a DOWNGRADE — the defect f70b8e52 fixed in the
//                     paywall. The sales object is absent rather than disabled,
//                     which is the only version that cannot regress into a
//                     re-sale.
//                     Not a strict superset since v17 #294, mind: the L rung
//                     takes the entrant cap off entirely, above Pro's 256. The
//                     copy on this state says "features" for that reason, and
//                     whether Pro may buy L at all is #327.
//
// Every figure in the comparison is read from `plan_entitlements` at render
// time. See lib/pass-comparison.ts for why nothing is written down.
import Link from "@/components/ui/console-link";
import { sql } from "@/lib/db";
import { checkoutTrialDays, competitionHasRefusedPassPayment, reconcilePassCheckout } from "@/lib/billing";
import { captureError } from "@/lib/sentry";
import { requireCompetitionPage } from "@/server/page-auth";
import { routes } from "@/lib/routes";
import { PassUpgradeButton } from "@/components/pass-upgrade";
import { Tip } from "@/components/ui/tip";
import {
  formatMinor,
  isPassKey,
  proPrice,
  PASS_KEYS,
  type Currency,
  type PassKey,
} from "@/lib/currency";
import { passExceedsPlan, rungsExceedingPlan } from "@/lib/pass-vs-plan";
import {
  PASS_CLOSED_REASON_KEY,
  PASS_LOCK_REASON_KEY,
  PASS_RUNG_NAME_KEY,
  passLadderOptions,
  type PassRungOption,
} from "@/lib/pass-ladder";
import type { DictionaryKey } from "@/lib/i18n-keys";
import { preferredCurrency } from "@/lib/currency-server";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t, type Dict, type Locale } from "@/lib/i18n";
import {
  isPaidPlan,
  orgPlanKey,
  passLockReason,
  type PassLockReason,
} from "@/lib/entitlements";
import { planLabel } from "@/lib/plan-label";
import { getPassPurchases, type PassPurchaseRow } from "@/server/usecases/billing-manage";
import { upgradePageState, type UpgradePageState } from "@/lib/upgrade-page-state";
import {
  PASS_COMPARE_FEATURES,
  PASS_COMPARE_ROWS,
  compareCell,
  rowCovers,
  type CompareCell,
  type MatrixCell,
} from "@/lib/pass-comparison";
import { groupAlreadyRedeemed, withinCreditWindow } from "@/server/usecases/pass-credit";

/** `plan_key → feature_key → cell` for the plans a given state compares. */
type Matrix = Map<string, Map<string, NonNullable<MatrixCell>>>;

async function readMatrix(planKeys: string[]): Promise<Matrix> {
  const rows = await sql<
    { plan_key: string; feature_key: string; bool_value: boolean | null; int_value: number | null }[]
  >`
    select plan_key, feature_key, bool_value, int_value
    from plan_entitlements
    where plan_key in ${sql(planKeys)} and feature_key in ${sql(PASS_COMPARE_FEATURES)}`;
  const matrix: Matrix = new Map(planKeys.map((k) => [k, new Map()]));
  for (const r of rows)
    matrix.get(r.plan_key)?.set(r.feature_key, { bool: r.bool_value, int: r.int_value });
  return matrix;
}

export default async function CompetitionUpgradePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; compSlug: string }>;
  searchParams: Promise<{ checkout?: string; session_id?: string; feature?: string }>;
}) {
  const { orgSlug, compSlug } = await params;
  const page = await requireCompetitionPage(orgSlug, compSlug, { tail: "/upgrade" });
  const orgId = page.org.id;
  const compId = page.competition.id;

  // Reconcile straight from Stripe on return from checkout (best-effort,
  // idempotent) — the pass must lift gates before any webhook lands, and this
  // read decides which state the buyer lands in.
  const sp = await searchParams;
  if (sp.checkout === "success" && sp.session_id) {
    await reconcilePassCheckout(orgId, sp.session_id);
  }

  const [[compRow], planKey, currency, locale, [subRow], passUnderReview] = await Promise.all([
    // Presence is ROW EXISTENCE. `stripe_payment_intent` is nullable (V271) and
    // a staff-granted pass is fully active; it is selected only to tell a
    // PURCHASE from a GRANT further down, where the difference decides whether
    // a receipt and a credit can be promised at all.
    // `pass_key` names the RUNG (v17 #294) — with M and L both live, a $59
    // buyer must not be told they hold the $29 product.
    // The competition's `status`/`ends_on` decide whether the pass is still
    // APPLYING (v17 gap #301). Joined rather than queried separately so the row
    // and the verdict about it cannot be read a moment apart; the arms
    // themselves stay in `passLockReason`, which is the same predicate V338
    // enforces in SQL.
    //
    // FROM the competition, LEFT JOINing the pass (#376) — the same correction
    // the layout needed, and the same single round trip. The old INNER join
    // through `competition_passes` returned no row whatsoever for a competition
    // that had never been sold one, so `status` and `ends_on` were never read
    // and the lock could not be judged in the very case it now has to be. The
    // lock belongs to the COMPETITION; the pass row only decides which side of
    // it this org is on. `page.competition` cannot supply the two columns
    // instead: it is a cached `{id, name, slug}` slug resolution shared with
    // every other console page, and widening it would put a lifecycle read
    // behind a 60-second cache.
    sql<
      {
        purchased_at: Date | string | null;
        stripe_payment_intent: string | null;
        pass_key: string | null;
        status: string;
        ends_on: Date | string | null;
      }[]
    >`
      select cp.purchased_at, cp.stripe_payment_intent, cp.pass_key, c.status, c.ends_on
      from competitions c
      left join competition_passes cp on cp.competition_id = c.id
      where c.id = ${compId}
      limit 1`,
    // The resolver's derivation, NOT `subscriptions.plan_key` raw — see
    // lib/upgrade-page-state.ts. pass-checkout/route.ts now judges eligibility
    // through this same `isPaidPlan(orgPlanKey(...))`, so the page and the route
    // agree: a lapsed comp or a past_due org beyond its 14-day grace is both
    // OFFERED a pass here and allowed to buy it there. orgPlanKey resolves
    // through the billing group (org→subscription join) internally.
    orgPlanKey(orgId),
    preferredCurrency(orgId),
    resolveLocale(),
    // orgPlanKey() does the same org→subscription join internally but doesn't
    // expose the id, and `groupAlreadyRedeemed` below needs the group's
    // `subscriptions.id` directly (same join `creditPassTowardSubscription`
    // itself does in pass-credit.ts). `trial_used_at` rides along (v17 gap
    // #354): the Go Pro CTA below must ask the SAME question the checkout
    // does — `checkoutTrialDays` — rather than promise a trial a second,
    // independent read might disagree with.
    sql<{ id: string; trial_used_at: string | null }[]>`
      select s.id, s.trial_used_at from organizations o join subscriptions s on s.id = o.subscription_id
      where o.id = ${orgId}`,
    // A payment for THIS competition was taken and then refused by the mint
    // guard (v17 gap #326, V342). Read here rather than inferred from the
    // reconcile above, because the reconcile only runs on the return from
    // checkout and this state has to survive every later visit — including the
    // webhook-only case, where the buyer never came back through the return URL
    // at all. Without it the page renders its ordinary offer, buy button and
    // all, to someone whose money we are already holding.
    //
    // WRAPPED, defaulting to FALSE — and both halves of that are deliberate.
    //
    // WRAPPED (#326 review round 3), because this page is a READ surface with no
    // money-moving side effect that never touched `pass_mint_refusals` before
    // this feature. Deployed ahead of V342 an unwrapped read 500s the whole
    // upgrade page: "the table does not exist yet" is not the same fact as "a
    // refusal exists", and the query cannot tell them apart.
    //
    // FALSE, not true (#326 review round 4) — this reverses the default this
    // catch shipped with, for the reason the `!pass` conjunct above exists.
    // `upgrade.passUnderReview` says "Your payment for this competition went
    // through … please don't pay again". On a read failure we do not know WHO
    // that is true for, and defaulting true renders it to every viewer of every
    // pass-less competition — including everyone during the very
    // deploy-ahead-of-V342 window this catch was added for. That is the same
    // false statement about someone's money that round 2 removed, arrived at
    // through a different door, and at far greater scale.
    //
    // Defaulting false claims nothing it cannot verify. The cost is that ONE
    // genuinely refused buyer sees a buy button — and clicking it is safe,
    // because `POST /api/billing/pass-checkout` reads the same table WITHOUT a
    // catch and refuses. So the trade is "a confusing dead click for one person
    // who cannot be charged" against "a false money claim shown to everyone",
    // and the route being the authority is what makes the first one survivable.
    // `pass-checkout-plan-gate.test.ts` pins that the route read stays unwrapped
    // precisely because this default now leans on it.
    //
    // Not silent: logged AND sent to Sentry. `console.error` alone reaches no
    // pager here (no `captureConsoleIntegration` is registered), so wrapping had
    // traded a loud failure for an invisible one.
    competitionHasRefusedPassPayment(compId).catch((err) => {
      console.error(
        `[billing] could not read pass_mint_refusals for competition ${compId} — ` +
          `rendering the ordinary page and leaving the refusal to the checkout route`,
        err,
      );
      captureError(err, {
        orgId,
        route: "upgrade/page",
        extra: { competitionId: compId, read: "pass_mint_refusals" },
      });
      return false;
    }),
  ]);
  const dict = await getDictionary(locale, "ui");

  // The pass row, or null — narrowed off the joined row's own nullable columns
  // rather than off row existence, which since the LEFT JOIN above is a fact
  // about the COMPETITION. `pass_key` is `not null` on the table, so it is null
  // here only when the join found nothing; `purchased_at` is carried into the
  // narrowing as well so the non-null date every consumer below relies on is
  // established once, here, instead of asserted at each use.
  const pass =
    compRow && compRow.pass_key !== null && compRow.purchased_at !== null
      ? {
          purchased_at: compRow.purchased_at,
          stripe_payment_intent: compRow.stripe_payment_intent,
          pass_key: compRow.pass_key,
        }
      : null;

  const paidPlan = isPaidPlan(planKey);
  // Judged from the COMPETITION, with or without a pass row (#376). The old
  // `pass ? … : null` asked the question only where the answer could not
  // matter: a competition past the line that never held a pass read `null` and
  // fell through to the ordinary offer, whose Buy button the checkout route
  // answers with 410 Gone.
  const lockReason = compRow ? passLockReason(compRow.status, compRow.ends_on) : null;
  // v17 #327 — which rungs, if any, still raise something this PAID plan caps.
  // Asked only for a paid org with no pass: every rung beats community (so the
  // ordinary offer needs no query at all), and a paid org that already holds one
  // cannot buy a second for the same competition. The answer comes from
  // `plan_entitlements`, which is the same table the comparison below renders,
  // so the page cannot offer a column it would then show as no improvement.
  const exceedingRungs =
    paidPlan && !pass
      ? ((await rungsExceedingPlan(PASS_KEYS, planKey)) as PassKey[])
      : [];
  const state = upgradePageState({
    paidPlan,
    hasPass: !!pass,
    lockReason,
    isOwner: page.org.role === "owner",
    feature: sp.feature ?? null,
    exceedingRungs,
  });
  /** The #327 branch: a paying customer is being shown a pass, and why. */
  const beyondPlan = state.kind === "offer" && state.beyondPlan;

  // Which rung this competition holds, if any. Unrecognised keys fall back to
  // M — the same rule the reconcile and webhook paths apply (lib/billing.ts) —
  // because a ticket naming no rung at all is worse than one naming the rung
  // every historic row actually carries.
  const heldKey = pass?.pass_key;
  const heldRung: PassKey = isPassKey(heldKey) ? heldKey : "event_pass";

  // A paid org that HOLDS a pass which beats its plan (#337). Since V344 that
  // pass is not dormant — the resolver takes the better of the two per axis —
  // so the panel's "your plan already includes every Event Pass feature" would
  // be a plain falsehood for an L holder on Pro, on the one screen that exists
  // to explain what they have.
  const heldExceeds = paidPlan && !!pass && (await passExceedsPlan(heldRung, planKey));

  // A paid org is compared against ITS OWN plan, never against a pass column —
  // rendering the $29 column for a Pro reader is the soft version of the same
  // downgrade sale.
  //
  // Both rungs appear only while both are still BUYABLE. Once a pass is held,
  // the other rung is dropped: there is no M→L upgrade path (#294 open Q3,
  // deferred by the owner), so a second pass column on the owned or ceiling
  // state would advertise a purchase this product cannot complete — the same
  // defect as the paid-plan downgrade sale, pointed the other way.
  //
  // The one paid-plan exception is #327: when a rung genuinely exceeds the plan
  // it gets a column beside it, because the whole claim being made to a paying
  // customer is "this raises something your plan caps" — and the comparison is
  // where they check that for themselves. Only the exceeding rungs, never both
  // as a matter of course: an M column beside Pro would be the downgrade sale.
  //
  // A CLOSED competition (#376) drops both rungs for a third reason, and it is
  // the one that made the table a defect rather than a stale detail: the org can
  // buy neither, at any price, because the checkout refuses the sale outright.
  // The comparison is the page's SECOND offer surface, and a pass column here
  // advertises in figures exactly what the panel above has just refused.
  const closedToPasses = state.kind === "closed";
  const columns: string[] = paidPlan
    ? ["community", planKey, ...exceedingRungs]
    : pass
      ? ["community", heldRung, "pro"]
      : closedToPasses
        ? ["community", "pro"]
        : ["community", "event_pass", "event_pass_l", "pro"];
  const [matrix, purchases] = await Promise.all([
    readMatrix(columns),
    // Only fetched where a receipt is rendered: one Stripe call per pass the ORG
    // holds, and no state but these two shows one.
    // "ended" included (v17 gap #301): the purchase is still a purchase.
    // Nothing bought is deleted, and the receipt is the concrete proof of that
    // on the one screen where an org is being told its pass has stopped
    // working.
    state.kind === "owned" || state.kind === "ceiling" || state.kind === "ended"
      ? getPassPurchases(orgId)
      : Promise.resolve<PassPurchaseRow[]>([]),
  ]);
  const receipt = purchases.find((p) => p.competitionId === compId) ?? null;

  // The ladder the stub offers (v17 #294 / spec A7). Caps come out of the SAME
  // `matrix` the comparison table below renders from, so the two halves of this
  // page cannot quote different limits for the same rung. Only ever rendered in
  // the `offer` state — a paid org's `columns` has no pass rows at all, and the
  // ticket it gets is the held stub or nothing.
  const rungCaps = (planKey: PassKey) => ({
    entrants: matrix.get(planKey)?.get("entrants.per_division.max")?.int ?? null,
    divisions: matrix.get(planKey)?.get("divisions.per_competition.max")?.int ?? null,
  });
  const ladderOptions: PassRungOption[] = passLadderOptions(currency, {
    event_pass: rungCaps("event_pass"),
    event_pass_l: rungCaps("event_pass_l"),
  })
    // #327: a paid org is offered ONLY the rungs that beat its plan. Filtering
    // here rather than in `passLadderOptions` keeps the ladder itself a pure
    // function of price and caps — and it is not cosmetic: `rungCaps` reads the
    // matrix, which for a paid org carries only the exceeding rungs, so an
    // unfiltered ladder would quote the missing rung's caps as `null` and
    // advertise "unlimited" for a rung it never loaded.
    .filter((o) => !beyondPlan || exceedingRungs.includes(o.key));


  const purchasedAt = pass ? new Date(pass.purchased_at) : null;
  // Every qualifier the credit line makes is checked here rather than hedged in
  // the copy: `server/usecases/pass-credit.ts` gives a staff grant no credit at
  // all (`unpaid_pass`, null intent), nothing outside the window
  // (`outside_window`, inclusive at 30 days), and nothing to a group that has
  // already spent its one lifetime credit against a different pass
  // (`groupAlreadyRedeemed`). Saying it anyway would be a promise the checkout
  // will not keep. `subRow` should always exist — every org has a group — but
  // a missing row is treated as ineligible rather than assumed, matching this
  // page's existing defensive style.
  const subscriptionId = subRow?.id ?? null;
  // v17 gap #354 — the SAME predicate the embedded checkout builds its
  // `trial_period_days` from (lib/billing.ts): an org whose `trial_used_at`
  // is already set must not be promised a trial the checkout will not grant.
  const trialAvailable = checkoutTrialDays(subRow) > 0;
  const creditEligible =
    !!pass?.stripe_payment_intent &&
    !!purchasedAt &&
    withinCreditWindow(purchasedAt) &&
    !!subscriptionId &&
    !(await groupAlreadyRedeemed(subscriptionId));

  const ceilingFeature = state.kind === "ceiling" ? state.feature : null;
  const title =
    state.kind === "paid_plan"
      ? t(dict, "upgrade.titlePlan", { name: page.competition.name })
      : pass
        ? t(dict, "upgrade.titleOwned", { name: page.competition.name })
        : t(dict, "upgrade.title", { name: page.competition.name });

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="page-title">{title}</h1>

      {/* Said BEFORE the ticket: the buy control below is refused server-side
          (409) while this is true, and a control that fails after the click is
          exactly the dead end this sentence exists to remove. Amber rather than
          red — nothing the reader did is wrong, and their money is not lost.

          `&& !pass` is NOT belt-and-braces, and the state it excludes is the one
          the alert email's own remedy walks staff into (#326 review round 2).
          The alert says "record the pass at the rung actually paid for", and
          stamping `pass_mint_refusals.resolved_at` is a SEPARATE manual step
          with no UI — so "pass granted, refusal not yet resolved" is not just
          reachable, it is the expected intermediate state of the documented
          fix. Without this conjunct the page tells a customer who has just been
          made whole that we are holding their money and will refund them,
          directly above their active pass ticket: a false statement about
          someone's money, which is worse than the silence this banner replaced.

          Ordered `passUnderReview && !pass` rather than the reverse only so the
          rare flag short-circuits first; both are already in hand. */}
      {passUnderReview && !pass && (
        <p
          role="status"
          className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          {t(dict, "upgrade.passUnderReview")}
        </p>
      )}

      {/* v17 #327 — a PAYING customer is being shown a pass, which needs saying
          out loud. Without this line the page reads as an upsell to someone who
          has already bought the bigger thing; with it, the claim is specific and
          the comparison table underneath is where they check it. Rendered above
          the ticket because it is the reason the ticket is there at all. */}
      {beyondPlan && (
        <p className="mt-4 rounded-xl bg-slate-100 px-4 py-3 text-sm text-slate-700">
          {t(dict, "upgrade.beyondPlan", { plan: planLabel(planKey) })}
        </p>
      )}

      {state.kind === "paid_plan" ? (
        <PlanPanel
          dict={dict}
          planKey={planKey}
          orgSlug={orgSlug}
          orgName={page.org.name}
          holdsPass={!!pass}
          passAdds={heldExceeds}
        />
      ) : state.kind === "closed" ? (
        <ClosedPanel
          dict={dict}
          state={state}
          nextEditionHref={routes.competitionNew(orgSlug)}
          settingsHref={routes.competitionSettings(orgSlug, compSlug)}
        />
      ) : (
        <Ticket
          dict={dict}
          locale={locale}
          state={state}
          currency={currency}
          competitionId={compId}
          competitionName={page.competition.name}
          orgName={page.org.name}
          receipt={receipt}
          purchasedAt={purchasedAt}
          granted={!!pass && !pass.stripe_payment_intent}
          heldRung={heldRung}
          ladderOptions={ladderOptions}
        />
      )}

      <Comparison
        dict={dict}
        columns={columns}
        matrix={matrix}
        // Whichever pass columns are on screen: both while both are for sale,
        // the held one afterwards. Derived rather than listed so it can never
        // name a column `columns` does not have.
        highlight={paidPlan && !beyondPlan ? null : columns.filter(isPassKey)}
        ceilingFeature={ceilingFeature}
      />

      {/* The table shows each offer's OWN matrix, which for a paying reader is
          half the story: beside Pro's uncapped divisions and 2% fee, L's 20 and
          5% read as a downgrade they are about to buy. They are not — the
          resolver takes the better of the two per axis (V344), so the only line
          that changes for this reader is the one the pass raises. Said here
          rather than by rewriting the table, because the table's job is to show
          what each offer IS. */}
      {beyondPlan && (
        <p className="mt-3 text-xs text-slate-500">{t(dict, "upgrade.beyondPlanTable")}</p>
      )}

      {state.kind === "offer" && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-slate-500">
          {t(dict, "upgrade.slotNote")}
          <Tip id="billing.event-pass" small />
        </p>
      )}

      {/* `!paidPlan`, not just `kind !== "paid_plan"` (#327): the new
          beyond-plan offer IS the `offer` kind, and ProNext's whole content is
          "go Pro next" — a Pro subscriber does not need selling their own plan,
          and the pass-credit line under it promises a credit toward a first Pro
          invoice they will never have. */}
      {state.kind !== "paid_plan" && !paidPlan && (
        <ProNext
          dict={dict}
          state={state}
          currency={currency}
          orgSlug={orgSlug}
          orgName={page.org.name}
          creditEligible={creditEligible}
          trialAvailable={trialAvailable}
        />
      )}

      <p className="mt-8">
        <Link
          href={routes.competition(orgSlug, compSlug)}
          className="text-sm font-medium text-purple-700 hover:underline"
        >
          ← {t(dict, "upgrade.backToCompetition")}
        </Link>
      </p>
    </main>
  );
}

/**
 * The ticket. The page's one bold object, and the only place state is signalled:
 * the STUB carries it, which is where a real ticket carries whether it has been
 * used. Unsold it prints a price; held it goes floodlit — night, lime tick,
 * condensed caps — because that is already this console's vocabulary for "this
 * is on" (globals.css `.app-eyebrow`, the LIVE fixture treatment task 17 and
 * task 19 both used for the pass). The green box it replaces belonged to no
 * palette in this product.
 */
function Ticket({
  dict,
  locale,
  state,
  currency,
  competitionId,
  competitionName,
  orgName,
  receipt,
  purchasedAt,
  granted,
  heldRung,
  ladderOptions,
}: {
  dict: Dict;
  locale: Locale;
  /**
   * `paid_plan` and `closed` are both handled by their own panels above. The
   * exclusion is load-bearing, not tidiness: this component's stub renders
   * `<PassUpgradeButton canBuy={state.canBuy}>` in its else-branch, and
   * `closed` also carries a `canBuy`, so a `closed` state reaching here would
   * typecheck perfectly and render a Buy button on the exact page this change
   * exists to stop selling from.
   */
  state: Exclude<UpgradePageState, { kind: "paid_plan" } | { kind: "closed" }>;
  currency: Currency;
  competitionId: string;
  competitionName: string;
  orgName: string;
  receipt: PassPurchaseRow | null;
  purchasedAt: Date | null;
  granted: boolean;
  /** The rung on the pass this competition holds; ignored unless one is held. */
  heldRung: PassKey;
  /** Both rungs, smallest first. Rendered only in the unsold state. */
  ladderOptions: PassRungOption[];
}) {
  const held = state.kind === "owned" || state.kind === "ceiling";
  // A pass that is still ON THE RECORD but no longer applying (v17 gap #301).
  // Kept separate from `held` throughout rather than folded into it: the two
  // share a shape — same stub, same rung, same receipt — but say opposite
  // things about whether the org's limits are currently lifted, and every place
  // below that treats them alike is a place that would have to be re-checked if
  // that ever stopped being true.
  const ended = state.kind === "ended";

  return (
    <section
      className="pass-ticket mt-6 flex flex-col overflow-hidden rounded-2xl bg-white shadow-[0_1px_2px_rgba(21,11,54,0.06),0_18px_40px_-24px_rgba(21,11,54,0.45)] sm:flex-row"
      data-pass-ticket
    >
      <div className="flex-1 p-6 sm:p-8">
        <p className="app-eyebrow">{t(dict, "upgrade.eventPass")}</p>
        <h2 className="app-display mt-3 text-2xl font-bold text-slate-900 sm:text-3xl">
          {competitionName}
        </h2>
        <p className="mt-1 text-sm text-slate-500">{orgName}</p>

        {state.kind === "ceiling" ? (
          <>
            <p className="mt-5 text-sm font-semibold text-slate-900">
              {t(dict, "upgrade.ceiling.title")}
            </p>
            <p className="mt-1 text-sm text-slate-600">
              {t(
                dict,
                state.liftable ? "upgrade.ceiling.included" : "upgrade.ceiling.notIncluded",
              )}
            </p>
          </>
        ) : state.kind === "ended" ? (
          <>
            <p className="mt-5 text-sm font-semibold text-slate-900">
              {t(dict, "pass.entry.ended")}
            </p>
            {/* Through the shared Record, never a `state.reason === "terminal"
                ? … : …` here. The ternary keeps compiling when a third reason
                joins PASS_LOCK_REASONS and quietly files it under "ran past its
                end date" — the wrong sentence AND the wrong next step, since
                one of those two points at the end date and the other does not.
                Keyed lookup makes that a compile error instead. */}
            <p className="mt-1 text-sm text-slate-600">
              {t(dict, PASS_LOCK_REASON_KEY[state.reason])}
            </p>
          </>
        ) : (
          <p className="mt-5 text-sm text-slate-600">
            {t(dict, held ? "upgrade.active.body" : "upgrade.intro")}
          </p>
        )}
      </div>

      {/* The perforation: a dashed rule with a punched bite at each end.
          Vertical between body and stub on desktop, horizontal when the stub
          stacks underneath. See globals.css `.ticket-seam`. */}
      <div className="ticket-seam" aria-hidden />

      <div className="ticket-stub flex flex-col justify-center gap-3 p-6 text-center sm:w-56 sm:p-7">
        {held || ended ? (
          <div data-pass-active={held || undefined} data-pass-ended={ended || undefined}>
            {/* `.app-eyebrow` is the console's floodlit "this is on" device —
                condensed caps with a lime tick. An ended pass gets the plain
                muted treatment instead: wearing the lit one over "Event Pass
                ended" would contradict the words inside it, and on this stub
                the badge is read before the prose. */}
            <p
              className={
                ended
                  ? "justify-center text-[0.6875rem] font-semibold uppercase tracking-wide text-white/70"
                  : "app-eyebrow justify-center"
              }
            >
              {t(dict, ended ? "pass.entry.ended" : "upgrade.active.title")}
            </p>
            {/* WHICH pass. Two rungs are live (#294) and they differ by more
                than money — an L holder reading only "Event Pass active" cannot
                tell whether the 20-division ceiling they were sold is the one
                this competition actually has.

                The attribute carries the KEY, matching the dashboard seal and
                <CompetitionPassEntry>. It was a valueless flag here, so
                `[data-pass-held-rung="event_pass_l"]` — which is how the other
                two are selected — silently matched nothing on this page: a
                selector that can only ever be wrong, never red. */}
            <p
              data-pass-held-rung={heldRung}
              className={`app-display mt-2 text-sm font-bold ${ended ? "text-white/80" : "text-lime-300"}`}
            >
              {t(dict, PASS_RUNG_NAME_KEY[heldRung])}
            </p>
            {purchasedAt && (
              <p className="mt-3 text-xs text-white/70">
                {t(dict, granted ? "upgrade.owned.granted" : "upgrade.owned.bought", {
                  date: purchasedAt.toLocaleDateString(locale, {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  }),
                })}
              </p>
            )}
            {/* The amount is deliberately NOT reprinted here. It is on the
                receipt, one click away, and a large "$29" on a stub that used
                to carry a price reads as a price — on the one page whose worst
                possible failure is selling the same pass twice. Holding that
                invariant ("no price anywhere once a pass is held") is worth
                more than a figure the buyer already knows. */}
            {/* Only ever a real Stripe-hosted invoice. A grant has none because
                nothing was charged; a Stripe read that failed has none because
                we could not look — and a dead "receipt" link is worse than the
                sentence that explains why there isn't one. */}
            {receipt?.hostedInvoiceUrl ? (
              <a
                href={receipt.hostedInvoiceUrl}
                target="_blank"
                rel="noreferrer"
                data-pass-receipt
                className="mt-3 inline-block text-xs font-semibold text-lime-300 underline underline-offset-2 hover:text-lime-200"
              >
                {t(dict, "upgrade.owned.receipt")} ↗
              </a>
            ) : (
              !granted && (
                <p className="mt-3 text-xs text-white/60">
                  {t(dict, "upgrade.owned.receiptPending")}
                </p>
              )
            )}
          </div>
        ) : (
          // Two rungs means two prices, so the stub's single hero figure is
          // gone: it could only ever have been honest about one of them, and a
          // buyer choosing between sizes compares prices side by side. Each
          // rung now carries its own, and the ladder is the price display.
          <PassUpgradeButton
            competitionId={competitionId}
            options={ladderOptions}
            currency={currency}
            dict={dict}
            canBuy={state.canBuy}
          />
        )}
      </div>
    </section>
  );
}

/**
 * Past the line, nothing ever bought (#376). Deliberately NOT the ticket: the
 * ticket renders a rung name, a purchase date and a receipt stub, and all
 * three would be invented here. A plain card says the true thing and offers
 * the one next step that exists.
 */
function ClosedPanel({
  dict,
  state,
  nextEditionHref,
  settingsHref,
}: {
  dict: Dict;
  state: Extract<UpgradePageState, { kind: "closed" }>;
  nextEditionHref: string;
  settingsHref: string;
}) {
  // Through the Record, never `state.reason === "terminal" ? … : …` — a third
  // lock reason must break the build rather than quietly get filed under "ran
  // past its end date", which is the wrong sentence AND the wrong next step.
  const links: Record<PassLockReason, { href: string; label: DictionaryKey }> = {
    terminal: { href: nextEditionHref, label: "pass.entry.ended.nextEdition" },
    past_ends_on: { href: settingsHref, label: "pass.entry.closed.updateEndDate" },
  };
  const link = links[state.reason];
  return (
    <section className="card mt-6 p-6" data-pass-closed-panel data-pass-closed-reason={state.reason}>
      <h2 className="app-display text-lg font-bold text-slate-900">
        {t(dict, "upgrade.closed.title")}
      </h2>
      <p className="mt-2 text-sm text-slate-600">{t(dict, PASS_CLOSED_REASON_KEY[state.reason])}</p>
      {/* Only for someone who can act on it. `canBuy` is the page's one word
          for "this viewer is the owner", and both next steps here — creating
          next season's competition, moving this one's end date — are owner
          work; a link an admin can only be refused by is a second dead end
          under a card that exists to remove one. */}
      {state.canBuy && (
        <Link
          href={link.href}
          data-pass-closed-link
          className="-my-1 mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-purple-700 underline decoration-purple-300 underline-offset-2 hover:text-purple-800 hover:decoration-purple-500"
        >
          {t(dict, link.label)} →
        </Link>
      )}
    </section>
  );
}

/**
 * The already-Pro panel. Deliberately NOT a ticket: no price, no buy button, no
 * `$29` anywhere in the subtree. A Pro reader is told what their plan already
 * does for this competition and where to manage it, and — if the competition
 * happens to hold a pass from before the upgrade — that the pass is still
 * theirs, because it survives a downgrade (U15) and a silent page would read as
 * if the $29 had been absorbed.
 */
function PlanPanel({
  dict,
  planKey,
  orgSlug,
  orgName,
  holdsPass,
  passAdds,
}: {
  dict: Dict;
  planKey: string;
  orgSlug: string;
  orgName: string;
  holdsPass: boolean;
  /** The held pass beats this plan on some axis (#337) — so it is not dormant,
   *  and the panel must not claim the plan already includes everything. */
  passAdds: boolean;
}) {
  return (
    <section
      data-plan-covered
      className="mt-6 overflow-hidden rounded-2xl bg-[linear-gradient(135deg,var(--mk-night),var(--mk-night-2))] p-6 text-cream shadow-[0_18px_40px_-24px_rgba(21,11,54,0.45)] sm:p-8"
    >
      <p className="app-eyebrow !text-cream">{t(dict, "upgrade.pro.title")}</p>
      <h2 className="app-display mt-3 text-2xl font-bold sm:text-3xl">{planLabel(planKey)}</h2>
      <p className="mt-3 max-w-xl text-sm text-white/75">
        {t(dict, passAdds ? "upgrade.pro.bodyPassAdds" : "upgrade.pro.body", { org: orgName })}
      </p>
      {holdsPass && (
        <p data-pass-dormant className="mt-3 max-w-xl text-sm text-white/60">
          {t(dict, "upgrade.pro.dormantPass")}
        </p>
      )}
      <Link
        href={routes.billing(orgSlug)}
        className="btn btn-ghost mt-5 inline-block border-white/25 bg-white/10 px-5 py-2.5 text-cream hover:bg-white/20"
      >
        {t(dict, "upgrade.pro.billingCta")} →
      </Link>
    </section>
  );
}

/**
 * What actually changes, in figures, for the competition in the URL.
 *
 * A table because the content genuinely is a grid — three plans against nine
 * limits — and a reader deciding between them compares down a column. The
 * figures are `tabular-nums` so they line up like a scoreboard rather than
 * drifting by digit width.
 */
function Comparison({
  dict,
  columns,
  matrix,
  highlight,
  ceilingFeature,
}: {
  dict: Dict;
  columns: string[];
  matrix: Matrix;
  /** Plan columns to emphasise, or null when nothing is being sold. */
  highlight: string[] | null;
  ceilingFeature: string | null;
}) {
  const sold = (planKey: string) => !!highlight?.includes(planKey);
  const heading = (planKey: string) =>
    planKey === "community"
      ? t(dict, "upgrade.compare.free")
      : planKey === "event_pass"
        ? t(dict, "upgrade.compare.pass")
        : planKey === "event_pass_l"
          ? t(dict, "upgrade.compare.passL")
          : planLabel(planKey);

  return (
    <section className="mt-8">
      <h2 className="app-eyebrow">{t(dict, "upgrade.compare.title")}</h2>
      {/* Wide content scrolls inside its own container; the page body never
          scrolls sideways (v3/02 pattern 4).

          Focusable and named, because at 375 px this container really does
          overflow and its only content is a table — nothing inside it can take
          focus, so a keyboard user had no way to scroll it and axe flagged
          `scrollable-region-focusable` (serious) on the mobile audit added in
          task 22. `role="region"` + the section's own heading text is what
          turns the tab stop into something a screen reader can announce. */}
      <div
        className="mt-3 overflow-x-auto"
        tabIndex={0}
        role="region"
        aria-label={t(dict, "upgrade.compare.title")}
      >
        <table className="w-full min-w-[22rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-purple-100">
              <th scope="col" className="py-2 pr-3 text-left font-normal text-slate-500">
                <span className="sr-only">{t(dict, "upgrade.compare.rowHeader")}</span>
              </th>
              {columns.map((planKey) => (
                <th
                  key={planKey}
                  scope="col"
                  // The column's PLAN KEY, not its label. `upgrade.compare.*`
                  // is copy and copy gets renamed — "Event Pass" became
                  // "Event Pass M" the day the L rung landed, which silently
                  // emptied the downgrade-sale guard that had been matching on
                  // the heading text (f70b8e52). A guard has to name the thing
                  // that is being sold, and that is the key.
                  data-compare-col={planKey}
                  className={`w-20 px-2 py-2 text-center text-xs font-semibold uppercase tracking-wider sm:w-24 ${
                    sold(planKey) ? "text-purple-700" : "text-slate-400"
                  }`}
                >
                  {heading(planKey)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PASS_COMPARE_ROWS.map((row) => {
              const isCeiling = rowCovers(row, ceilingFeature);
              return (
                <tr
                  key={row.labelKey}
                  data-ceiling-row={isCeiling || undefined}
                  className={`border-b border-slate-100 last:border-0 ${
                    isCeiling ? "bg-lime-50/70" : ""
                  }`}
                >
                  <th
                    scope="row"
                    className="py-2.5 pr-3 text-left text-sm font-normal text-slate-600"
                  >
                    {isCeiling && (
                      <span
                        aria-hidden
                        className="mr-2 inline-block h-3 w-1 rounded-full align-middle bg-lime-400"
                      />
                    )}
                    {t(dict, row.labelKey)}
                  </th>
                  {columns.map((planKey) => (
                    <td
                      key={planKey}
                      className={`px-2 py-2.5 text-center tabular-nums ${
                        sold(planKey)
                          ? "bg-purple-50/60 font-semibold text-purple-900"
                            : "text-slate-600"
                      }`}
                    >
                      <Cell
                        dict={dict}
                        cell={compareCell(row.kind, matrix.get(planKey)?.get(row.features[0]))}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
            <tr>
              <th scope="row" className="py-2.5 pr-3 text-left text-sm font-normal text-slate-600">
                {t(dict, "upgrade.compare.appliesTo")}
              </th>
              {columns.map((planKey) => (
                <td
                  key={planKey}
                  className={`px-2 py-2.5 text-center text-xs ${
                    sold(planKey)
                      ? "bg-purple-50/60 font-semibold text-purple-900"
                        : "text-slate-500"
                  }`}
                >
                  {/* Both rungs upgrade ONE competition — the difference is how
                      big that competition may get, never how many it covers.
                      An L column reading "every competition" would promise a
                      subscription for $59. */}
                  {t(
                    dict,
                    isPassKey(planKey) ? "upgrade.compare.thisComp" : "upgrade.compare.everyComp",
                  )}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Cell({ dict, cell }: { dict: Dict; cell: CompareCell }) {
  if (cell.type === "value") return <>{cell.text}</>;
  if (cell.type === "unlimited") return <>{t(dict, "upgrade.compare.unlimited")}</>;
  if (cell.type === "yes")
    return (
      <span title={t(dict, "upgrade.compare.included")}>
        <span aria-hidden>✓</span>
        <span className="sr-only">{t(dict, "upgrade.compare.included")}</span>
      </span>
    );
  return (
    <span title={t(dict, "upgrade.compare.excluded")} className="text-slate-300">
      <span aria-hidden>—</span>
      <span className="sr-only">{t(dict, "upgrade.compare.excluded")}</span>
    </span>
  );
}

/**
 * The step after the pass. This is the half of the page the old owned state did
 * not have at all: it confirmed a purchase and offered nothing next.
 *
 * At the ceiling it is the ONLY action, because there is nothing left to buy for
 * this competition — the same shape task 17 gave the pass-owned paywall.
 *
 * The credit sentence is task 17's wording, unchanged, and it renders only when
 * `pass-credit.ts` would actually pay it out. See `creditEligible` above.
 */
function ProNext({
  dict,
  state,
  currency,
  orgSlug,
  orgName,
  creditEligible,
  trialAvailable,
}: {
  dict: Dict;
  state: UpgradePageState;
  currency: Currency;
  orgSlug: string;
  orgName: string;
  creditEligible: boolean;
  /** v17 gap #354 — `checkoutTrialDays(sub) > 0`, read where the page fetches
   *  the org's subscription. The CTA below drops its trial clause once this
   *  is false, whatever pass state put the card on screen. */
  trialAvailable: boolean;
}) {
  const held = state.kind === "owned" || state.kind === "ceiling";
  // An ended pass reads as "already bought something here" for this panel's
  // purposes — the solid border and the "what's next" framing both still fit.
  // What it adds is the second door: the plan is not the only sensible move
  // when the competition itself is over.
  const ended = state.kind === "ended";
  const proMonthly = formatMinor(proPrice("monthly", currency), currency);

  return (
    <section className={`card mt-6 p-6 ${held || ended ? "" : "border-dashed"}`}>
      <p className="app-eyebrow">
        {t(dict, held || ended ? "upgrade.owned.nextTitle" : "upgrade.proCard.title")}
      </p>
      <p className="mt-2 text-3xl font-bold text-slate-900 tabular-nums">
        {proMonthly}
        <span className="text-base font-normal text-slate-500">{t(dict, "upgrade.perMonth")}</span>
      </p>
      {/* The ended state gets its OWN body, not the owned one. That string
          opens "The pass stays with this competition whatever you do next",
          which reads as "it still works" — directly contradicting the card
          above, which has just said the pass stopped lifting this
          competition's limits. Two claims about the same purchase, in
          opposite directions, on one screen. The ended copy says the true
          part (the pass and its receipt are still here) without the part
          that stopped being true. */}
      <p className="mt-3 max-w-xl text-sm text-slate-600">
        {t(
          dict,
          ended
            ? "pass.entry.ended.nextBody"
            : held
              ? "upgrade.owned.nextBody"
              : "upgrade.proCard.body",
          { org: orgName },
        )}
      </p>
      {/* Wrapped and wrapping: at 375px two buttons on one row would either
          overflow or squeeze, and `flex-wrap` lets the second drop under the
          first rather than shrinking both. */}
      <div className="mt-5 flex flex-wrap gap-3">
        <Link href={routes.billing(orgSlug)} className="btn btn-primary inline-block px-5 py-2.5">
          {t(dict, trialAvailable ? "upgrade.proCard.cta" : "upgrade.proCard.ctaNoTrial")} →
        </Link>
        {/* The honest alternative to a re-buy. The pass cannot be bought again
            for THIS competition (decision #248 Q4), but next season's edition
            is a new competition and can have its own — so this is the one
            place the product can still say yes. */}
        {ended && (
          <Link
            href={routes.competitionNew(orgSlug)}
            data-pass-next-edition
            className="btn btn-ghost inline-block px-5 py-2.5"
          >
            {t(dict, "pass.entry.ended.nextEdition")} →
          </Link>
        )}
      </div>
      {creditEligible && (
        <p data-pass-credit className="mt-3 text-xs text-slate-500">
          {t(dict, "upgrade.credit", { plan: "Pro" })}
        </p>
      )}
    </section>
  );
}
