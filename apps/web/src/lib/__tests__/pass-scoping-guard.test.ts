// The Event Pass ($29, one-time) lifts ONE competition out of the community
// matrix. lib/entitlements.ts only consults `competition_passes` when the
// caller hands it a competition id:
//
//     if (planKey === "community" && competitionId) { ... }
//
// A call site that omits that argument therefore makes the pass INVISIBLE —
// the resolver falls straight through to the community plan row and the grant
// the org paid for is dead on arrival. `branding` and `realtime` shipped that
// way: every enforcement site had a competition in scope, and not one passed
// it. Nothing caught it because entitlements-v2.test.ts was the only test that
// ever exercised the pass overlay, for two keys.
//
// This suite is the standing guard. It reads the lifted key set from the
// database (not a hard-coded list — the matrix moves) and parses every source
// file to find resolver calls that drop the competition id.
//
// ===========================================================================
// THIS TEST IS EXPECTED TO FAIL until the pass-scoping sweep (Phase 2, Task 11)
// lands. Its failure list IS that work queue. If you found it red: fix the
// listed call sites. Do NOT weaken the assertion, narrow the lifted set, add a
// suppression list, or `.skip` it to get a green run — that is exactly how
// `branding` and `realtime` stayed dead for a whole release.
// ===========================================================================
//
// Real Postgres required; skipped without DATABASE_URL (CI sets it, see
// .github/workflows/ci.yml).
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type * as TS from "typescript";
import { sql } from "@/lib/db";

// `typescript` is loaded through require, not import. It is a 10 MB CJS bundle
// and vite's import-analysis pass chokes on it ("content contains invalid JS
// syntax") when it is part of the module graph. The type side is a type-only
// import, which is erased, so vite never sees it.
const ts: typeof TS = createRequire(import.meta.url)("typescript");

const HAS_DB = !!process.env.DATABASE_URL;

/**
 * The four resolver entry points. Argument positions differ, and the
 * difference is load-bearing (lib/entitlements.ts):
 *
 *   hasFeature(orgId, featureKey, competitionId?)
 *   requireFeature(orgId, featureKey, competitionId?)
 *   getLimit(orgId, featureKey, competitionId?)
 *   withinLimit(orgId, featureKey, wouldBe, competitionId?)   <- FOURTH
 */
const GATES: Record<string, number> = {
  hasFeature: 3,
  requireFeature: 3,
  getLimit: 3,
  withinLimit: 4,
};

/** Source files to scan. Tests are excluded deliberately — they call the
 *  resolver both ways on purpose, which is the point of a resolver test. */
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

/** A literal string argument, however it is spelled. */
function literalText(node: TS.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/** An argument that is present but explicitly `undefined` is the same bug as
 *  an argument that is absent — the resolver sees no competition either way. */
function isExplicitUndefined(node: TS.Node | undefined): boolean {
  return !!node && ts.isIdentifier(node) && node.text === "undefined";
}

describe("Event Pass grants are resolved with a competition in scope", () => {
  it.skipIf(!HAS_DB)("has no enforcement site that drops the competition id", async () => {
    // The lifted set is computed, never hard-coded: a key whose event_pass
    // value equals the community value is a no-op grant (the pass overlay
    // falls through to the community row for anything it does not override),
    // so flagging it would be a false positive. `is distinct from` is
    // deliberate — it treats a missing community row (NULL) as different,
    // which it is: no row resolves to deny/0, not to the pass value.
    const lifted = await sql<{ feature_key: string }[]>`
      select ep.feature_key
      from plan_entitlements ep
      left join plan_entitlements c
        on c.plan_key = 'community' and c.feature_key = ep.feature_key
      where ep.plan_key = 'event_pass'
        and (ep.bool_value is distinct from c.bool_value
             or ep.int_value is distinct from c.int_value)`;

    const keys = new Set(lifted.map((r) => r.feature_key));
    expect(keys.size).toBeGreaterThan(0);

    // Parse with the TypeScript compiler, NOT a regex. Real call sites wrap:
    // `withinLimit(` at server/usecases/entrants.ts spans four lines, and any
    // regex anchoring the closing paren to the key string skips every one of
    // them — a guard that reports clean while missing offenders is worse than
    // no guard at all.
    const offenders: string[] = [];
    const files = sourceFiles();
    // A guard that scans nothing reports clean. Vitest runs with cwd=apps/web;
    // if that ever changes, fail loudly rather than pass vacuously.
    expect(files.length).toBeGreaterThan(500);
    for (const file of files) {
      const src = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const visit = (node: TS.Node): void => {
        if (ts.isCallExpression(node)) {
          const fn = node.expression.getText(src);
          const name = fn.split(".").pop() ?? fn;
          const wants = GATES[name];
          if (wants) {
            const key = literalText(node.arguments[1]);
            if (key && keys.has(key)) {
              const scopeArg = node.arguments[wants - 1];
              if (node.arguments.length < wants || isExplicitUndefined(scopeArg)) {
                const { line } = src.getLineAndCharacterOfPosition(node.getStart(src));
                offenders.push(`${file}:${line + 1} ${name}("${key}")`);
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(src);
    }

    // DO NOT WEAKEN THIS ASSERTION AND DO NOT ADD A SUPPRESSION LIST.
    // If this is red, a paid Event Pass feature is unreachable at the listed
    // sites. Fix the call sites; thread the competition id through.
    expect(offenders).toEqual([]);
  });
});
