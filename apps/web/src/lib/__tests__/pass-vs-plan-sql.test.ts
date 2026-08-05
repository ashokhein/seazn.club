import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * TS 7 resolves postgres.js's overload set differently for an array literal
 * built with a spread and passed INLINE inside a template hole: it falls
 * through to the tagged-template signature and reports
 *   TS2769 ... Property 'raw' is missing in type 'string[]'
 * The fix is to hoist the array to a local first. Runtime behaviour is
 * identical either way, so nothing but the compiler can catch a regression
 * here — which is why this test reads the source.
 */
describe("rungsExceedingPlan: TS 7 overload resolution", () => {
  it("does not build the sql() array inline inside the template hole", () => {
    const src = readFileSync(
      join(import.meta.dirname, "../pass-vs-plan.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/\$\{sql\(\[\.\.\./);
  });

  it("hoists the key list to a local before the query", () => {
    const src = readFileSync(
      join(import.meta.dirname, "../pass-vs-plan.ts"),
      "utf8",
    );
    expect(src).toMatch(/const\s+ladderKeys\s*=\s*\[\.\.\.passKeys,\s*planKey\]/);
  });
});
