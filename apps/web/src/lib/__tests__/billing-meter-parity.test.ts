// The billing page's "active competitions" meter and the write-side quota that
// blocks competition #6 are two independent SQL queries over the same concept.
// They drifted: `assertActiveQuota` excludes Event-Passed competitions (a pass
// buys its competition out of the quota, v3/07 §3) and the meter did not, so an
// org with 5 active + 1 passed saw "6 / 5" in red on the billing page while
// enforcement was still letting it create another competition. The user is told
// they are over a limit they are not over.
//
// There is no shared helper to test — the meter lives inline in a server
// component and the quota runs through `withTenant`. So this guards the
// invariant at the source level: both queries must carry the same
// `competition_passes` exclusion. If someone deletes it from either side, this
// fails and names which side.
//
// Deliberately NOT asserting the exact SQL text: formatting and alias choices
// are free to change. Only the presence of the exclusion in the active-count
// query is load-bearing.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../..");

const BILLING_PAGE = path.join(SRC, "app/o/[orgSlug]/settings/billing/page.tsx");
const QUOTA_USECASE = path.join(SRC, "server/usecases/competitions.ts");

/** The clause that takes passed competitions out of the active tally. */
const EXCLUSION = /not exists\s*\(\s*select 1 from competition_passes/i;

describe("active-competition count: meter and enforcement agree", () => {
  it("the write-side quota excludes Event-Passed competitions", () => {
    const src = readFileSync(QUOTA_USECASE, "utf8");
    // Anchor on the function so a match elsewhere in the file cannot satisfy this.
    const fn = src.slice(src.indexOf("async function assertActiveQuota"));
    expect(fn).not.toBe("");
    expect(
      EXCLUSION.test(fn),
      "assertActiveQuota no longer excludes passed competitions — if that is " +
        "intentional, the billing meter must change with it",
    ).toBe(true);
  });

  it("the billing meter excludes them too, in the competitions_active subquery", () => {
    const src = readFileSync(BILLING_PAGE, "utf8");
    // Anchor on the SQL alias, not the bare identifier — the first
    // `competitions_active` in this file is the TypeScript row type, which sits
    // above the query and would slice the wrong region.
    const alias = src.indexOf("as competitions_active");
    expect(alias, "the `as competitions_active` alias was not found").toBeGreaterThan(-1);

    // Walk back to that subquery's own aggregate: everything between it and the
    // alias is the active count, `not exists` clause included.
    const start = src.lastIndexOf("count(*)", alias);
    expect(start, "no aggregate found before the alias").toBeGreaterThan(-1);
    const subquery = src.slice(start, alias);
    expect(
      EXCLUSION.test(subquery),
      "the billing meter counts Event-Passed competitions that enforcement " +
        "excludes — it will show orgs as over a quota they are not over",
    ).toBe(true);
  });
});
