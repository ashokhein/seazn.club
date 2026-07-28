// Standing guard for v17 gap #301's explicit scope line: copy-competition is
// OUT OF SCOPE, and nothing in the app may duplicate a `competition_passes`
// row onto a fresh competition_id.
//
// Both "Create next year's edition" links this wave added point at
// `routes.competitionNew` — a BLANK competition — never at a clone. That is
// what keeps "$29 unlocks exactly one competition, forever" (SPEC-4 §7) true,
// and it is an invariant nothing else enforces: the day someone ships a
// "duplicate last season" feature, copying the pass row across would look like
// a kindness and would silently hand out a paid entitlement for free.
//
// `lib/billing.ts`'s recordPassPurchase is the ONE authoritative writer. If
// this is red, a second writer appeared — find it, and either remove it or
// route it through recordPassPurchase.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

function sourceFiles(): string[] {
  return readdirSync("src", { recursive: true, encoding: "utf8" })
    .map((f) => `src/${f}`)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .filter(
      (f) =>
        !f.includes("__tests__") &&
        !f.endsWith(".test.ts") &&
        !f.endsWith(".test.tsx") &&
        !f.endsWith(".spec.ts") &&
        !f.endsWith(".spec.tsx"),
    )
    .sort();
}

describe("no feature copies a competition_passes row onto a new competition", () => {
  it("scans a real tree — the premise every assertion below rests on", () => {
    // A guard that scans nothing reports clean forever. This is the assertion
    // that fails first if the walk, the cwd or the filter ever break.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain("src/lib/billing.ts");
  });

  it("'insert into competition_passes' appears in exactly one file — the authoritative grant point", () => {
    const hits = sourceFiles().filter((f) =>
      readFileSync(f, "utf8").includes("insert into competition_passes"),
    );
    expect(hits).toEqual(["src/lib/billing.ts"]);
  });

  it("no source file names a clone/copy/duplicate helper against competition_passes", () => {
    // Deliberately loose (80 chars of slack, case-insensitive): this is looking
    // for INTENT near the table, not for one spelling of it. A false positive
    // here is cheap — read the file and confirm — while a miss hands out a paid
    // entitlement.
    const offenders = sourceFiles().filter((f) =>
      /(copy|clone|duplicate)[\s\S]{0,80}competition_passes/i.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("the patterns above can actually fire", () => {
    // Both assertions are NEGATIVE, and a typo in either would satisfy every
    // file forever. Planted text, checked against the same expressions.
    const planted = `await sql\`insert into competition_passes (competition_id) values (\${id})\`;
      async function clonePassFor(competition_passes: string) {}`;
    expect(planted.includes("insert into competition_passes")).toBe(true);
    expect(/(copy|clone|duplicate)[\s\S]{0,80}competition_passes/i.test(planted)).toBe(true);
  });

  it("the next-edition links point at a BLANK competition, never a clone", () => {
    // The other half of the invariant, and the half a reader is most likely to
    // "improve": both CTAs this wave added must keep going to competitionNew.
    for (const f of [
      "src/app/o/[orgSlug]/c/[compSlug]/upgrade/page.tsx",
      "src/components/competition-pass-entry.tsx",
    ]) {
      const text = readFileSync(f, "utf8");
      if (!text.includes("data-pass-next-edition") && !text.includes("nextEdition")) continue;
      expect(text, `${f} routes its next-edition link somewhere other than competitionNew`).toMatch(
        /routes\.competitionNew\(/,
      );
    }
  });
});
