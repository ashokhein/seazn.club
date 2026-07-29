// Pure-function coverage for `toManualReviewJsonl`
// (scripts/reconcile-stranded-wallets.ts, #309).
//
// The reconcile script previously routed every unattributable wallet to
// MANUAL REVIEW via `console.warn` only — on the staging fixture run that was
// 76 of 81 wallets, and the console log was the only artifact. If staging
// cleanup is meant to complete, the rows that still need a human decision
// have to be workable from a file, not scraped from a terminal.
//
// JSON Lines (one self-contained JSON object per line) was chosen over CSV
// and over a single top-level JSON array:
//   - CSV needs column-escaping for `reason`, which is free text and can
//     itself contain commas/quotes (see the second test below) — a fragile
//     format for something meant to be parsed by a script, not eyeballed.
//   - A single JSON array requires the whole array to close cleanly; a
//     process that dies mid-run (this script explicitly must survive one bad
//     wallet without aborting the rest) would leave an unparsable file. Each
//     JSONL line stands alone, so every COMPLETE line stays usable.
//
// Pinned as a pure function, the same way `chooseReconcileTarget` and
// `classifyBucketAmounts` are pinned in
// reconcile-stranded-wallets-select-target.test.ts, without touching Postgres.
import { describe, expect, it } from "vitest";
import {
  toManualReviewJsonl,
  type ManualReviewRow,
} from "../../../../../scripts/reconcile-stranded-wallets";

describe("toManualReviewJsonl", () => {
  it("emits one self-contained JSON object per row, newline-terminated", () => {
    const rows: ManualReviewRow[] = [
      { wallet_id: "wallet-a", grant: 500, pack: 0, reason: "no_spend_attribution" },
      { wallet_id: "wallet-b", grant: 0, pack: -10, reason: "no_positive_balance" },
    ];
    const out = toManualReviewJsonl(rows);
    const lines = out.split("\n").filter((line) => line.length > 0);

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(rows[0]);
    expect(JSON.parse(lines[1]!)).toEqual(rows[1]);
    // Newline-terminated so the file can be `cat`-appended to safely.
    expect(out.endsWith("\n")).toBe(true);
  });

  it("keeps a reason containing commas and quotes machine-readable (the CSV failure mode)", () => {
    const rows: ManualReviewRow[] = [
      {
        wallet_id: "wallet-c",
        grant: 12,
        pack: 3,
        reason: 'processing_error: relation "ai_credit_ledger" does not exist, retry',
      },
    ];
    const parsed = JSON.parse(toManualReviewJsonl(rows).trim());
    expect(parsed.reason).toBe(
      'processing_error: relation "ai_credit_ledger" does not exist, retry',
    );
  });

  it("returns an empty string for no rows — a valid, empty artifact", () => {
    expect(toManualReviewJsonl([])).toBe("");
  });
});
