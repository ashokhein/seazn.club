// The staging deploy installs with `pnpm install --frozen-lockfile --prod`,
// which drops devDependencies. pnpm's isolated node_modules gives no walk-up
// to a hoisted copy the way npm's flat tree did, so every package the engine
// imports at RUNTIME must sit in `dependencies` — a devDependency-only entry
// resolves fine in every local run and in every CI job that installs dev deps,
// then dies with ERR_MODULE_NOT_FOUND on the deploy job alone.
//
// src/testkit/** is excluded: it is a test harness, imported only from a
// consumer's own test files, so vitest/fast-check stay devDependencies.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src", import.meta.url).pathname;
const MANIFEST = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url).pathname, "utf8"),
) as { dependencies?: Record<string, string> };

/** `import … from "x"`, `export … from "x"`, bare `import "x"`, `import("x")`. */
const SPECIFIER =
  /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "testkit") walk(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Comments first: prose in this repo contains phrases like `tell "worse" from
 * "better"`, which the multi-line import pattern below would otherwise read as
 * an import of a package named `better`.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Bare package name: "zod/v4" → "zod", "@scope/pkg/sub" → "@scope/pkg". */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

function runtimeImports(): Map<string, string> {
  const found = new Map<string, string>(); // package -> first file that imports it
  for (const file of walk(SRC)) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = match[1] ?? match[2] ?? match[3]!;
      if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
      const pkg = packageOf(specifier);
      if (!found.has(pkg)) found.set(pkg, file.slice(SRC.length + 1));
    }
  }
  return found;
}

describe("engine runtime dependencies", () => {
  it("declares every runtime import in `dependencies`, not `devDependencies`", () => {
    const declared = new Set(Object.keys(MANIFEST.dependencies ?? {}));
    const missing = [...runtimeImports()]
      .filter(([pkg]) => !declared.has(pkg))
      .map(([pkg, file]) => `${pkg} (imported from src/${file})`);
    expect(missing).toEqual([]);
  });

  it("finds the imports it is meant to be guarding", () => {
    // A regex that silently matched nothing would make the gate above vacuous.
    expect([...runtimeImports().keys()].sort()).toEqual(["z3-solver", "zod"]);
  });
});
