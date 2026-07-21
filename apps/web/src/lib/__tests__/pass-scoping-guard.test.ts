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
// THE PASS-SCOPING SWEEP HAS LANDED AND THIS GUARD IS GREEN. It stays as the
// standing regression: if you found it red, a new call site dropped the
// competition id. Fix the listed call sites. Do NOT weaken the assertion,
// narrow the lifted set, add a suppression list, or `.skip` it to get a green
// run — that is exactly how `branding` and `realtime` stayed dead for a whole
// release.
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

/**
 * The counter-rule. `hasFeatureOnAnyPass(orgId, featureKey)` is the FIFTH
 * resolver name, and it deliberately takes no competition: it answers "is this
 * reachable on ANY pass this org holds?". That is the honest question for an
 * ORG-LEVEL AFFORDANCE (the settings tab that decides whether to render the
 * sponsor controls at all) and it is the WRONG question for enforcement — an
 * org-wide yes means a pass bought for one competition unlocks every
 * competition, which is the same $29 hole in the other direction.
 *
 * The four rules above cannot see that misuse: the call has no competition
 * argument to be missing, so it is invisible to them. Worse, swapping an
 * offending `hasFeature(orgId, key)` for `hasFeatureOnAnyPass(orgId, key)` is
 * the one-token edit that makes this guard go quiet while widening the leak.
 * A docstring on the helper is not a control; this is.
 *
 * So: flag it anywhere under the enforcement layers. Pages and components are
 * affordances and stay allowed — they only decide what to draw, and every
 * write they lead to lands in a usecase or a route handler, which re-resolves
 * with the competition actually being written.
 */
const ANY_PASS_GATE = "hasFeatureOnAnyPass";
const ENFORCEMENT_DIRS = ["src/server/usecases/", "src/app/api/"];

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

/** Enforcement layers: the usecases that perform writes and the route handlers
 *  that front them. Path prefixes, not a file list — a new usecase is covered
 *  the moment it is created. */
function isEnforcementPath(file: string): boolean {
  return ENFORCEMENT_DIRS.some((dir) => file.startsWith(dir));
}

/**
 * The single walk. Both rules ride the same AST traversal — one parse per
 * file, one visitor — so the counter-rule costs nothing and cannot drift out
 * of sync with the file list the first rule scans.
 *
 * Parse with the TypeScript compiler, NOT a regex. Real call sites wrap:
 * `withinLimit(` at server/usecases/entrants.ts spans four lines, and any
 * regex anchoring the closing paren to the key string skips every one of them
 * — a guard that reports clean while missing offenders is worse than no guard
 * at all.
 *
 * Exported shape is a plain (file, text) pair so a fixture string can be run
 * through the exact code that scans the tree, rather than a parallel
 * re-implementation that could pass while the real one is broken.
 */
function scanSource(file: string, text: string, liftedKeys: Set<string>): string[] {
  const offenders: string[] = [];
  const src = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lineOf = (node: TS.Node): number =>
    src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1;

  const visit = (node: TS.Node): void => {
    if (ts.isCallExpression(node)) {
      const fn = node.expression.getText(src);
      const name = fn.split(".").pop() ?? fn;
      const wants = GATES[name];
      if (wants) {
        const key = literalText(node.arguments[1]);
        if (key && liftedKeys.has(key)) {
          const scopeArg = node.arguments[wants - 1];
          if (node.arguments.length < wants || isExplicitUndefined(scopeArg)) {
            offenders.push(`${file}:${lineOf(node)} ${name}("${key}")`);
          }
        }
      } else if (name === ANY_PASS_GATE && isEnforcementPath(file)) {
        // No key filter: the helper exists only to answer pass questions, and
        // an org-wide answer is wrong at an enforcement site for every key it
        // could be asked about, lifted or not.
        const key = literalText(node.arguments[1]);
        offenders.push(
          `${file}:${lineOf(node)} ${ANY_PASS_GATE}("${key ?? "?"}") in an enforcement layer` +
            ` — resolve the competition being written with hasFeature() instead`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return offenders;
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

    const offenders: string[] = [];
    const files = sourceFiles();
    // A guard that scans nothing reports clean. Vitest runs with cwd=apps/web;
    // if that ever changes, fail loudly rather than pass vacuously.
    expect(files.length).toBeGreaterThan(500);
    for (const file of files) {
      offenders.push(...scanSource(file, readFileSync(file, "utf8"), keys));
    }

    // DO NOT WEAKEN THIS ASSERTION AND DO NOT ADD A SUPPRESSION LIST.
    // If this is red, either a paid Event Pass feature is unreachable at the
    // listed sites (thread the competition id through), or an enforcement site
    // is asking the org-wide `hasFeatureOnAnyPass` question (resolve the
    // competition being written instead).
    expect(offenders).toEqual([]);
  });

  // No database: the counter-rule does not consult the lifted set, and the
  // point of the test is the RULE, not the tree. A fixture string run through
  // `scanSource` — the same function, the same visitor the real scan uses — is
  // the only honest way to prove it fires without committing a call site that
  // re-opens the hole to prove the alarm works.
  it("flags hasFeatureOnAnyPass in an enforcement layer, not in a page", () => {
    const src = `
      import { hasFeatureOnAnyPass } from "@/lib/entitlements";
      export async function saveSponsor(orgId: string) {
        if (!(await hasFeatureOnAnyPass(orgId, "sponsors.tiers"))) throw new Error("402");
      }`;

    const inUsecase = scanSource("src/server/usecases/sponsors.ts", src, new Set());
    expect(inUsecase).toHaveLength(1);
    expect(inUsecase[0]).toContain("hasFeatureOnAnyPass(\"sponsors.tiers\")");
    expect(inUsecase[0]).toContain("src/server/usecases/sponsors.ts:4");

    // Route handlers are enforcement too.
    expect(scanSource("src/app/api/sponsors/route.ts", src, new Set())).toHaveLength(1);

    // The real call site's layer. An affordance may ask the org-wide question;
    // if this ever starts flagging, the settings tab goes red for no reason.
    expect(scanSource("src/app/o/[orgSlug]/settings/page.tsx", src, new Set())).toEqual([]);
    expect(scanSource("src/components/sponsor-form.tsx", src, new Set())).toEqual([]);
  });
});
