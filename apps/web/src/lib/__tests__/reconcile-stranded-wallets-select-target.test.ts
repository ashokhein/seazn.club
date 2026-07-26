// Pure-function coverage for `chooseReconcileTarget`
// (scripts/reconcile-stranded-wallets.ts, #285 one-off staging cleanup).
//
// The script must never GUESS which org a stranded wallet belongs to — a
// wallet with no spend attribution at all is reported for manual review,
// not merged on a hunch. This pins that decision directly, the same way
// `isBalanceHistoryTruncated` is pinned in pass-credit-backfill-truncation.
// test.ts without touching Postgres.
import { describe, expect, it } from "vitest";
import { chooseReconcileTarget } from "../../../../../scripts/reconcile-stranded-wallets";

describe("chooseReconcileTarget", () => {
  it("returns null when nothing carries a spend attribution", () => {
    expect(chooseReconcileTarget([])).toBeNull();
    expect(chooseReconcileTarget([{ spent_by_org_id: null }, { spent_by_org_id: null }])).toBeNull();
  });

  it("returns the first (most recent, given created_at desc ordering) attributed org", () => {
    expect(
      chooseReconcileTarget([
        { spent_by_org_id: "org-newest" },
        { spent_by_org_id: "org-older" },
      ]),
    ).toBe("org-newest");
  });

  it("skips leading nulls to find the first real attribution", () => {
    expect(
      chooseReconcileTarget([{ spent_by_org_id: null }, { spent_by_org_id: "org-x" }]),
    ).toBe("org-x");
  });
});
