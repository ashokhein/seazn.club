"use client";

import Link from "@/components/ui/console-link";
import { usePathname } from "next/navigation";
import { featurePlan, featureReason } from "@/lib/feature-copy";
import { PlanBadge } from "@/components/plan-badge";
import { usePassGateState } from "@/components/competition-pass-provider";
import { formatMinor, passPrice, proPlusPrice, proPrice } from "@/lib/currency";
import { routes } from "@/lib/routes";

/**
 * Feature keys an Event Pass lifts — every key whose `event_pass` row in
 * `plan_entitlements` beats the `community` row. Only these gates offer the
 * per-event path next to Pro; everything else sends the user to billing.
 *
 * ONE key the pass lifts is deliberately absent: `registration.fee_percent`
 * (8% → 5%). It is a deduction RATE read through `getLimit`
 * (server/usecases/registrations.ts) and never throws PaymentRequiredError, so
 * no paywall can ever render for it — listing it would be dead weight, not a
 * lost sale.
 *
 * Do not hand-edit this set against a spec doc: it drifted that way once and
 * cost the pass five paywalls. `__tests__/upgrade-gate-pass-features.test.ts`
 * derives the same set from the live matrix and fails if the two disagree.
 */
export const PASS_FEATURES = new Set([
  "divisions.per_competition.max",
  "entrants.per_division.max",
  "formats.advanced",
  "formats.double_elim",
  "realtime",
  "dashboard.player_profiles",
  "exports.branded",
  "sponsors.tiers",
  "sponsors.monetize",
  "scheduling.ai.runs_per_division.max",
]);

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

/** The competition upgrade URL when the gate renders inside a competition. */
function passHrefFromPath(pathname: string | null): string | null {
  const m = pathname?.match(/^\/o\/([^/]+)\/c\/([^/]+)(?:\/|$)/);
  if (!m || m[2] === "new") return null;
  return routes.competitionUpgrade(m[1], m[2]);
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
 *
 * Refund, currency mismatch and already-credited also decline, but each of
 * those is a state the buyer either caused or cannot act on, and naming them
 * here would turn a goodwill line into terms and conditions.
 */
const creditLine = (plan: string) =>
  `An Event Pass bought in the last 30 days comes off your first ${plan} invoice in full.`;

/**
 * Name and monthly price of the plan that actually unlocks a key.
 *
 * The two-path card can hardcode Pro — every key in PASS_FEATURES is a Pro
 * key — but the pass-owned card also renders for features the pass never
 * covered, and some of those (officials.auto, api.write, domains.custom …)
 * are Pro Plus. Reading the plan from the same helper <PlanBadge> uses keeps
 * the button from saying "Go Pro" directly beneath a PRO PLUS badge.
 */
function paidPlan(feature: string): { name: string; price: string } {
  const plus = featurePlan(feature) === "pro_plus";
  const minor = plus ? proPlusPrice("monthly", "usd") : proPrice("monthly", "usd");
  return { name: plus ? "Pro Plus" : "Pro", price: `${formatMinor(minor, "usd")}/mo` };
}

/**
 * THE upgrade-moment component (doc 10 §3): one contextual paywall, rendered
 * exactly where a limit bites — adding a division, toggling ball-by-ball,
 * publishing a 2nd dashboard, enabling DLS, creating an API key. The copy
 * derives from the same feature_key the 402 response carries, so a blocked
 * server call and a pre-emptively gated control read identically.
 *
 * Four states (spec 2026-07-21 D1), off ONE signal from the competition layout:
 *
 * | pass gate state | feature liftable | renders                              |
 * |-----------------|------------------|--------------------------------------|
 * | none            | yes              | Event Pass + Pro                     |
 * | none            | no               | Pro only (as before)                 |
 * | held            | yes              | Pro only — pass ceiling              |
 * | held            | no               | Pro only — not on pass               |
 * | paid_plan       | either           | Pro only (as before) — pass is moot  |
 *
 * `held` is task 17's fix: a gate rendering for a key the pass DOES lift, while
 * a pass is active, means the buyer has used everything that $29 bought.
 * Offering it again sells them the same thing twice and leaves them blocked.
 *
 * `paid_plan` is the row that fix left open. A paid org has no pass row, so the
 * old boolean read false and the $29 CTA rendered — selling a DOWNGRADE, since
 * the pass grants 10 AI runs per division against pro's 20, and 64 entrants per
 * division against pro's 256. It renders the plain Pro-only card, byte for byte
 * what an org-level page has always shown: nothing here is a new state, the
 * pass path is simply not on offer.
 *
 * It deliberately does NOT render the pass-owned card even when the org does
 * hold a pass — see usePassGateState for why the plan wins.
 */
export function UpgradeGate({ feature, href = "/settings/billing", compact = false }: Props) {
  const reason = featureReason(feature);
  const pathname = usePathname();
  // "none" outside a competition (no provider) — org-level gates are untouched.
  const gate = usePassGateState();
  const passOwned = gate === "held";
  const liftable = PASS_FEATURES.has(feature);
  // Only an org that can still BENEFIT from a pass is offered one.
  const passHref = liftable && gate === "none" ? passHrefFromPath(pathname) : null;

  if (compact) {
    return (
      <Link
        href={passHref ?? href}
        data-feature={feature}
        data-pass-owned={passOwned || undefined}
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
    const plan = paidPlan(feature);
    return (
      <div
        data-feature={feature}
        data-pass-owned
        className="rounded-lg border border-purple-200 bg-purple-50 p-4 text-sm text-purple-900"
      >
        {/* The console's floodlit signal for "this is on" (globals.css
            .app-eyebrow: condensed caps, lime tick). Same device as a LIVE
            fixture — the state is read before the refusal is. */}
        <p className="app-eyebrow">Event Pass active</p>
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
          {plan.name} covers every competition in your organization. {creditLine(plan.name)}
        </p>
      </div>
    );
  }

  if (passHref) {
    const passLabel = `${formatMinor(passPrice("usd"), "usd")} one-time`;
    const proLabel = `${formatMinor(proPrice("monthly", "usd"), "usd")}/mo`;
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
            Upgrade this event — {passLabel}
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
