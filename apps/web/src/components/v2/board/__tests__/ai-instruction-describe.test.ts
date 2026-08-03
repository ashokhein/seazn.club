// W5 (#400) Task 6 — the plain-English reading of a compiled hard constraint.
//
// Six variants, one case each. The `it.each` table below is the contract: if
// `HardConstraint` grows a seventh member, `describeHardConstraint`'s `never`
// default stops compiling and this file stops covering the union — both are
// deliberate, and the compile error is the one that fires first.
//
// Every reading comes out of the dictionary. The fr case is what gives that
// teeth: an implementation that built the sentence in code would render the
// same English under a French dict and fail there while passing in en.
import { describe, expect, it } from "vitest";
import type { HardConstraint } from "@seazn/engine/scheduling";
import { HardConstraint as HardConstraintSchema } from "@seazn/engine/scheduling";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict, Locale } from "@/lib/i18n-constants";
import {
  constraintToken,
  describeHardConstraint,
  type DescribeCtx,
} from "../ai-instruction-describe";
import en from "@/dictionaries/en/ui.json";
import fr from "@/dictionaries/fr/ui.json";

const enDict = en as unknown as Dict;
const frDict = fr as unknown as Dict;

function ctxFor(dict: Dict, locale: Locale, names: DescribeCtx["names"] = () => null): DescribeCtx {
  return {
    msg: (key, vars) => tRuntime(dict, key as string, vars),
    plural: (key, count, vars) => pluralRuntime(dict, key, count, locale, vars),
    names,
    // "en" formats US-style ("Aug 7, 2026"); the board's own day labels already
    // pin en-GB for the same reason (lib/day-label.ts).
    locale: locale === "en" ? "en-GB" : locale,
  };
}

const ctx = ctxFor(enDict, "en");

const COMPETITION = { kind: "competition" } as const;

/** One row per `HardConstraint` member: the constraint, its ledger token, and
 *  the English reading. Held in a const rather than inline in `it.each` so the
 *  prose guard below reads the SAME tokens the table pins — two lists would
 *  drift, and the guard would then be checking a copy of the vocabulary rather
 *  than the vocabulary. */
const CASES: [Record<string, unknown>, string, string][] = [
  [
    { type: "min_rest_minutes", minutes: 45, rest_scope: "per_person", scope: COMPETITION },
    "REST",
    "at least 45 min rest between a player's matches",
  ],
  [
    { type: "max_fixtures_per_day", count: 2, scope: COMPETITION },
    "MAX/DAY",
    "at most 2 matches a day",
  ],
  [
    {
      type: "fixture_on_weekday",
      selector: { kind: "terminal" },
      weekday: "FRI",
      scope: COMPETITION,
    },
    "DAY",
    "the final on Friday",
  ],
  [
    {
      type: "fixture_on_date",
      selector: { kind: "terminal" },
      date: "2026-08-07",
      scope: COMPETITION,
    },
    "DATE",
    "the final on 7 Aug 2026",
  ],
  [{ type: "not_before", time: "09:00", scope: COMPETITION }, "≥ TIME", "nothing before 09:00"],
  [{ type: "not_after", time: "21:00", scope: COMPETITION }, "≤ TIME", "nothing after 21:00"],
];

describe("constraintToken / describeHardConstraint", () => {
  it.each(CASES)("describes %s", (c, token, text) => {
    expect(constraintToken(c as HardConstraint)).toBe(token);
    expect(describeHardConstraint(c as HardConstraint, ctx)).toContain(text);
  });

  // #400 Task 6b. The token is the one string on this card that is NOT
  // translated, and that only holds while it is a symbol or an abbreviation.
  // "PER DAY" / "NOT BEFORE" / "NOT AFTER" / "WEEKDAY" were English words on
  // the element the design calls the signature — four of them, read as-is by a
  // French organiser on the screen that tells them what they are paying for.
  it("keeps English prose off the ledger spine", () => {
    for (const [, token] of CASES) {
      expect(token, `${token} is an English phrase, not a locale-neutral token`).not.toMatch(
        /\b(PER|NOT|BEFORE|AFTER|WEEKDAY|DAILY|PREFER)\b/,
      );
    }
  });

  it("covers every member of the HardConstraint union", () => {
    // Reads the union off the schema rather than a hand-kept list, so a seventh
    // variant makes this fail even before anyone edits the table above.
    const types = HardConstraintSchema.options.map(
      (o) => (o.shape.type as { value: string }).value,
    );
    expect(types).toHaveLength(6);
    expect(new Set(types)).toEqual(
      new Set([
        "min_rest_minutes",
        "max_fixtures_per_day",
        "fixture_on_weekday",
        "fixture_on_date",
        "not_before",
        "not_after",
      ]),
    );
  });

  it("reads each rest scope differently — a feeder gap is not a player's rest", () => {
    const per = describeHardConstraint(
      {
        type: "min_rest_minutes",
        minutes: 30,
        rest_scope: "per_person",
        scope: COMPETITION,
      } as HardConstraint,
      ctx,
    );
    const feeder = describeHardConstraint(
      {
        type: "min_rest_minutes",
        minutes: 30,
        rest_scope: "feeder_to_dependent",
        scope: COMPETITION,
      } as HardConstraint,
      ctx,
    );
    const both = describeHardConstraint(
      {
        type: "min_rest_minutes",
        minutes: 30,
        rest_scope: "both",
        scope: COMPETITION,
      } as HardConstraint,
      ctx,
    );
    expect(new Set([per, feeder, both]).size).toBe(3);
  });

  it("says one match, not 1 matches", () => {
    expect(
      describeHardConstraint(
        { type: "max_fixtures_per_day", count: 1, scope: COMPETITION } as HardConstraint,
        ctx,
      ),
    ).toContain("at most 1 match a day");
  });

  it("names a division-scoped rule rather than implying it binds the whole board", () => {
    const c = {
      type: "max_fixtures_per_day",
      count: 2,
      scope: { kind: "division", divisionId: "d1" },
    } as HardConstraint;
    const named = ctxFor(enDict, "en", (s) =>
      s.kind === "division" && s.divisionId === "d1" ? "Under 16s Singles" : null,
    );
    expect(describeHardConstraint(c, named)).toContain("Under 16s Singles");
    // And the competition-wide twin must NOT claim a scope it does not have.
    expect(
      describeHardConstraint(
        { type: "max_fixtures_per_day", count: 2, scope: COMPETITION } as HardConstraint,
        named,
      ),
    ).not.toContain("Under 16s Singles");
  });

  it("says the rule is narrowed even when the name is unknown, rather than guessing one", () => {
    const c = {
      type: "not_before",
      time: "09:00",
      scope: { kind: "entrant", entrantId: "e-9" },
    } as HardConstraint;
    const text = describeHardConstraint(c, ctxFor(enDict, "en", () => null));
    expect(text).not.toContain("e-9");
    expect(text).toContain(enDict["board.ai.preview.scope.partial"] as string);
  });

  it("localizes the whole reading, including the scope clause", () => {
    const c = {
      type: "max_fixtures_per_day",
      count: 2,
      scope: { kind: "division", divisionId: "d1" },
    } as HardConstraint;
    const names = () => "Under 16s Singles";
    const enText = describeHardConstraint(c, ctxFor(enDict, "en", names));
    const frText = describeHardConstraint(c, ctxFor(frDict, "fr", names));
    // Not merely "different": the English reading must be absent from the
    // French one, which is what an in-code sentence would fail.
    expect(frText).not.toContain("at most 2 matches a day");
    expect(frText).toContain("Under 16s Singles");
    expect(frText).not.toBe(enText);
  });

  it("formats a dated rule in the reader's locale, not the server's default", () => {
    const c = {
      type: "fixture_on_date",
      selector: { kind: "terminal" },
      date: "2026-08-07",
      scope: COMPETITION,
    } as HardConstraint;
    expect(describeHardConstraint(c, ctxFor(enDict, "en"))).toContain("7 Aug 2026");
    expect(describeHardConstraint(c, ctxFor(frDict, "fr"))).not.toContain("Aug");
  });

  it("names the match a selector points at without leaking an internal id", () => {
    const byKey = describeHardConstraint(
      {
        type: "fixture_on_weekday",
        selector: { kind: "ext_key", extKey: "SF1" },
        weekday: "SAT",
        scope: COMPETITION,
      } as HardConstraint,
      ctx,
    );
    expect(byKey).toContain("SF1");

    const byId = describeHardConstraint(
      {
        type: "fixture_on_weekday",
        selector: { kind: "id", fixtureId: "11111111-1111-1111-1111-111111111111" },
        weekday: "SAT",
        scope: COMPETITION,
      } as HardConstraint,
      ctx,
    );
    expect(byId).not.toContain("11111111");
  });
});
