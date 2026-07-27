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
function stripComments(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .join("\n");
}

function ciExecutableText(): string {
  return stripComments(readFileSync(CI_YML, "utf8"));
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
    // satisfiable by prose.
    //
    // Asserted against a LITERAL FIXTURE, not against ci.yml's own prose. An
    // earlier version pinned a real sentence from the workflow's comment block,
    // which made an unrelated reword of that comment fail this test — and, worse,
    // made the guard silently vacuous the moment someone "fixed" it by deleting
    // the sentence. The rule is what is being tested, so the rule gets its own
    // input: executable text survives, comments do not, and a `#` inside a
    // quoted command is not a comment (YAML's actual rule).
    const fixture = [
      "# a whole comment line naming decoy-fixture.redis.test.ts",
      "      - name: keep me",
      "        run: npm test -- src/lib/__tests__/kept-fixture.redis.test.ts # trailing note",
      "        run: curl https://example.test/spec#anchor-not-a-comment",
    ].join("\n");
    const stripped = stripComments(fixture);

    // Executable text survives, including a multi-token `run:` line...
    expect(stripped).toContain("run: npm test -- src/lib/__tests__/kept-fixture.redis.test.ts");
    expect(stripped).toContain("- name: keep me");
    // ...and a `#` with no whitespace before it is part of the token, not a
    // comment, so a fragment in a URL is not silently truncated.
    expect(stripped).toContain("https://example.test/spec#anchor-not-a-comment");
    // Commentary does not survive — including the filename it named, which is
    // the whole reason this stripping exists.
    expect(stripped).not.toContain("a whole comment line");
    expect(stripped).not.toContain("decoy-fixture.redis.test.ts");
    expect(stripped).not.toContain("trailing note");
    // And the real reader is wired to that same rule rather than reimplementing it.
    expect(ciExecutableText()).toContain("npm test");
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

  it("gives each Redis-gated suite a step that actually owns REDIS_URL", () => {
    // Naming the file is not enough. These suites gate on
    // `!HAS_DB || !HAS_REDIS`, so a suite wired into a step WITHOUT REDIS_URL
    // self-skips and reports green — the same silent no-op as never wiring it
    // at all, and harder to spot because the filename is right there in the
    // workflow. REDIS_URL is deliberately step-scoped (job-wide breaks the
    // src/server suites), so there must be at least one step-scoped occurrence
    // per suite.
    const exec = ciExecutableText();
    const withRedisUrl = exec.split("REDIS_URL:").length - 1;
    expect(
      withRedisUrl,
      `${redisSuites().length} Redis-gated suite(s) but only ${withRedisUrl} step(s) set REDIS_URL`,
    ).toBeGreaterThanOrEqual(redisSuites().length);
  });
});
