// W6 (#401): z3's WASM binary must be traced into the standalone output.
//
// This test exists because the bug it guards is INVISIBLE to every other test in
// the repo. `z3-solver` ships JS glue that reads `build/z3-built.wasm` off disk
// at runtime; nothing in the import graph names the `.wasm`, so Next's file
// tracing cannot infer it. Unit tests never notice — they import from the source
// `node_modules`, where the file is always present.
//
// In a real standalone build it is not present, and the server aborts on every
// solve with:
//
//   failed to asynchronously prepare wasm: ENOENT ...
//     '/ROOT/node_modules/z3-solver/build/z3-built.wasm'
//
// which `loadZ3` turns into the designed fallback to LLM repair. So production
// degrades QUIETLY: minimal-movement repair silently does nothing while the
// organiser still pays for a model round. Measured, not hypothesised — the
// e2e against a standalone build showed "repair › reconciled · 2 round(s)" and
// "2 blocking unresolved" on a board the solver fixes in one move locally.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { nextConfig } from "../../../next.config.js";

/**
 * The glob is no longer a constant this file can restate. next.config.js
 * RESOLVES it (`require.resolve("z3-solver/package.json")`) precisely so it
 * survives a package-manager change: under npm the package hoisted to
 * `<repo>/node_modules/z3-solver`, under pnpm the real file lives beneath
 * `node_modules/.pnpm/z3-solver@<version>/`, and a literal written for one
 * layout matches nothing under the other — silently, which is the whole point
 * of this file.
 *
 * So read the glob back OFF the config and check where it actually leads. A
 * hardcoded expectation here would only prove the test agrees with itself.
 */
function tracedZ3Glob(): string | undefined {
  const includes =
    (nextConfig as { outputFileTracingIncludes?: Record<string, string[]> })
      .outputFileTracingIncludes ?? {};
  return Object.values(includes)
    .flat()
    .find((entry) => entry.includes("z3-solver"));
}

describe("z3 WASM survives standalone output tracing", () => {
  it("is left unbundled, so its glue can still find its own directory", () => {
    // Measured, not assumed: tracing the .wasm into the standalone output is
    // necessary but NOT sufficient. z3's emscripten glue resolves the binary
    // relative to its own `__dirname`, and bundling rewrites that to the tracing
    // placeholder — the server then asks for
    //   /ROOT/node_modules/z3-solver/build/z3-built.wasm
    // and gets ENOENT with the file sitting correctly in
    // .next/standalone/node_modules. A rebuild with the include and without this
    // entry still aborted every solve.
    const external =
      (nextConfig as { serverExternalPackages?: string[] }).serverExternalPackages ?? [];
    expect(external).toContain("z3-solver");
  });

  it("is listed in outputFileTracingIncludes", () => {
    const glob = tracedZ3Glob();
    expect(glob, "no outputFileTracingIncludes entry mentions z3-solver").toBeDefined();
    // It must reach the package's own build/ directory and sweep it whole —
    // the glue loads z3-built.wasm by name but the directory is its unit.
    expect(glob).toMatch(/z3-solver[/\\]build[/\\]\*\*[/\\]\*$/);
  });

  it("actually points at the shipped binary", () => {
    // The entry is still a string in a config file: it stays "correct" forever
    // even if z3 moves the artefact in a version bump, and it is now also the
    // only thing standing between a linker change and a silent production
    // no-op. Resolve it and look.
    const glob = tracedZ3Glob()!;
    const appDir = path.join(import.meta.dirname, "../../..");
    const buildDir = path.resolve(appDir, glob.replace(/[/\\]\*\*[/\\]\*$/, ""));
    expect(fs.existsSync(buildDir), `no such directory: ${buildDir}`).toBe(true);
    const wasm = fs
      .readdirSync(buildDir)
      .filter((f) => f.endsWith(".wasm"));
    // Name it, don't just count: the glue requests `z3-built.wasm` by name, so
    // "some .wasm exists" is not the property that matters.
    expect(wasm).toContain("z3-built.wasm");
  });
});
