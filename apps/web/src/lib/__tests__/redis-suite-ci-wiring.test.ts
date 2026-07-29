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

/**
 * Split comment-stripped ci.yml text into one block per YAML step, across
 * every job's `steps:` list.
 *
 * #316: the guard used to compare two GLOBAL counts (suites found vs.
 * `REDIS_URL:` occurrences anywhere in the file) — heuristic in both
 * directions. Two suites consolidated into one properly-wired step would
 * false-FAIL it (fewer REDIS_URL occurrences than suites, even though the one
 * step covers both). Worse, a suite wired into a step that never sets
 * REDIS_URL would false-PASS it, as long as SOME OTHER unrelated step in the
 * file happens to set REDIS_URL for its own reason — the count never checks
 * WHICH step. Per-step correlation below fixes both: it asks, for each
 * suite, "does the step naming it also set REDIS_URL itself?"
 *
 * A step is a YAML list item under a `steps:` key: it starts at a line
 * indented exactly two spaces deeper than `steps:` itself, matching `- `,
 * and its body is every line after that until the next such line or a
 * dedent back to (or above) the `steps:` line's own indent. Job-level `env:`
 * (declared BEFORE `steps:` in every job in this file) is therefore never
 * inside a step block — a job-wide REDIS_URL would not satisfy the
 * per-step check below, which is exactly the property the comment at
 * ci.yml's Redis steps relies on (REDIS_URL deliberately NOT job-wide).
 */
function stepBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const stepsMatch = lines[i].match(/^(\s*)steps:\s*$/);
    if (!stepsMatch) {
      i++;
      continue;
    }
    const stepsIndent = stepsMatch[1].length;
    const itemIndent = stepsIndent + 2;
    i++;
    let current: string[] = [];
    const flush = () => {
      if (current.length) blocks.push(current.join("\n"));
      current = [];
    };
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") {
        current.push(line);
        i++;
        continue;
      }
      const indent = line.match(/^(\s*)/)![1].length;
      if (indent <= stepsIndent) break; // dedented out of this steps: list
      const isNewItem = indent === itemIndent && /^-\s/.test(line.slice(itemIndent));
      if (isNewItem) flush();
      current.push(line);
      i++;
    }
    flush();
  }
  return blocks;
}

/** Does this step's OWN text set REDIS_URL (as opposed to some other step,
 *  or the job-level env: block, which stepBlocks already excludes)? */
function stepSetsRedisUrl(block: string): boolean {
  return /(^|\n)\s*REDIS_URL:/.test(block);
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

  it("gives each Redis-gated suite a step that BOTH names it and sets its own REDIS_URL", () => {
    // Naming the file is not enough. These suites gate on
    // `!HAS_DB || !HAS_REDIS`, so a suite wired into a step WITHOUT REDIS_URL
    // self-skips and reports green — the same silent no-op as never wiring it
    // at all, and harder to spot because the filename is right there in the
    // workflow. #316 strengthened this from a global-count comparison (see the
    // fixture test below for exactly what that missed) to per-step
    // correlation: for each suite, is there a step whose OWN body names it
    // AND sets REDIS_URL?
    const blocks = stepBlocks(ciExecutableText());
    const uncorrelated = redisSuites().filter((p) => {
      const name = basename(p);
      return !blocks.some((b) => b.includes(name) && stepSetsRedisUrl(b));
    });
    expect(
      uncorrelated,
      `no step both names and sets REDIS_URL for: ${uncorrelated.join(", ")}`,
    ).toEqual([]);
  });

  it("catches what a global REDIS_URL count would miss: a suite named in a step with no REDIS_URL of its own", () => {
    // #316's exact false-negative, reproduced on a literal fixture rather than
    // real ci.yml — real ci.yml is expected to stay correctly wired, so this
    // asserts the RULE, not today's file. Two suites; the file sets REDIS_URL
    // twice — enough to satisfy "global count >= suite count" — but the
    // second suite's own step never sets it. The old heuristic (kept here
    // only as `globalCount`, not as a guard) would have called this fixture
    // clean.
    const fixture = [
      "jobs:",
      "  smoke:",
      "    env:",
      "      REDIS_URL: redis://job-level-decoy:6379", // job-level env — NOT step-scoped
      "    steps:",
      "      - name: Rate limiter",
      "        run: npm test -- run src/lib/__tests__/rate-limit.redis.test.ts",
      "        env:",
      "          REDIS_URL: redis://localhost:6379",
      "      - name: Entitlement cache invalidation",
      "        run: npm test -- run src/lib/__tests__/entitlements-cache-invalidation.redis.test.ts",
      // No REDIS_URL in THIS step. A step further down the file setting it
      // for an unrelated reason is what the global count could not tell apart
      // from this step setting it itself.
      "      - name: unrelated step that also happens to set REDIS_URL",
      "        run: echo hi",
      "        env:",
      "          REDIS_URL: redis://localhost:6379",
    ].join("\n");

    const suites = [
      "src/lib/__tests__/rate-limit.redis.test.ts",
      "src/lib/__tests__/entitlements-cache-invalidation.redis.test.ts",
    ];

    // The OLD heuristic on this fixture: 2 suites, 3 `REDIS_URL:` occurrences
    // (including the job-level one) — "enough", and wrongly green.
    const globalCount = (fixture.match(/REDIS_URL:/g) ?? []).length;
    expect(globalCount).toBeGreaterThanOrEqual(suites.length);

    // The NEW per-step correlation catches it: the second suite's own step
    // block never sets REDIS_URL, so it comes back uncorrelated.
    const blocks = stepBlocks(fixture);
    const uncorrelated = suites.filter((s) => {
      const name = basename(s);
      return !blocks.some((b) => b.includes(name) && stepSetsRedisUrl(b));
    });
    expect(uncorrelated).toEqual(["src/lib/__tests__/entitlements-cache-invalidation.redis.test.ts"]);
  });
});
