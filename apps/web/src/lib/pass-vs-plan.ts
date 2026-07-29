import "server-only";
import { sql } from "@/lib/db";

/**
 * Does an Event Pass rung lift anything the org's PLAN does not already give it?
 * (v17 gap #327.)
 *
 * Shipping the L rung (#294) broke the assumption every pass surface was built
 * on. Pro was a strict superset of the pass, so under a paid plan the pass was
 * moot and the product refused to sell one. That stopped being true:
 *
 *   | | entrants.per_division.max | divisions.per_competition.max |
 *   |---|---|---|
 *   | Pro | 256 | unlimited |
 *   | Event Pass M | 128 | 10 |
 *   | Event Pass L | **unlimited** | 20 |
 *
 * Neither contains the other. A Pro organiser running one division with more
 * than 256 entrants had no self-serve path at all: the checkout refused them and
 * the upgrade page told them their plan already covered it.
 *
 * Owner decision: open the gate where — and only where — the rung genuinely
 * exceeds the plan. Not "L is special": the comparison is computed from
 * `plan_entitlements`, so it stays true when either side is repriced, and it
 * closes again by itself if Pro's entrant cap is ever lifted.
 */

/**
 * Feature keys where a LOWER number is the better entitlement.
 *
 * Everything else in this table is a CAP, where higher is better and null means
 * unlimited. `registration.fee_percent` is the exception and it is the exception
 * that costs money: community 8%, Pro 2%, both pass rungs 5%. Comparing it with
 * the cap rule would call the pass's 5% "better" than Pro's 2% and then, once
 * the resolver overlays it, charge a Pro organiser 5% on every entry fee for
 * their passed competition. A pass must never make an org worse off, and on
 * this one key "better" means smaller.
 */
const LOWER_IS_BETTER = new Set(["registration.fee_percent"]);

/**
 * The better of two `int_value`s for a feature, from the ORG's point of view.
 *
 * Null is asymmetric by design, because the column overloads it:
 *
 *  - On a cap, null means UNLIMITED — the best possible answer, and it wins.
 *  - On a lower-is-better key, "unlimited fee" is meaningless. Null there is no
 *    answer at all, so the other side wins; two nulls stay null.
 */
export function betterInt(
  featureKey: string,
  a: number | null,
  b: number | null,
): number | null {
  if (LOWER_IS_BETTER.has(featureKey)) {
    if (a === null) return b;
    if (b === null) return a;
    return Math.min(a, b);
  }
  if (a === null || b === null) return null;
  return Math.max(a, b);
}

/** True when `a` is a strictly better answer than `b` for this feature. */
export function intIsBetter(featureKey: string, a: number | null, b: number | null): boolean {
  return a !== b && betterInt(featureKey, a, b) === a;
}

export interface EntitlementRow {
  feature_key: string;
  bool_value: boolean | null;
  int_value: number | null;
}

/**
 * Does `passRows` beat `planRows` on at least one feature?
 *
 * Pure, so the rule is testable without a database and so the checkout gate and
 * the upgrade page cannot answer it differently.
 *
 * A key the PLAN does not carry at all is not evidence of anything: the plan
 * matrix is sparse, and a missing row already falls through to `false`/0 in the
 * resolver rather than meaning "unlimited". Only keys present on both sides are
 * compared — the axes the two offers actually both speak about.
 */
export function passBeatsPlan(passRows: EntitlementRow[], planRows: EntitlementRow[]): boolean {
  const plan = new Map(planRows.map((r) => [r.feature_key, r]));
  for (const pass of passRows) {
    const row = plan.get(pass.feature_key);
    if (!row) continue;
    // A pass GRANTS, it never revokes: only `pass true, plan not true` counts.
    if (pass.bool_value === true && row.bool_value !== true) return true;
    // Bool keys carry null ints on both sides, which `intIsBetter` reports as
    // no difference — so this line is about caps and fees only.
    if (intIsBetter(pass.feature_key, pass.int_value, row.int_value)) return true;
  }
  return false;
}

/**
 * The DB-backed form: may this org's plan still be improved by this rung?
 *
 * `planKey` must be the RESOLVED plan (`orgPlanKey`), never
 * `subscriptions.plan_key` raw — a lapsed comp or a cancelled subscription
 * keeps saying 'pro' in the column while the resolver has already put the org
 * back on community, and this answer decides whether money may change hands.
 */
export async function passExceedsPlan(passKey: string, planKey: string): Promise<boolean> {
  const rows = await sql<(EntitlementRow & { plan_key: string })[]>`
    select plan_key, feature_key, bool_value, int_value
      from plan_entitlements
     where plan_key in (${passKey}, ${planKey})`;
  return passBeatsPlan(
    rows.filter((r) => r.plan_key === passKey),
    rows.filter((r) => r.plan_key === planKey),
  );
}

/**
 * Which of `passKeys` still beat this plan — ONE query for the whole ladder.
 *
 * The per-rung form above reads the plan's matrix again for every rung, and the
 * two surfaces that need the whole answer (the competition layout, which
 * decides whether to show the buy chip at all, and the upgrade page, which
 * decides which columns to render) sit on hot paths. Same rule, same table, one
 * round trip.
 */
export async function rungsExceedingPlan(
  passKeys: readonly string[],
  planKey: string,
): Promise<string[]> {
  const rows = await sql<(EntitlementRow & { plan_key: string })[]>`
    select plan_key, feature_key, bool_value, int_value
      from plan_entitlements
     where plan_key in ${sql([...passKeys, planKey])}`;
  const planRows = rows.filter((r) => r.plan_key === planKey);
  return passKeys.filter((k) =>
    passBeatsPlan(
      rows.filter((r) => r.plan_key === k),
      planRows,
    ),
  );
}

/**
 * Which rungs this org may still be SOLD — the question every buy surface asks.
 *
 * On a free plan that is the whole ladder, and no query is run. On a paid plan
 * it is only the rungs that beat it (#327) — which is what stops a Pro organiser
 * being quoted "from $29" when the only thing they can actually buy is the $59
 * L. Quoting one rung's price as the price of the product is precisely the
 * mis-sale #294's "from" wording exists to prevent, and a price for a rung the
 * checkout would refuse is a worse version of it.
 *
 * `planKey` must be the RESOLVED plan, for the reason `passExceedsPlan` gives.
 */
export async function sellablePassRungs(
  passKeys: readonly string[],
  planKey: string,
  isPaid: boolean,
): Promise<string[]> {
  return isPaid ? rungsExceedingPlan(passKeys, planKey) : [...passKeys];
}
