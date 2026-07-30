import { describe, it, expect } from "vitest";
import { needsWrapUp, suggestStatus, type FixtureAgg } from "@/lib/competition-wrapup";
import { PASS_END_GRACE_DAYS } from "@/lib/entitlements";

// v17 gap #362 — "prompt, don't sweep". These pin the population the prompt is
// FOR, which is the one every pre-#362 arm missed: a competition past its end
// date that nobody tidied up, usually with no finished fixtures to infer from.

/**
 * A `YYYY-MM-DD` date string `days` before today, UTC.
 *
 * String, not a Date, and that is load-bearing: `passLockReason` compares the
 * grace boundary with a STRICT `<` against UTC midnight, and a `new Date()`-
 * derived value carries a time of day that lands hours off the boundary, where
 * `<` and `<=` are indistinguishable. The exact-boundary case below is the one
 * that would silently stop testing anything.
 */
function daysAgo(days: number): string {
  const now = new Date();
  const ms = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

const NO_FIXTURES: FixtureAgg = { total: 0, underway: 0, done: 0, scheduled: 0 };

describe("needsWrapUp", () => {
  it("asks about a live competition past its end date plus grace", () => {
    expect(needsWrapUp("live", daysAgo(30))).toBe(true);
  });

  it("stays quiet inside the grace window", () => {
    expect(needsWrapUp("live", daysAgo(PASS_END_GRACE_DAYS - 1))).toBe(false);
  });

  it("stays quiet ON the grace boundary — the arm fires strictly after it", () => {
    expect(needsWrapUp("live", daysAgo(PASS_END_GRACE_DAYS))).toBe(false);
  });

  it("fires the day after the boundary", () => {
    expect(needsWrapUp("live", daysAgo(PASS_END_GRACE_DAYS + 1))).toBe(true);
  });

  it("has nothing to ask about a competition with no end date", () => {
    // The abandoned-with-no-ends_on half is #360's, not this prompt's — there
    // is no date to have passed, so there is no question to put.
    expect(needsWrapUp("live", null)).toBe(false);
  });

  it.each(["draft", "published"])(
    "asks about a %s competition too — it holds a slot exactly like a live one",
    (status) => {
      expect(needsWrapUp(status, daysAgo(30))).toBe(true);
    },
  );

  it.each(["completed", "archived"])(
    "never asks about a %s competition — the organiser already answered",
    (status) => {
      expect(needsWrapUp(status, daysAgo(30))).toBe(false);
    },
  );
});

describe("suggestStatus — the date arm (#362)", () => {
  it("suggests completed for a competition abandoned with NO fixtures at all", () => {
    // The pre-#362 rule returned null here: every arm it had was behind
    // `agg.total === 0`. This is the commonest shape of abandonment.
    expect(suggestStatus("live", daysAgo(30), NO_FIXTURES)).toBe("completed");
  });

  it("suggests completed when fixtures exist but nobody ever scored them", () => {
    // The old `done === total` arm needed every fixture finished. A competition
    // that stopped halfway satisfied nothing and was never nudged.
    expect(
      suggestStatus("live", daysAgo(30), { total: 8, underway: 0, done: 2, scheduled: 8 }),
    ).toBe("completed");
  });

  it("suggests nothing while the end date is still ahead of the grace boundary", () => {
    expect(suggestStatus("live", daysAgo(1), NO_FIXTURES)).toBeNull();
  });

  it("never re-suggests a status the competition already holds", () => {
    expect(suggestStatus("completed", daysAgo(30), NO_FIXTURES)).toBeNull();
  });
});

describe("suggestStatus — the pre-existing fixture arms still hold", () => {
  const inDate = daysAgo(0);

  it("suggests completed once every fixture is done", () => {
    expect(suggestStatus("live", inDate, { total: 4, underway: 0, done: 4, scheduled: 4 })).toBe(
      "completed",
    );
  });

  it("suggests live once a match is underway", () => {
    expect(suggestStatus("published", inDate, { total: 4, underway: 1, done: 0, scheduled: 4 })).toBe(
      "live",
    );
  });

  it("suggests published once a draft has scheduled fixtures", () => {
    expect(suggestStatus("draft", inDate, { total: 4, underway: 0, done: 0, scheduled: 4 })).toBe(
      "published",
    );
  });

  it("suggests nothing for a competition with no fixtures yet", () => {
    expect(suggestStatus("draft", inDate, NO_FIXTURES)).toBeNull();
  });

  it("suggests nothing for a competition with an unset end date and unfinished fixtures", () => {
    expect(suggestStatus("live", null, { total: 4, underway: 1, done: 1, scheduled: 4 })).toBeNull();
  });
});
