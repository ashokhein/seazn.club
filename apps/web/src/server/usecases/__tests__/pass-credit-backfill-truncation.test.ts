// Pure-function coverage for `isBalanceHistoryTruncated`
// (scripts/backfill-pass-credit-redemptions.ts, round-3 hardening).
//
// `listBalanceTransactions(...).autoPagingToArray({ limit: BALANCE_TXN_FETCH_CAP })`
// has no lower bound: a customer with more balance transactions than the cap
// silently loses its OLDEST entries (Stripe lists newest first), and a
// truncated fetch prints and processes IDENTICALLY to a complete one — the
// array shape gives no visible sign. `isBalanceHistoryTruncated` is the one
// place that still can: the SDK cannot return more than `cap` entries, so an
// array landing exactly ON the cap is the only signal that there may have
// been more.
//
// Deliberately does NOT contort the script into producing 1000 real Stripe
// balance transactions to exercise this — the decision is factored out as a
// small pure function precisely so it can be pinned directly, the same way
// `withinCreditWindow` is pinned in pass-credit.test.ts without a live Stripe
// call.
import { describe, expect, it } from "vitest";
import {
  BALANCE_TXN_FETCH_CAP,
  isBalanceHistoryTruncated,
} from "../../../../../../scripts/backfill-pass-credit-redemptions";

describe("isBalanceHistoryTruncated", () => {
  it("is NOT truncated when the fetch came back under the cap", () => {
    expect(isBalanceHistoryTruncated(3, 100)).toBe(false);
    expect(isBalanceHistoryTruncated(99, 100)).toBe(false);
    expect(isBalanceHistoryTruncated(0, 100)).toBe(false);
  });

  it("IS truncated when the fetch landed exactly ON the cap", () => {
    // The SDK cannot return more than `cap` entries, so landing exactly on it
    // is the only signal available that there may have been more history
    // behind it. Treated as truncated even though a customer who holds
    // PRECISELY `cap` transactions and no more is a (harmless) false
    // positive — the alternative direction of being wrong silently drops a
    // pre-V335 pass credit.
    expect(isBalanceHistoryTruncated(100, 100)).toBe(true);
  });

  it("is truncated for the real cap the script actually uses", () => {
    expect(isBalanceHistoryTruncated(BALANCE_TXN_FETCH_CAP, BALANCE_TXN_FETCH_CAP)).toBe(true);
    expect(isBalanceHistoryTruncated(BALANCE_TXN_FETCH_CAP - 1, BALANCE_TXN_FETCH_CAP)).toBe(
      false,
    );
  });
});
