import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { LIVE_SUBSCRIPTION_STATUSES } from "@/lib/subscription-status";

/**
 * Our `subscriptions.status` vocabulary is deliberately SMALLER than Stripe's:
 * `STATUS_MAP` (lib/billing.ts) folds `unpaid`/`paused` into `past_due` and
 * `incomplete_expired` into `canceled`, keeping only `incomplete` distinct.
 *
 * The cost of that is a silent one. A Stripe status we never store still LOOKS
 * like a legal value to anyone reading Stripe's docs, so `where status =
 * 'incomplete_expired'` is easy to write, type-checks, runs, and matches
 * nothing — for ever, with no error. It nearly shipped once: #367's proposed
 * sweep for abandoned checkouts selected exactly that (see #375).
 *
 * This is the guard the comment in STATUS_MAP cannot be. It fails when a
 * Stripe-only status name appears anywhere outside the two files that are
 * legitimately talking about STRIPE's vocabulary rather than ours.
 */

/** Stripe subscription statuses that `STATUS_MAP` never yields. */
const STRIPE_ONLY_STATUSES = ["incomplete_expired", "unpaid", "paused"] as const;

/**
 * The two files that legitimately name them, and why:
 *
 *  - `lib/billing.ts` — STATUS_MAP itself, the translation boundary.
 *  - `server/usecases/billing-events.ts` — `isLiveStripeStatus` compares a
 *    `Stripe.Subscription.Status` straight off the webhook, BEFORE translation.
 *
 * Anywhere else, the string is being compared against a value this codebase
 * writes, and it can never match one.
 */
const TRANSLATION_BOUNDARY = new Set([
  "lib/billing.ts",
  "server/usecases/billing-events.ts",
  // `isTerminalStripeStatus` — the one predicate over STRIPE's vocabulary,
  // added when `sweepOrphanGroups` needed the same question the webhook guard
  // asks (#375). It lives in this leaf module because billing-events already
  // imports billing-groups, so the two callers cannot import each other; the
  // alternative was a second hand-written copy of these two strings, which is
  // exactly what this guard exists to prevent.
  "lib/subscription-status.ts",
]);

const SRC = path.resolve(__dirname, "../..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "__tests__") continue;
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("nothing outside the translation boundary names a Stripe-only status (#375)", () => {
  const files = sourceFiles(SRC);

  it("finds a plausible number of source files", () => {
    // Guards the guard: a wrong root iterates nothing and passes vacuously —
    // the failure shape this repo keeps relearning.
    expect(files.length).toBeGreaterThan(300);
  });

  it("still finds the statuses at the boundary, so the scan is looking at real text", () => {
    // If STATUS_MAP is ever restructured out of a plain literal, the check
    // below could go quiet for the wrong reason. This proves the strings are
    // findable where they are known to live.
    const billing = fs.readFileSync(path.join(SRC, "lib/billing.ts"), "utf8");
    for (const s of STRIPE_ONLY_STATUSES) expect(billing).toContain(s);
  });

  it("no other file compares against a status our own writes never produce", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(SRC, file);
      if (TRANSLATION_BOUNDARY.has(rel)) continue;
      const src = fs.readFileSync(file, "utf8");
      src.split("\n").forEach((line, i) => {
        // Comments may discuss them freely — it is code that silently misses.
        // Three comment forms reach here, and the third is not obvious: SQL
        // lives in template literals in this codebase, so a `-- 'incomplete_
        // expired'` line inside a query's own commentary is prose, not a
        // predicate. Only a line whose whole content is the SQL comment is
        // stripped, so a real `where status = 'x' -- note` still counts.
        const code = line
          .replace(/\/\/.*$/, "")
          .replace(/^\s*\*.*$/, "")
          .replace(/^\s*--.*$/, "");
        for (const s of STRIPE_ONLY_STATUSES) {
          if (code.includes(`"${s}"`) || code.includes(`'${s}'`)) {
            offenders.push(
              `${rel}:${i + 1} names "${s}" — STATUS_MAP never writes it, so a ` +
                `comparison against subscriptions.status can never match. See ` +
                `lib/billing.ts's STATUS_MAP; the raw Stripe status lives in ` +
                `billing_events.payload.`,
            );
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("every status STATUS_MAP can produce is one the rest of the code knows", () => {
    // The mapping's VALUES must stay inside our vocabulary: LIVE_SUBSCRIPTION_
    // STATUSES plus the one terminal value. A mapping to anything else would
    // read as non-live by negation and degrade an org that is actually paying.
    const ours = new Set([...LIVE_SUBSCRIPTION_STATUSES, "canceled"]);
    const billing = fs.readFileSync(path.join(SRC, "lib/billing.ts"), "utf8");
    const block = billing.match(/const STATUS_MAP[^=]*=\s*\{([\s\S]*?)\n\};/);
    expect(block, "STATUS_MAP is no longer a plain object literal").not.toBeNull();
    const values = [...block![1]!.matchAll(/^\s*\w+:\s*"([^"]+)"/gm)].map((m) => m[1]!);
    expect(values.length, "parsed no entries out of STATUS_MAP").toBeGreaterThan(5);
    expect(values.filter((v) => !ours.has(v))).toEqual([]);
  });
});
