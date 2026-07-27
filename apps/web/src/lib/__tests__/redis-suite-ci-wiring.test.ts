// Every `*.redis.test.ts` suite must be named explicitly in ci.yml.
//
// These suites gate themselves on `describe.skipIf(!HAS_DB || !HAS_REDIS)`, so
// a suite CI never runs does not fail — it reports "skipped" and looks green.
// And REDIS_URL is deliberately NOT job-wide (setting it there switches the
// entitlement cache on for the whole `smoke` job, which breaks the src/server
// suites that mutate entitlements via raw SQL without invalidating), so each
// Redis-gated file gets its own hand-wired step that owns REDIS_URL for itself
// alone. Hand-wired means forgettable: add a new `*.redis.test.ts` file and it
// silently never runs in CI, which is exactly the shape of bug these suites
// exist to catch.
//
// This guard is pure — no DB, no Redis, no network — so it runs on every CI
// job and never self-skips. It is the one test in the family that CANNOT be
// silently switched off.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/** apps/web/src — this file lives at apps/web/src/lib/__tests__/. */
const SRC = resolve(import.meta.dirname, "../..");
/** Repo root: up out of __tests__ / lib / src / web / apps. */
const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");
const CI_YML = join(REPO_ROOT, ".github/workflows/ci.yml");

/**
 * Every Redis-gated suite under apps/web/src, as src-relative paths.
 *
 * Scans apps/web/src ONLY. Every Redis-gated suite lives there today; a
 * `*.redis.test.ts` added under another workspace would not be seen, which is
 * the known limit of this guard rather than an oversight.
 */
function redisSuites(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((p) => p.endsWith(".redis.test.ts"))
    .sort();
}

/**
 * ci.yml with its COMMENTS removed.
 *
 * Load-bearing, not tidiness: ci.yml documents these steps in prose that names
 * the very files the steps run (the block above the Redis steps names both
 * suites). A raw substring search over the whole file is therefore satisfied by
 * the COMMENTARY — delete the actual `run:` step and the guard stays green,
 * which is precisely the failure it exists to catch.
 *
 * Strips comments rather than whitelisting `run:` lines: a `run: |` block spans
 * continuation lines that no line-shape filter would match, so whitelisting
 * would false-FAIL a suite wired inside a multi-line script. Removing comments
 * is the smaller, safer reduction — it deletes only non-executable text and
 * leaves every executable form intact. Applies YAML's actual comment rule (`#`
 * at line start or after whitespace), so a `#` inside a quoted command survives.
 */
function ciExecutableText(): string {
  return readFileSync(CI_YML, "utf8")
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .join("\n");
}

describe("Redis-gated suites are wired into CI", () => {
  it("finds the ci.yml this guard reads", () => {
    // Cheap, but it is what stops the whole guard passing vacuously if the
    // workflow is ever moved or renamed — an unreadable file would otherwise
    // just make every `includes` check moot.
    expect(readFileSync(CI_YML, "utf8").length).toBeGreaterThan(0);
  });

  it("strips the commentary that would otherwise satisfy the check", () => {
    // The reduction itself needs a guard: if ciExecutableText ever stopped
    // stripping, every assertion below would silently go back to being
    // satisfiable by prose. ci.yml's comment block above the Redis steps names
    // both suites, so `npm test` (only ever in a `run:`) must survive while
    // that commentary does not.
    const exec = ciExecutableText();
    expect(exec).toContain("npm test");
    expect(exec).not.toContain("Redis-gated, so they still self-skip here");
  });

  it("finds at least one Redis-gated suite to check", () => {
    // The other half of the vacuity guard: a walk that silently matched
    // nothing (wrong SRC root, changed naming convention) would make the
    // assertion below trivially true for ever.
    expect(redisSuites().length).toBeGreaterThan(0);
  });

  it("names every *.redis.test.ts file in an executable ci.yml step", () => {
    const ci = ciExecutableText();
    const unwired = redisSuites().filter((p) => !ci.includes(basename(p)));
    // Matched on the BASENAME, not the src-relative path: how a step spells the
    // path (`src/lib/...` under a workspace run vs an absolute one) is not the
    // contract — "CI mentions this file at all" is. The message names the file
    // because the fix is to add a step, and the person who just added the suite
    // is the one who needs telling.
    expect(unwired, `not run by any ci.yml step: ${unwired.join(", ")}`).toEqual([]);
  });
});
