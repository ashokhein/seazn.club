// A per-test `{ timeout: N }` (or `{ retry: N }`) SILENTLY OVERRIDES
// `--testTimeout` / `--retry` on the CLI. That is the non-obvious part, and it
// is what made #363 expensive to diagnose: someone hits a CI timeout, passes
// the documented flag, watches the suite fail identically, and reasonably
// concludes the test hangs rather than that their flag was ignored.
//
// `1ad49d5e` (#363) gave `vitest.config.ts` a real `testTimeout: 30_000` /
// `hookTimeout: 30_000` default, so the repo now has a config the whole suite
// shares instead of a hand-typed habit. Nothing stops the next file (or the
// next line in an existing file) from pinning its own inline timeout again —
// and if it does, it becomes a file whose timeout nobody can tune from
// outside, silently. This scans for exactly that re-creation.
//
// Vitest's own types are the reason this is scoped to `it`/`test`/`describe`
// and to the OBJECT-LITERAL form only:
//   - `it`/`test`/`describe` accept `(name, options, fn)` where `options` can
//     carry `{ timeout, retry, ... }` — this is the shape #363 actually used
//     and the one this file finds live in the repo today.
//   - `beforeAll`/`afterAll`/`beforeEach`/`afterEach` accept only a bare
//     NUMBER as a third argument (`fn, timeout?: number`) — no object form
//     exists for hooks, so `{ timeout }` there is already a type error tsc
//     catches on its own; a bare numeric hook-level pin is the same class of
//     footgun but out of scope here (issue #370 asked for the object-literal
//     shape specifically, and no instance of the numeric form exists in the
//     repo as of this writing — `grep -E '\b(before|after)(All|Each)\([^)]*,
//     \s*[0-9]'` finds none).
//
// Source-scanning rather than an ESLint rule, per #370: the pattern is a
// property in an object-literal argument, which a small hand-rolled arg
// parser handles fine and a custom rule would not repay the cost of writing.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SRC = path.resolve(__dirname, "../..");

/** Every `*.test.ts`/`*.test.tsx` under src (this file included — it never
 *  pins its own timeout, so scanning it is harmless). */
function testFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      testFiles(full, out);
    } else if (/\.test\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// A small hand-rolled parser for exactly the surface this needs: given the
// index of an opening '(', find the index of its matching ')', respecting
// strings (including template-literal `${...}` interpolation), line comments,
// and block comments — the same reasoning admin-audit-actor-truth.test.ts
// gives for NOT trying to be a full JS parser, applied one level deeper
// because here the thing being balanced is the argument LIST, not a fixed
// window after it.
// ---------------------------------------------------------------------------

/** src[i] is the opening quote (`'`, `"`, or `` ` ``). Returns the index of
 *  the matching closing quote, skipping escapes and `${...}` interpolation. */
function skipString(src: string, i: number, quote: string): number {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === quote) return j;
    if (quote === "`" && c === "$" && src[j + 1] === "{") {
      j = skipBraces(src, j + 1) + 1;
      continue;
    }
    j++;
  }
  return j;
}

/** src[i] is an opening '{'. Returns the index of its matching '}'. */
function skipBraces(src: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === "'" || c === '"' || c === "`") {
      j = skipString(src, j, c);
      j++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return j;
    }
    j++;
  }
  return j;
}

/** src[i] is an opening '('. Returns the index of its matching ')'. */
function findParenEnd(src: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === "'" || c === '"' || c === "`") {
      j = skipString(src, j, c);
      j++;
      continue;
    }
    if (c === "/" && src[j + 1] === "/") {
      const nl = src.indexOf("\n", j);
      j = nl === -1 ? src.length : nl;
      continue;
    }
    if (c === "/" && src[j + 1] === "*") {
      const end = src.indexOf("*/", j + 2);
      j = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return j;
    }
    j++;
  }
  return src.length - 1;
}

/** Splits an argument-list body on top-level commas only. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"' || c === "`") {
      i = skipString(s, i, c);
      i++;
      continue;
    }
    if (c === "/" && s[i + 1] === "/") {
      const nl = s.indexOf("\n", i);
      i = nl === -1 ? s.length : nl;
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(s.slice(start));
  return parts;
}

/** Matches a bare (un-chained) call, `it.only(`, `it.each(`, `describe.skipIf(`,
 *  etc. — the chain suffix is resolved below by following curried calls. */
const CALL_RE = /\b(it|test|describe)(?:\.\w+)*\s*\(/g;

interface Violation {
  file: string;
  line: number;
  testName: string;
  snippet: string;
}

/** True if `//` appears on the match's own line before the match starts —
 *  i.e. the call site itself is commented out. (Block comments spanning into
 *  the line are not handled; a false positive from one fails loudly, per the
 *  same over-inclusive-by-design reasoning admin-audit-actor-truth.test.ts
 *  documents, rather than silently hiding a real pin.) */
function isLineCommentedOut(src: string, matchIndex: number): boolean {
  const lineStart = src.lastIndexOf("\n", matchIndex) + 1;
  const before = src.slice(lineStart, matchIndex);
  return before.includes("//");
}

function scanFile(absPath: string, relPath: string): Violation[] {
  const src = fs.readFileSync(absPath, "utf8");
  const violations: Violation[] = [];
  let m: RegExpExecArray | null;
  CALL_RE.lastIndex = 0;
  while ((m = CALL_RE.exec(src))) {
    if (isLineCommentedOut(src, m.index)) continue;
    const openIdx = m.index + m[0].length - 1;
    let bodyStart = openIdx + 1;
    let bodyEnd = findParenEnd(src, openIdx);
    // Follow curried chains — `it.each(table)(name, fn, opts)`,
    // `describe.skipIf(cond)(name, fn)` — whose REAL test args are in the
    // call that follows the first one, not the table/condition argument.
    let cursor = bodyEnd + 1;
    for (;;) {
      let j = cursor;
      while (j < src.length && /\s/.test(src[j]!)) j++;
      if (src[j] !== "(") break;
      const nextEnd = findParenEnd(src, j);
      bodyStart = j + 1;
      bodyEnd = nextEnd;
      cursor = nextEnd + 1;
    }
    const body = src.slice(bodyStart, bodyEnd);
    const args = splitTopLevel(body);
    const firstArg = (args[0] ?? "").trim();
    const openQuote = firstArg[0];
    let testName = "(unnamed)";
    if (openQuote === '"' || openQuote === "'" || openQuote === "`") {
      // Reuses the same string-skipper used for arg parsing, so a test name
      // containing an escaped or nested-backtick character is captured in
      // full rather than truncated at the first lookalike delimiter.
      const closeIdx = skipString(firstArg, 0, openQuote);
      testName = firstArg.slice(1, closeIdx);
    }
    for (const arg of args) {
      const trimmed = arg.trim();
      if (!trimmed.startsWith("{")) continue; // not an options object — the callback fn, a name, or a table
      if (!/\b(timeout|retry)\s*:/.test(trimmed)) continue;
      const line = src.slice(0, bodyStart).split("\n").length;
      violations.push({ file: relPath, line, testName, snippet: trimmed.slice(0, 80) });
    }
  }
  return violations;
}

/**
 * Allowlist for genuine exceptions: a deliberately slow integration case that
 * truly needs its own bound beyond the repo-wide default. Keyed on
 * `${relativeFile}::${testName}` rather than line number, so unrelated edits
 * above the pin don't rot the entry — only the pin's removal, or the test's
 * rename, does.
 *
 * This list may only ever SHRINK: the second test below fails if an entry
 * stops matching a real pin, so a fixed file cannot leave a stale exemption
 * behind to hide the next one. It is empty right now — see the guard's
 * current finding in the task report for what it found instead of being
 * allowlisted here.
 */
const ALLOWLIST: Readonly<Record<string, string>> = {};

describe("no test/hook re-pins an inline timeout or retry (#370)", () => {
  // Excludes this file itself: its synthetic sample string below deliberately
  // contains the literal shape being scanned for, as plain text inside a
  // template literal the OUTER file's naive text scan can't tell apart from
  // real code — the same reason admin-audit-actor-truth.test.ts's own scanner
  // excludes its writer file, one level removed (there it's "don't flag the
  // reference implementation"; here it's "don't flag your own fixture text").
  const SELF = path.basename(__filename);
  const files = testFiles(SRC).filter((f) => path.basename(f) !== SELF);

  it("finds a plausible number of test files", () => {
    // Guards the guard: a wrong root would iterate nothing and pass every
    // assertion below vacuously — the exact failure shape this repo keeps
    // having to relearn (migration-header-truth.test.ts,
    // admin-audit-actor-truth.test.ts).
    expect(files.length).toBeGreaterThan(400);
  });

  it("recognizes the planted-pin shape on a synthetic sample, so the parser is not silently matching nothing", () => {
    // Independent of any real file on disk: proves scanFile finds the exact
    // shape #363 removed and this guard exists to catch, in all three
    // positions a chained call can put it, and does NOT flag ordinary calls
    // (a plain `it(name, fn)`, or an in-body call to an unrelated function
    // that merely happens to take a `{ timeout }` option, like `sql.end` or
    // `vi.waitFor`).
    const sample = `
      it("plain test, no pin", () => {
        vi.waitFor(() => expect(1).toBe(1), { timeout: 5000 });
        return sql.end({ timeout: 5 });
      });
      it("direct pin", { timeout: 60_000 }, () => { doWork(); });
      test("retry pin", { retry: 2 }, async () => { doWork(); });
      it.each([1, 2])("each pin %i", (n) => { doWork(n); }, { timeout: 1000 });
      describe.skipIf(!HAS_DB)("chained pin", { timeout: 9000 }, () => {
        it("nested, unrelated", () => { sql.end({ timeout: 5 }); });
      });
      // it("commented out pin", { timeout: 1 }, () => {});
    `;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inline-timeout-truth-"));
    const file = path.join(dir, "sample.test.ts");
    fs.writeFileSync(file, sample);
    try {
      const found = scanFile(file, "sample.test.ts").map((v) => v.testName);
      expect(found.sort()).toEqual(["chained pin", "direct pin", "each pin %i", "retry pin"].sort());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no it/test/describe call pins its own { timeout } or { retry } outside the allowlist", () => {
    const unexplained: string[] = [];
    for (const file of files) {
      const relPath = path.relative(SRC, file);
      for (const v of scanFile(file, relPath)) {
        const key = `${relPath}::${v.testName}`;
        if (key in ALLOWLIST) continue;
        unexplained.push(`${relPath}:${v.line} — "${v.testName}" — ${v.snippet}`);
      }
    }
    expect(unexplained).toEqual([]);
  });

  it("the allowlist holds nothing that has stopped needing it", () => {
    // The mirror of the check above: a stale entry silently permits a pin
    // that no longer exists (or was renamed), and would hide a real new one
    // that reused the same key.
    const liveKeys = new Set<string>();
    for (const file of files) {
      const relPath = path.relative(SRC, file);
      for (const v of scanFile(file, relPath)) liveKeys.add(`${relPath}::${v.testName}`);
    }
    const stale = Object.keys(ALLOWLIST).filter((k) => !liveKeys.has(k));
    expect(stale).toEqual([]);
  });
});
