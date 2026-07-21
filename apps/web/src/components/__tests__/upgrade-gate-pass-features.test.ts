// <UpgradeGate>'s PASS_FEATURES is the ONLY thing standing between a blocked
// user and the $29 path: a key missing from it renders the Pro-only card, so
// the pass that would have unblocked them is never offered. It is hand-written
// prose about a database table, and it drifted — it carried three keys the pass
// does not lift (`registration.paid`, `branding`, and `exports`, which is not
// even a gate key) while five real ones (player profiles, branded exports, both
// sponsor keys and the AI run cap) were missing.
//
// So stop hand-maintaining it against a spec doc. This derives the lifted set
// from the live `plan_entitlements` matrix — the same query
// lib/__tests__/pass-scoping-guard.test.ts uses — and fails when the component
// disagrees with it.
//
// Real Postgres required; skipped without DATABASE_URL (CI sets it, see
// .github/workflows/ci.yml).
import { afterAll, describe, expect, it } from "vitest";
import { PASS_FEATURES } from "@/components/upgrade-gate";
import { featureReason } from "@/lib/feature-copy";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

/**
 * The one key the pass lifts that must NOT be offered a paywall.
 *
 * `registration.fee_percent` (8% → 5%) is a deduction RATE, not a gate: it is
 * read with `getLimit` at server/usecases/registrations.ts and folded into the
 * payout, so it never throws PaymentRequiredError and no <UpgradeGate> can ever
 * be rendered for it. It is named here, rather than subtracted silently, so a
 * future reader can tell a deliberate exclusion from an oversight — and so that
 * a key which STARTS throwing 402 has to be removed from this list on purpose.
 */
const NOT_A_GATE = new Set(["registration.fee_percent"]);

describe.skipIf(!HAS_DB)("UpgradeGate offers the pass for every key the pass lifts", () => {
  // Same derivation as the pass-scoping guard: a key whose event_pass value
  // equals the community value is a no-op grant (the pass overlay falls
  // through to the community row for anything it does not override).
  // `is distinct from` treats a missing community row (NULL) as different,
  // which it is — no row resolves to deny/0, not to the pass value.
  const liftedKeys = async (): Promise<Set<string>> => {
    const rows = await sql<{ feature_key: string }[]>`
      select ep.feature_key
      from plan_entitlements ep
      left join plan_entitlements c
        on c.plan_key = 'community' and c.feature_key = ep.feature_key
      where ep.plan_key = 'event_pass'
        and (ep.bool_value is distinct from c.bool_value
             or ep.int_value is distinct from c.int_value)`;
    const keys = new Set(rows.map((r) => r.feature_key));
    // A guard that derives an empty set reports clean. Fail loudly instead.
    expect(keys.size).toBeGreaterThan(0);
    return keys;
  };

  it("matches the live event_pass column exactly, minus the one non-gate key", async () => {
    const lifted = await liftedKeys();
    const gateable = [...lifted].filter((k) => !NOT_A_GATE.has(k)).sort();

    // DO NOT fix a red run by deleting keys from PASS_FEATURES or by widening
    // NOT_A_GATE. Red on the left-hand side means users are being shown the
    // Pro-only card at a paywall a $29 pass would clear. Red on the right-hand
    // side means the component promises a pass that lifts nothing, and the user
    // pays $29 and stays blocked.
    expect([...PASS_FEATURES].sort()).toEqual(gateable);
  });

  it("excludes only keys that no paywall can render, and says which", async () => {
    const lifted = await liftedKeys();
    for (const key of NOT_A_GATE) {
      expect(lifted, `${key} is no longer lifted — drop it from NOT_A_GATE`).toContain(key);
      expect(PASS_FEATURES.has(key)).toBe(false);
    }
  });

  it("has real paywall copy for every key it offers the pass on", async () => {
    // The gate renders featureReason(feature) above both CTAs. A key with no
    // entry falls back to "This feature needs a plan upgrade.", which reads as
    // a bug next to a priced button.
    for (const key of PASS_FEATURES) {
      expect(featureReason(key), key).not.toBe("This feature needs a plan upgrade.");
    }
  });
});
