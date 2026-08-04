// Next only tolerates a fixed set of named exports from a `page`/`layout`/
// `route` module. Anything extra is a hard TS2344 ("does not satisfy the
// constraint '{ [x: string]: never; }'") — but only against the type guards
// `next build` writes into `.next/types/**`. With no `.next` in the tree a
// bare `tsc --noEmit` is clean, so CI and a fresh checkout both pass while a
// build-then-typecheck in the same tree fails. That is a nasty failure mode:
// the error is invisible exactly where people look for it.
//
// This test moves the check to the cause instead of the generated symptom.
// It reads the export surface of every page/layout/route module straight from
// the source, so it needs no build, runs in the normal unit suite, and points
// at the offending source file rather than at `.next/types/...`.
//
// The allowed sets below are lifted from Next's own type-guard generator,
// `node_modules/next/dist/build/webpack/plugins/next-types-plugin/index.js`
// (`createTypeGuardFile`, the `checkFields<Diff<{...}, TEntry>>()` block at
// lines 46-65). Keep them in sync on a Next upgrade — a false failure here is
// loud and one-line to fix, which is the trade we want.
//
// Two deliberate deviations from Next's emit rules, both in the strict
// direction: Next only emits guards for modules in the react-server-components
// layer, so a `"use client"` page escapes the check, and it skips `_`-prefixed
// private directories. We check every page/layout/route regardless of the
// client/server layer (a page can flip layers later; the extra export is bad
// hygiene either way) but do honour the private-directory skip.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// `import ts from "typescript"` makes Vite inline-transform the ~9 MB
// typescript.js and die on its missing sourcemap, taking the whole file's
// collection with it (vitest then reports 0 tests and no summary at all).
// Node's own CJS loader bypasses the transform pipeline entirely.
const ts: typeof import("typescript") = createRequire(import.meta.url)("typescript");

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app");

/** Route segment config, allowed on page, layout and route alike. */
const COMMON = [
  "config",
  "generateStaticParams",
  "unstable_instant",
  "unstable_dynamicStaleTime",
  "revalidate",
  "dynamic",
  "dynamicParams",
  "fetchCache",
  "preferredRegion",
  "runtime",
  "maxDuration",
] as const;

/** page.tsx / layout.tsx additionally own the component and its metadata. */
const PAGE_OR_LAYOUT = [...COMMON, "default", "metadata", "generateMetadata", "viewport", "generateViewport"];

/** route.ts exports HTTP verbs — and notably NOT `default` or `contentType`. */
const ROUTE = [...COMMON, "GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE", "PATCH"];

const MODULE_RE = /^(page|layout|route)\.(ts|tsx|js|jsx|mjs|cjs)$/;

function appModules(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // Next skips `_`-prefixed directories as a private-folder convention.
    if (entry.isDirectory()) {
      if (!entry.name.startsWith("_")) appModules(full, acc);
    } else if (MODULE_RE.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Value-space exports of a module. Type-only exports (`export type`,
 * `export interface`, `export type { … }`) are erased before Next's
 * `typeof import(...)` ever sees them, so they are not violations.
 */
function valueExports(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const names: string[] = [];

  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement)) {
      names.push("default");
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          if (!element.isTypeOnly) names.push(element.name.text);
        }
      } else if (clause && ts.isNamespaceExport(clause)) {
        names.push(clause.name.text);
      } else {
        // `export * from "..."` — the surface is not statically knowable here.
        // Flag it: a star re-export from a page module is itself the bug.
        names.push("<export * from>");
      }
      continue;
    }

    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
    if (!modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) continue;

    if (modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
      names.push("default");
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        names.push(ts.isIdentifier(declaration.name) ? declaration.name.text : "<destructured>");
      }
      continue;
    }

    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      statement.name &&
      ts.isIdentifier(statement.name)
    ) {
      names.push(statement.name.text);
    }
  }

  return names;
}

describe("app router module export surface", () => {
  const modules = appModules(APP_DIR);

  it("finds the app router modules to check", () => {
    // Guards the guard: a broken glob would make the assertion below vacuous.
    expect(modules.length).toBeGreaterThan(300);
  });

  it("exports nothing outside the set Next allows from page/layout/route", () => {
    const offenders = modules.flatMap((file) => {
      const kind = path.basename(file).split(".")[0];
      const allowed = kind === "route" ? ROUTE : PAGE_OR_LAYOUT;
      const extra = valueExports(file).filter((name) => !allowed.includes(name));
      return extra.length ? [`${path.relative(APP_DIR, file)} → ${extra.join(", ")}`] : [];
    });

    // A helper that a page needs but Next will not tolerate as an export
    // belongs in a sibling module the page imports from.
    expect(offenders).toEqual([]);
  });
});
