// Pure-function coverage for `chooseReconcileTarget`
// (scripts/reconcile-stranded-wallets.ts, #285 one-off staging cleanup).
//
// The script must never GUESS which org a stranded wallet belongs to — a
// wallet with no spend attribution at all is reported for manual review,
// not merged on a hunch. This pins that decision directly, the same way
// `isBalanceHistoryTruncated` is pinned in pass-credit-backfill-truncation.
// test.ts without touching Postgres.
import { describe, expect, it } from "vitest";
import {
  chooseReconcileTarget,
  classifyBucketAmounts,
  writeGateBlocked,
} from "../../../../../scripts/reconcile-stranded-wallets";

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

// The stranded-wallet SELECT filters on the wallet's NET balance (`<> 0`), so
// it deliberately surfaces wallets whose net is NEGATIVE — a real data
// integrity signal worth reporting. But there is nothing to move out of such a
// wallet: every insert is capped at `Math.max(0, bucketBalance)`, and the
// ledger's own `balance_after >= 0` CHECK would reject the attempt anyway.
// This decides that case BEFORE a transaction is opened and two advisory
// locks are taken for a merge that would move nothing.
describe("classifyBucketAmounts", () => {
  it("merges when either bucket carries a positive balance", () => {
    expect(classifyBucketAmounts({ grant: 10, pack: 5 })).toBe("merge");
    expect(classifyBucketAmounts({ grant: 10, pack: 0 })).toBe("merge");
    expect(classifyBucketAmounts({ grant: 0, pack: 1 })).toBe("merge");
  });

  it("still merges when one bucket is negative but the other is positive", () => {
    // Only the positive bucket moves; the negative one is floored to 0.
    expect(classifyBucketAmounts({ grant: -5, pack: 10 })).toBe("merge");
  });

  it("refuses when no bucket is positive, even for a non-zero net", () => {
    expect(classifyBucketAmounts({ grant: 0, pack: 0 })).toBe("no_positive_balance");
    expect(classifyBucketAmounts({ grant: 0, pack: -5 })).toBe("no_positive_balance");
    expect(classifyBucketAmounts({ grant: -3, pack: -5 })).toBe("no_positive_balance");
  });
});

// STAGING ONLY is a load-bearing claim, not a comment: #284 means production
// starts at V336 with no pre-existing stranded data, so a --write run against
// prod could only ever be unreviewed ledger surgery. A dry run is always safe
// and must never be gated.
describe("writeGateBlocked", () => {
  it("never blocks a dry run, whatever the env says", () => {
    expect(writeGateBlocked(false, undefined)).toBe(false);
    expect(writeGateBlocked(false, "1")).toBe(false);
    expect(writeGateBlocked(false, "nonsense")).toBe(false);
  });

  it("blocks --write unless the operator opted in", () => {
    expect(writeGateBlocked(true, undefined)).toBe(true);
    expect(writeGateBlocked(true, "1")).toBe(false);
  });

  it("requires exactly \"1\" — no truthy-looking near misses", () => {
    for (const v of ["", "0", "true", "yes", "TRUE", " 1"]) {
      expect(writeGateBlocked(true, v)).toBe(true);
    }
  });
});
