"use client";

import Link from "@/components/ui/console-link";
import { usePathname } from "next/navigation";
import { featurePlan, featureReason } from "@/lib/feature-copy";
import { PlanBadge } from "@/components/plan-badge";
import {
  usePassCurrency,
  usePassGateState,
  usePassLockReason,
  usePassRung,
  usePassSellableRungs,
} from "@/components/competition-pass-provider";
import { formatMinor, passPrice, proPlusPrice, proPrice, type Currency } from "@/lib/currency";
import {
  lowestPassRung,
  lowestPricedRung,
  passActiveLabel,
  PASS_CLOSED_REASON_KEY,
  PASS_LOCK_REASON_KEY,
} from "@/lib/pass-ladder";
import { PASS_FEATURES } from "@/lib/pass-features";
import { routes } from "@/lib/routes";
import { useDict, useMsg } from "@/components/i18n/dict-provider";
import { t } from "@/lib/i18n-runtime";

/**
 * Feature keys an Event Pass lifts. Only these gates offer the per-event path
 * next to Pro; everything else sends the user to billing.
 *
 * The set itself lives in `@/lib/pass-features` because the upgrade PAGE — a
 * server component — asks the same question, and a client module's exports
 * reach the RSC graph as references rather than values. Re-exported here so
 * every existing importer of `@/components/upgrade-gate` is untouched.
 */
export { PASS_FEATURES } from "@/lib/pass-features";

interface Props {
  /** Entitlement feature key, e.g. "scoring.ball_by_ball" (doc 10 §1). */
  feature: string;
  /**
   * Where the paywall sends the user. Defaults to billing; pass a
   * plan-comparison anchor when the touchpoint has one.
   */
  href?: string;
  /** Compact renders a one-line pill (for toolbars/toggles); default is a card. */
  compact?: boolean;
}

/**
 * The competition upgrade URL when the gate renders inside a competition.
 *
 * Carries WHICH feature bit, because the upgrade page keys its ceiling state off
 * `?feature=` and nothing used to supply one — so the page's ceiling copy ("you
 * have used everything the Event Pass includes here") was unreachable in-app and
 * a user who hit a ceiling saw the generic owned card instead. The gate is the
 * only place that knows which key was refused, so it is the only place that can
 * pass it.
 */
function passHrefFromPath(pathname: string | null, feature: string): string | null {
  const m = pathname?.match(/^\/o\/([^/]+)\/c\/([^/]+)(?:\/|$)/);
  if (!m || m[2] === "new") return null;
  return `${routes.competitionUpgrade(m[1], m[2])}?feature=${encodeURIComponent(feature)}`;
}

/**
 * The credit an owned pass earns against Pro, phrased to match what
 * `server/usecases/pass-credit.ts` will actually do.
 *
 * Every qualifier in this sentence is load-bearing:
 * - "bought" — a staff-granted / comped pass has a null
 *   `stripe_payment_intent` and returns `unpaid_pass`. Nobody paid, so nothing
 *   is credited, and the copy must not say otherwise to a comped org.
 * - "in the last 30 days" — `PASS_CREDIT_WINDOW_DAYS`, inclusive.
 * - "your first Pro invoice" — it is a customer BALANCE credit, applied by
 *   Stripe to the next invoice, not a discount on the checkout total.
 * - "once per billing group" — `groupAlreadyRedeemed`, a lifetime cap.
 *
 * Refund, currency mismatch and already-credited also decline, but each of
 * those is a state the buyer either caused or cannot act on, and naming them
 * here would turn a goodwill line into terms and conditions.
 *
 * Uses the SAME dict key as the upgrade page's `upgrade.credit` (doc 2026-07-26
 * §6) rather than a second key, so the two surfaces are structurally incapable
 * of disagreeing. `<UpgradeGate>` is a client component, so this reads the key
 * through `useMsg()` — the `/o/[orgSlug]` layout already wraps this whole tree
 * in `<DictProvider>`, and `useMsg()` falls back to the English catalog outside
 * one anyway, so no new plumbing was needed.
 */
const creditLine = (msg: ReturnType<typeof useMsg>, plan: string) => msg("upgrade.credit", { plan });

/**
 * Name and monthly price of the plan that actually unlocks a key.
 *
 * The two-path card can hardcode Pro — every key in PASS_FEATURES is a Pro
 * key — but the pass-owned card also renders for features the pass never
 * covered, and some of those (officials.auto, api.write, domains.custom …)
 * are Pro Plus. Reading the plan from the same helper <PlanBadge> uses keeps
 * the button from saying "Go Pro" directly beneath a PRO PLUS badge.
 *
 * `currency` comes from the competition layout via the pass provider, and every
 * amount on one card must use it: a paywall quoting the pass in £ beside Pro in
 * $ is worse than the hardcoded usd it replaced. Outside a competition there is
 * no provider and the default is usd — exactly what this rendered before.
 */
function paidPlan(feature: string, currency: Currency): { name: string; price: string } {
  const plus = featurePlan(feature) === "pro_plus";
  const minor = plus ? proPlusPrice("monthly", currency) : proPrice("monthly", currency);
  return { name: plus ? "Pro Plus" : "Pro", price: `${formatMinor(minor, currency)}/mo` };
}

/**
 * THE upgrade-moment component (doc 10 §3): one contextual paywall, rendered
 * exactly where a limit bites — adding a division, toggling ball-by-ball,
 * publishing a 2nd dashboard, enabling DLS, creating an API key. The copy
 * derives from the same feature_key the 402 response carries, so a blocked
 * server call and a pre-emptively gated control read identically.
 *
 * Off ONE signal from the competition layout (spec 2026-07-21 D1; the `ended`
 * rows are v17 gap #301):
 *
 * | pass gate state | feature liftable | renders                              |
 * |-----------------|------------------|--------------------------------------|
 * | none            | yes              | Event Pass + Pro                     |
 * | none            | no               | Pro only (as before)                 |
 * | held            | yes              | Pro only — pass ceiling              |
 * | held            | no               | Pro only — not on pass               |
 * | ended           | either           | Pro only — pass has stopped applying |
 * | closed          | either           | Pro only — none was ever bought, and |
 * |                 |                  | none can be now                      |
 * | paid_plan       | either           | Pro only (as before) — pass is moot  |
 *
 * `held` is task 17's fix: a gate rendering for a key the pass DOES lift, while
 * a pass is active, means the buyer has used everything their pass bought.
 * Offering it again sells them the same thing twice and leaves them blocked.
 *
 * `paid_plan` is the row that fix left open. A paid org has no pass row, so the
 * old boolean read false and the pass CTA rendered — selling a DOWNGRADE, since
 * Pro's matrix is a strict superset of the pass's at every key the pass lifts.
 * It renders the plain Pro-only card, byte for byte what an org-level page has
 * always shown: nothing here is a new state, the pass path is simply not on
 * offer.
 *
 * It deliberately does NOT render the pass-owned card even when the org does
 * hold a pass — see usePassGateState for why the plan wins.
 */
export function UpgradeGate({ feature, href = "/settings/billing", compact = false }: Props) {
  const reason = featureReason(feature);
  const pathname = usePathname();
  const msg = useMsg();
  const dict = useDict();
  // "none" outside a competition (no provider) — org-level gates are untouched.
  const gate = usePassGateState();
  const heldRung = usePassRung();
  const currency = usePassCurrency();
  const lockReason = usePassLockReason();
  const sellable = usePassSellableRungs();
  const passOwned = gate === "held";
  const passEnded = gate === "ended";
  // #376 — the competition is past the pass line and never held one. Distinct
  // from `ended` in the only way that matters here: there is no purchase to
  // explain, so the ended card's sentences (all of which say a pass "has
  // stopped lifting its limits") would be claims about money this org never
  // spent. Same `lockReason` narrowing as the ended card below, for the same
  // reason: `gate === "closed"` is DERIVED from a non-null reason, so the
  // conjunct never fails in practice and exists so the Record can be indexed.
  const passClosed = gate === "closed";
  const liftable = PASS_FEATURES.has(feature);
  // Only an org that can still BENEFIT from a pass is offered one.
  const passHref = liftable && gate === "none" ? passHrefFromPath(pathname, feature) : null;

  if (compact) {
    return (
      <Link
        href={passHref ?? href}
        data-feature={feature}
        data-pass-owned={passOwned || undefined}
        data-pass-ended={passEnded || undefined}
        // Carries the REASON as its value, not a bare flag: the pill has no
        // room for the sentence, so the attribute is the only place the two
        // arms are distinguishable from outside.
        data-pass-closed-gate={(passClosed && lockReason) || undefined}
        className="inline-flex items-center gap-1.5 rounded-full bg-purple-50 px-3 py-1 text-xs font-medium text-purple-700 hover:bg-purple-100"
      >
        <LockIcon />
        <PlanBadge feature={feature} />
        {reason} <span className="font-semibold underline">Upgrade →</span>
      </Link>
    );
  }

  // The org already holds this competition's pass. One path out, and an
  // acknowledgement that they have already paid us once for this competition.
  if (passOwned) {
    const plan = paidPlan(feature, currency);
    return (
      <div
        data-feature={feature}
        data-pass-owned
        className="rounded-lg border border-purple-200 bg-purple-50 p-4 text-sm text-purple-900"
      >
        {/* The console's floodlit signal for "this is on" (globals.css
            .app-eyebrow: condensed caps, lime tick). Same device as a LIVE
            fixture — the state is read before the refusal is.

            It NAMES the rung (v17 #294). Two sizes sell at different prices and
            grant different ceilings, and the sentence below explains a refusal
            in terms of "everything the Event Pass includes here" — which
            ceiling that is depends entirely on which pass was bought. `gate ===
            "held"` is derived from the rung being non-null, so the fallback is
            unreachable; it exists so a rung is never invented. */}
        <p className="app-eyebrow">{passActiveLabel(dict, heldRung ?? "event_pass")}</p>
        <p className="mt-2 flex items-center gap-2 font-medium">
          <LockIcon />
          <PlanBadge feature={feature} />
          {reason}
        </p>
        {/* The eyebrow above already says the pass is on, so this line does
            one job: why the pass they own cannot clear THIS gate. */}
        <p className="mt-2">
          {liftable
            ? "You've used everything the Event Pass includes here."
            : "This one is not included in the Event Pass."}
        </p>
        <div className="mt-3">
          <Link href={href} className="btn btn-primary px-4 py-2 text-sm">
            Go {plan.name} — {plan.price}
          </Link>
        </div>
        <p className="mt-2 text-xs text-purple-700">
          {plan.name} covers every competition in your organization. {creditLine(msg, plan.name)}
        </p>
      </div>
    );
  }

  // v17 gap #301: the row still exists, but the resolver has already stopped
  // honouring it — this competition is back on Community caps. Deliberately its
  // own branch rather than a variant of the one above, because the two states
  // give opposite advice: `passOwned` says "your pass is on and you have used
  // all of it", which for a locked pass is false twice over. The org is at no
  // usage ceiling; the pass simply lifts nothing here any more.
  //
  // It never re-offers the purchase (decision #248 Q4 — one pass per
  // competition, forever), so the only honest path left is the plan.
  //
  // `lockReason` is non-null whenever `gate === "ended"` — usePassGateState
  // derives one from the other — so the conjunct never fails in practice. It is
  // the narrowing TypeScript needs to index PASS_LOCK_REASON_KEY, and if the
  // impossible pairing ever did arrive it degrades to the plain Pro card rather
  // than rendering a heading above a missing sentence.
  if (passEnded && lockReason) {
    const plan = paidPlan(feature, currency);
    return (
      <div
        data-feature={feature}
        data-pass-ended
        className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700"
      >
        {/* Slate, and NOT `.app-eyebrow`. That class is the console's floodlit
            "this is on" signal (condensed caps, lime tick) and the card above
            earns it; wearing it here would say the opposite of the sentence
            underneath. The purple family means "a payment lifts this" — also
            wrong, since nothing on this card is for sale. */}
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {msg("pass.entry.ended")}
        </p>
        <p className="mt-2 flex items-center gap-2 font-medium">
          <LockIcon />
          <PlanBadge feature={feature} />
          {reason}
        </p>
        {/* Keyed off the reason through the shared Record, never a
            `=== "terminal" ? … : …` here: the ternary keeps compiling when a
            third reason joins PASS_LOCK_REASONS and silently files it under
            "ran past its end date", which is the wrong sentence and the wrong
            next step. The Record is a compile error instead.

            Read through `t(dict, …)` rather than `msg(…)` like its neighbours
            because the two speak different key universes: `useMsg()` takes a
            `MessageKey` while `PASS_LOCK_REASON_KEY` is a `DictionaryKey` map,
            which is the wider set. Casting to bridge them would throw away the
            exhaustiveness this Record exists to provide. `dict` is already read
            above for the rung label, so this adds no new provider dependency. */}
        <p className="mt-2">{t(dict, PASS_LOCK_REASON_KEY[lockReason])}</p>
        <div className="mt-3">
          <Link href={href} className="btn btn-primary px-4 py-2 text-sm">
            Go {plan.name} — {plan.price}
          </Link>
        </div>
      </div>
    );
  }

  // #376: the competition itself is past the line — completed, archived, or a
  // week past its end date — and no pass was ever bought for it. Until the
  // layout judged the lock from the COMPETITION this org read `none` and was
  // shown the $29 path, which `POST /api/billing/pass-checkout` answers with
  // 410 Gone: a paywall whose one call to action was a dead end.
  //
  // Its own branch rather than a fall-through to the plain Pro card at the
  // bottom. That card renders identically whether the pass was never on offer
  // or has just been withdrawn, and this reader has very likely just come from
  // a surface that WAS offering it. Saying why it has gone is the difference
  // between an explanation and a silence.
  //
  // NOT the ended card, whose every sentence describes a purchase that stopped
  // working — false twice over here, since nothing was bought. The two sets of
  // copy are separate Records for exactly that reason.
  if (passClosed && lockReason) {
    const plan = paidPlan(feature, currency);
    return (
      <div
        data-feature={feature}
        data-pass-closed-gate={lockReason}
        className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700"
      >
        {/* Slate and plain, like the ended card and for the same reason: the
            purple family means "a payment lifts this", and nothing on this
            card is for sale. `.app-eyebrow` — the floodlit "this is on"
            device — would say the opposite of every word underneath it. */}
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {t(dict, "upgrade.closed.title")}
        </p>
        <p className="mt-2 flex items-center gap-2 font-medium">
          <LockIcon />
          <PlanBadge feature={feature} />
          {reason}
        </p>
        {/* Keyed off the reason through the shared Record, never a
            `=== "terminal" ? … : …`: the ternary keeps compiling when a third
            reason joins PASS_LOCK_REASONS and files it under the wrong
            sentence. Read through `t(dict, …)` rather than `msg(…)` because
            `useMsg()` takes the narrower `MessageKey` while the Record is a
            `DictionaryKey` map — casting to bridge them would throw away the
            exhaustiveness the Record exists to provide. */}
        <p className="mt-2">{t(dict, PASS_CLOSED_REASON_KEY[lockReason])}</p>
        <div className="mt-3">
          <Link href={href} className="btn btn-primary px-4 py-2 text-sm">
            Go {plan.name} — {plan.price}
          </Link>
        </div>
      </div>
    );
  }

  if (passHref) {
    // "from", and the FLOOR of the ladder — not M's price under a heading that
    // names the family. This card is the main inbound link to the upgrade page,
    // where the buyer meets an M/L choice; quoting one rung's price as *the*
    // price of a two-rung product is the mis-sale #294 exists to stop. The rung
    // is derived, never typed, so a discount or a third rung moves this number
    // with it (lib/pass-ladder.ts).
    // The floor of what is ACTUALLY for sale to THIS org, not the floor of the
    // ladder (#327). They are the same thing on a free plan. On Pro they are
    // not: only L beats Pro, so "from $29" would name a rung the checkout
    // refuses and send the reader to a page selling one $59 option.
    const passLabel = formatMinor(
      sellable.length > 0
        ? lowestPricedRung(sellable.map((key) => ({ key, amountMinor: passPrice(currency, key) })))
            .amountMinor
        : lowestPassRung(currency).amountMinor,
      currency,
    );
    const proLabel = `${formatMinor(proPrice("monthly", currency), currency)}/mo`;
    return (
      <div
        data-feature={feature}
        data-pass-gate
        className="rounded-lg border border-purple-200 bg-purple-50 p-4 text-sm text-purple-900"
      >
        <p className="flex items-center gap-2 font-medium">
          <LockIcon />
          <PlanBadge feature={feature} />
          {reason}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link
            href={passHref}
            className="btn btn-primary px-4 py-2 text-sm"
            data-pass-cta
          >
            {/* Localised, unlike its neighbours: this string CHANGED for #294
                (it gained "from"), and a changed string ships in four locales.
                The rest of this card is hardcoded English and predates the
                rule — pre-existing, and not this task's to rewrite. */}
            {msg("pass.gate.buy", { price: passLabel })}
          </Link>
          <Link href={href} className="btn btn-ghost px-4 py-2 text-sm">
            Go Pro — {proLabel}
          </Link>
        </div>
        <p className="mt-2 text-xs text-purple-700">
          The Event Pass upgrades this competition for its lifetime. Pro covers
          every competition in your organization.
        </p>
      </div>
    );
  }

  return (
    <div
      data-feature={feature}
      className="rounded-lg border border-purple-200 bg-purple-50 p-4 text-sm text-purple-900"
    >
      <p className="flex items-center gap-2 font-medium">
        <LockIcon />
        <PlanBadge feature={feature} />
        {reason}
      </p>
      <p className="mt-2">
        <Link href={href} className="font-semibold text-purple-700 underline">
          See plans & upgrade →
        </Link>
      </p>
    </div>
  );
}

function LockIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      fill="currentColor"
      className="h-3.5 w-3.5 shrink-0"
    >
      <path d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1.5 1.5 0 0 0-1.5 1.5v5A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 12 6h-.5V4.5A3.5 3.5 0 0 0 8 1Zm2 5H6V4.5a2 2 0 1 1 4 0V6Z" />
    </svg>
  );
}
