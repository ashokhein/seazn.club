// Loading half of the help-article truth-in-copy guards (v17 gap wave 7).
//
// Not a `*.test.ts`: this is imported by `help-copy-truth.test.ts` and is meant
// to be imported by task 7's dictionary guards too, and a suite that exports
// its fixtures makes every importer re-run it. Same reason `@/lib/copy-truth`
// is a plain module — see its header. (Precedent in this directory:
// `_billing-group.ts`.)
//
// The fs read lives HERE rather than in `@/lib/copy-truth` so that nothing under
// `src/lib` proper gains a `node:fs` import: that module is one careless
// `import` away from a client component, and `fs` in a client bundle fails at
// build time, not at test time.
import type * as TS from "typescript";
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { HELP_ROOT } from "@/server/help-content";

/**
 * `typescript` is loaded through `createRequire`, NOT a static import.
 *
 * Vite transforms every statically imported module, and `typescript.js` is a
 * ~10 MB CommonJS bundle it refuses outright ("Failed to parse source for
 * import analysis"), which fails the whole suite at COLLECTION — a zero-test
 * run, not a red test. A runtime require is invisible to the transform
 * pipeline and loads the same module Node would.
 */
const ts: typeof TS = createRequire(import.meta.url)("typescript");

/** Taken from `HELP_ROOT`, never re-derived: a second copy of the path is a
 *  second thing to keep in step, and a wrong one reads as "no faults found".
 *  (`lib/help.ts` holds only the client-safe slug registry; the filesystem root
 *  lives in the server module.) The help tree is a single English Markdown tree
 *  with no locale segment, so there is one file per slug and no four-locale
 *  fan-out to scan. */
export const HELP_BILLING_DIR = join(HELP_ROOT, "billing");

/**
 * One help article by FULL SLUG (`billing/groups`), frontmatter INCLUDED.
 *
 * `allHelpArticles()` returns `markdown: body` — `parseFrontmatter` has already
 * removed the `---` block — so anything built on it is blind to `title:` and
 * `description:`. That is not theoretical: `groups.md`'s frontmatter carried
 * the extra-organisation falsehood, `description` is rendered as the lead
 * paragraph, the page metadata AND the search snippet, and the inventory
 * digests are taken over `claimSurfaces`, which pins frontmatter fields. A gate
 * fed the stripped body disagrees with its own fixture on every surface.
 */
export function helpArticleBySlug(slug: string): string {
  const text = readFileSync(join(HELP_ROOT, `${slug}.md`), "utf8");
  if (text.trim().length === 0) throw new Error(`content/help/${slug}.md is empty`);
  return text;
}

/** One billing help article's raw Markdown, frontmatter included. Throws on a
 *  missing file rather than returning "" — an empty string would scan clean and
 *  every guard in this wave would report no faults. */
export function helpArticle(slug: string): string {
  const text = readFileSync(join(HELP_BILLING_DIR, `${slug}.md`), "utf8");
  if (text.trim().length === 0) throw new Error(`content/help/billing/${slug}.md is empty`);
  return text;
}

/**
 * A source file under `apps/web/src`, for the guards that pin a PROSE claim to
 * the code that decides it.
 *
 * Reading source rather than calling the function is deliberate and is the
 * narrower of two bad options. The claims in question are about what the code
 * DOES NOT do — "an extra organisation does not freeze anything", "the charge
 * lands on your next invoice, not now" — and a negative like that has no return
 * value to assert on. Exercising it would mean standing up Stripe and an
 * over-cap group to prove that nothing happens.
 *
 * The failure mode is a rename making a guard vacuous, so every caller asserts
 * a known-positive on the same read (the keys that ARE freeze axes, the
 * proration mode that IS used) before asserting the negative. A rename then
 * reds the positive instead of silently passing the negative.
 *
 * Throws on a missing file: `""` would scan clean and every rule built on it
 * would report no faults.
 */
export function webSource(relativePath: string): string {
  const text = readFileSync(join(process.cwd(), "src", relativePath), "utf8");
  if (text.trim().length === 0) throw new Error(`src/${relativePath} is empty`);
  return text;
}

/**
 * Every `.ts`/`.tsx` under `apps/web/src`, as `[pathRelativeToSrc, source]`.
 *
 * For the guards that assert a piece of prose is still true of the UI — most
 * of them NEGATIVE ("there is no control for this yet"), which no unit test can
 * demonstrate by calling something. A walk is used rather than a hand-written
 * list precisely because the thing being watched for is a file nobody has
 * written yet.
 *
 * Callers must assert a known-positive against the same result (a file they
 * know exists, a floor on the count), or a wrong root silently returns an empty
 * list and every negative built on it passes.
 */
export function allSourceFiles(): Array<[string, string]> {
  if (sourceCache) return sourceCache;
  sourceCache = walkSourceFiles();
  return sourceCache;
}

let sourceCache: Array<[string, string]> | null = null;
let strippedCache: Array<[string, StrippedSource]> | null = null;

/**
 * `allSourceFiles()` with every file's comments already blanked, computed ONCE.
 *
 * Parsing ~1,400 files with the TypeScript parser is not free, and three
 * callers each re-walking the tree and re-parsing it pushed a guard past
 * vitest's 5s default under full-suite CPU contention — it passed alone and
 * timed out in the full run, which is the worst way for a guard to fail. Both
 * layers are memoised: the disk walk and the strip.
 */
export function allStrippedSources(): Array<[string, string]> {
  return allAuditedSources().map(([file, s]) => [file, s.code]);
}

/** The same walk, keeping each file's literal spans so the strip can be
 *  audited per file rather than trusted. */
export function allAuditedSources(): Array<[string, StrippedSource]> {
  if (strippedCache) return strippedCache;
  strippedCache = allSourceFiles().map(([file, source]) => [file, stripComments(source, file)]);
  return strippedCache;
}

function walkSourceFiles(): Array<[string, string]> {
  const root = join(process.cwd(), "src");
  const out: Array<[string, string]> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dictionaries") continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push([relative(root, full), readFileSync(full, "utf8")]);
      }
    }
  };
  walk(root);
  if (out.length === 0) throw new Error("no source files found under src/ — wrong cwd?");
  return out;
}

/**
 * A source file with its comments BLANKED — same length, same line numbering,
 * every comment replaced by spaces — plus the spans of every STRING-shaped
 * literal it contains, so a caller can audit what was blanked.
 *
 * A guard that asserts an idiom is ABSENT must not read prose, or it fires on
 * the comment explaining why the idiom is absent — which is what happened when
 * `billing-groups.ts`'s stale "charged immediately" note was corrected: the
 * correction has to name `always_invoice`, and the negative scan then failed on
 * its own explanation.
 *
 * ── WHY THIS USES THE TYPESCRIPT PARSER ──────────────────────────────────────
 * The first version was a hand-rolled scanner that ran a block-comment regex
 * over the whole file BEFORE tracking strings, so a comment-opener inside a
 * string literal opened a phantom comment that swallowed everything up to the
 * next closer. That was not hypothetical: `components/v2/division-settings.tsx`
 * contains `accept="image/*"`, and the regex ate 11,384 characters — 198 lines
 * — of live production code. A planted call inside that span was invisible to
 * the call-site walk while the suite stayed green.
 *
 * Every hand-rolled alternative has the same shape of hole: a regex literal
 * containing `//` (`/https?:\/\//`) truncates a line, a template literal
 * spanning lines desynchronises the quote state, JSX text is neither. So the
 * comment ranges come from the compiler that already has to be right about
 * them, and the transformation is BLANKING rather than deletion so that
 * offsets and line numbers still match the original — a fault message quoting
 * a line number stays true.
 *
 * `literals` is returned rather than derived by the caller because it comes off
 * the SAME parse: one walk, and the audit below can then ask the question that
 * actually matters — did anything outside a comment get blanked? — without
 * re-deriving comment ranges, which would make the check circular.
 */
export interface StrippedSource {
  code: string;
  /** `[start, end)` of every string, template and regex literal. */
  literals: Array<[number, number]>;
}

export function stripComments(source: string, fileName = "file.tsx"): StrippedSource {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out = source.split("");
  const literals: Array<[number, number]> = [];
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] !== "\n" && out[i] !== "\r") out[i] = " ";
    }
  };
  const done = new Set<string>();
  const take = (ranges: readonly TS.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) {
      const key = `${range.pos}:${range.end}`;
      if (done.has(key)) continue;
      done.add(key);
      blank(range.pos, range.end);
    }
  };
  const visit = (node: TS.Node): void => {
    take(ts.getLeadingCommentRanges(source, node.getFullStart()));
    take(ts.getTrailingCommentRanges(source, node.getEnd()));
    // The literal PARTS only. `isTemplateExpression` spans the whole template
    // INCLUDING its `${…}` expressions, and a comment inside one of those is a
    // real comment that must be blanked — pointing the audit at the wide span
    // reported two false faults in `server/usecases/schedule-ai.ts` the first
    // time it ran. Head/middle/tail are the inert text between the holes.
    if (
      ts.isStringLiteralLike(node) ||
      ts.isRegularExpressionLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      literals.push([node.getStart(sourceFile), node.getEnd()]);
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  // The file's own leading block, which belongs to no node's full start when
  // the file begins with trivia.
  take(ts.getLeadingCommentRanges(source, 0));
  return { code: out.join(""), literals };
}

/** Just the code, for the many callers that do not audit. */
export function codeOnly(source: string, fileName = "file.tsx"): string {
  return stripComments(source, fileName).code;
}

/**
 * THE RECURRENCE GUARD, and the reason the previous one was worthless.
 *
 * Round 4 replaced the swallowing bug with a per-file check that
 * `stripped.length === raw.length` and the line count matched. Both are TRUE
 * FOR EVERY INPUT — `stripComments` blanks into `source.split("")`, so it
 * cannot change either. It was a guard that examined nothing while its comment
 * claimed it made a swallowed span "impossible to miss", which is the sixth
 * time this wave has produced exactly that shape, and the first time I produced
 * it while fixing an instance of it.
 *
 * This asks the question that actually distinguishes a correct strip from the
 * bug: **every character that changed must lie inside a comment, and therefore
 * OUTSIDE every string-shaped literal.** The literal spans come from the AST,
 * not from the comment ranges, so the check is independent of the decision it
 * is checking rather than a restatement of it. The historical bug blanked from
 * a `/*` sitting inside `"image/*"` — squarely inside a literal — so it fails
 * this loudly, and so does any future variant that eats code.
 *
 * Returns readable faults rather than a boolean so a failure names the file and
 * the text that was destroyed.
 */
export function blankedInsideLiteralFaults(
  file: string,
  raw: string,
  stripped: StrippedSource,
): string[] {
  if (stripped.code.length !== raw.length) {
    return [`${file}: strip changed the length (${raw.length} -> ${stripped.code.length})`];
  }
  const faults: string[] = [];
  for (const [start, end] of stripped.literals) {
    for (let i = start; i < end; i += 1) {
      if (stripped.code[i] === raw[i]) continue;
      faults.push(
        `${file}: characters inside a string/regex/JSX literal at offset ${start}-${end} were blanked — ` +
          `the strip is eating code, not comments. Destroyed: ${JSON.stringify(raw.slice(start, Math.min(end, start + 80)))}`,
      );
      break;
    }
  }
  return faults;
}

// ── `why` citations ──────────────────────────────────────────────────────────

/**
 * Every source location a `why` names, checked against the disk.
 *
 * A `why` IS LOAD-BEARING CODE. It is what somebody reads at the moment they
 * decide whether to approve a change to a customer-facing claim — the inventory
 * gate's entire instruction is "read your new wording against the code named in
 * the `why`". A `why` that points at a file which does not exist sends that
 * reader nowhere, and they approve on the strength of a citation instead of on
 * the strength of a reading.
 *
 * This is the SEVENTH round in which the review found `why` defects, and every
 * previous fix was by hand, one citation at a time. Two of the twenty-one found
 * this round were files that have never existed in this repo
 * (`usecases/orgs.ts`, `usecases/competition-passes.ts`) — a class a machine can
 * settle once and for all, which is what this does.
 *
 * WHAT IT CHECKS, AND WHAT IT DELIBERATELY DOES NOT:
 *  - the file EXISTS (resolved by unique path-suffix against the real tree, so
 *    `billing-groups.ts` and `usecases/billing-groups.ts` both resolve);
 *  - a cited line or range is IN RANGE for that file.
 *
 * It cannot check that the cited line says what the `why` claims it says — that
 * is a reading, and eighteen of this round's defects were exactly that (ten
 * citations into `billing-groups.ts`, all short by the same 21 lines after one
 * edit moved the function). So this closes the "points nowhere" class and leaves
 * the "points at the wrong line" class to the reviewer, which is the honest
 * division rather than a rule that pretends to more than it does.
 */
export interface Citation {
  /** Where the citation was written. */
  origin: string;
  /** The path as cited. */
  path: string;
  from: number | null;
  to: number | null;
}

/** `foo/bar.ts`, `bar.tsx:12`, `baz.md:40-52` — anywhere in a source file.
 *  `tsx` BEFORE `ts` in the alternation: the other order matches "api-keys.ts"
 *  out of "api-keys.tsx" and then reports a real file as missing. */
const CITATION = /(?<![\w./-])((?:[\w.[\]-]+\/)*[\w.[\]-]+\.(?:tsx|ts|json|md|sql))(?::(\d+)(?:-(\d+))?)?/g;

/** Every citation written in `source`, tagged with `origin`. */
export function citationsIn(origin: string, source: string): Citation[] {
  const out: Citation[] = [];
  for (const m of source.matchAll(CITATION)) {
    out.push({
      origin,
      path: m[1]!,
      from: m[2] ? Number(m[2]) : null,
      to: m[3] ? Number(m[3]) : m[2] ? Number(m[2]) : null,
    });
  }
  return out;
}

let repoIndexCache: Map<string, string[]> | null = null;

/**
 * The repository root, found by CLIMBING from cwd until a directory contains
 * both `apps/web` and `package.json` — never by counting `..` segments.
 *
 * `join(process.cwd(), "..", "..")` is correct only when cwd is exactly
 * `apps/web`. Run through `vitest --root apps/web` from the repo root, cwd
 * stays at the root and `../..` climbs ABOVE the repository — the walk then
 * indexes some unrelated ancestor directory and the citation check reports
 * faults for every real file. Measured: 16 phantom failures that way, 0 via
 * `npm test --workspace apps/web -- run …`.
 *
 * Throwing is the point. A guard that silently walks the wrong tree is worse
 * than one that stops: this one decides whether other people's fixture prose is
 * trustworthy, and "found nothing, all clear" is the answer nobody should ever
 * get from it by accident.
 */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "apps", "web")) && existsSync(join(dir, "package.json"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `cannot locate the repo root from ${process.cwd()} — run tests from apps/web (or via \`npm test --workspace apps/web\`), not with \`vitest --root apps/web\``,
  );
}

/** basename -> every repo-relative path with that basename. Walks the whole
 *  repo, not just `src`, because citations legitimately reach `content/help`,
 *  `db/migration` and the e2e specs. */
function repoIndex(): Map<string, string[]> {
  if (repoIndexCache) return repoIndexCache;
  const root = repoRoot();
  const index = new Map<string, string[]>();
  const skip = new Set(["node_modules", ".git", ".next", "dist", ".claude", "coverage"]);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const list = index.get(entry.name) ?? [];
        list.push(relative(root, full));
        index.set(entry.name, list);
      }
    }
  };
  walk(root);
  repoIndexCache = index;
  return index;
}

/**
 * Faults for every citation that resolves to no file, or names a line the file
 * does not have.
 *
 * `known` is an allowlist of paths that are deliberately not repo files (a
 * migration named in prose, a doc that lives outside the tree). Each entry must
 * be USED — an allowlist entry naming a citation nobody writes any more is
 * itself a fault, or the list becomes the place stale things go to hide.
 */
export function citationFaults(citations: Citation[], known: readonly string[] = []): string[] {
  const index = repoIndex();
  const faults: string[] = [];
  const usedKnown = new Set<string>();
  for (const c of citations) {
    if (known.includes(c.path)) {
      usedKnown.add(c.path);
      continue;
    }
    const base = c.path.slice(c.path.lastIndexOf("/") + 1);
    const matches = (index.get(base) ?? []).filter((p) => p.endsWith(c.path));
    if (matches.length === 0) {
      faults.push(`${c.origin}: cites "${c.path}", which is not a file in this repo`);
      continue;
    }
    // AMBIGUITY IS A FAULT, not a coin toss. Taking `matches[0]` line-checks
    // against whichever path the directory walk happened to reach first: bare
    // `auth.ts` resolves to BOTH `lib/auth.ts` (456 lines) and
    // `server/api-v1/auth.ts` (347), so `auth.ts:400` validates or fails
    // depending on walk order — wrong in both directions. Bare `page.tsx`
    // resolves 107 ways. A reader following an ambiguous citation has the same
    // problem the checker does, so the fix is the same: qualify the path.
    if (matches.length > 1) {
      faults.push(
        `${c.origin}: cites "${c.path}", which is ambiguous — ${matches.length} files match (${matches.slice(0, 3).join(", ")}${matches.length > 3 ? ", …" : ""}). Qualify the path.`,
      );
      continue;
    }
    if (c.from === null) continue;
    const lines = readFileSync(join(repoRoot(), matches[0]!), "utf8").split("\n").length;
    if (c.to! > lines) {
      faults.push(
        `${c.origin}: cites "${c.path}:${c.from}${c.to === c.from ? "" : `-${c.to}`}", but ${matches[0]} has ${lines} lines`,
      );
    }
  }
  for (const path of known) {
    if (!usedKnown.has(path)) {
      faults.push(`the citation allowlist names "${path}", which no why cites any more — remove it`);
    }
  }
  return faults;
}

// ── The seat freeze's real reach ─────────────────────────────────────────────

/**
 * Every `headers: { … }` object literal in a source file, as written.
 *
 * READ OFF THE AST, not a regex, and this is the twelfth normaliser hole in
 * this wave. Fix round 6 used `matchAll(/headers:\s*\{([^}]*)/g)`, and `[^}]*`
 * stops at the FIRST `}` — which in the two files that matter is the one in the
 * spread:
 *
 *     headers: { "Content-Type": "application/json", ...(rest.headers ?? {}) },
 *
 * so everything after `?? {` was invisible. Measured: an `Authorization` header
 * added AFTER the spread in `components/api-keys.tsx` shipped 285/0 GREEN,
 * while the identical header in `components/org-sponsors.tsx`'s plain object
 * redded. The guard was blind exactly where the code is interesting.
 *
 * The AST also fixes the false-red that made the regex look necessary in the
 * first place: `api-keys.tsx` renders the literal text "Authorization: Bearer
 * sc_…" in a `<code>` block as API documentation. That is JSX text, not a
 * property assignment, so a property-assignment walk never sees it. Scoping by
 * SYNTAX rather than by character window gets both directions right at once.
 */
export function headersObjects(source: string, fileName = "file.tsx"): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: string[] = [];
  const visit = (node: TS.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) &&
      node.name.text === "headers"
    ) {
      out.push(node.initializer.getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return out;
}

/**
 * Every `/api/v1` route file whose handler can reach `assertMemberNotFrozen`
 * with a WRITE scope — which is what the seat freeze actually blocks.
 *
 * BOTH DOORS. `requireOrgAuth` is the one that runs the check, but
 * `requireResourceAuth(req, kind, id, scope)` resolves the org and then calls
 * `requireOrgAuth(req, orgId, scope)` — so it is freeze-checked too. Fix round
 * 6 discovered callers by the single URL prefix `/api/v1/orgs/`, which is the
 * slice `requireOrgAuth` is used directly on: **13 route files against 88 using
 * `requireResourceAuth`.** The rule worked perfectly inside its slice and
 * reported green on the other 85% of the surface, so the article's corrected
 * sentence named four screens when the true answer is most of the editing
 * product.
 *
 * Returned as paths relative to `src`, so callers can floor the count and see
 * the walk is looking at a real tree.
 */
export function freezeCheckedWriteRoutes(): string[] {
  return allStrippedSources()
    .filter(([file]) => file.startsWith("app/api/v1/") && file.endsWith("route.ts"))
    // `[^)]` already spans newlines, so the `s` flag is unnecessary — and it is
    // unavailable under this project's ES target (TS1501).
    .filter(([, src]) => /require(?:Org|Resource)Auth\([^)]*"write"/.test(src))
    .map(([file]) => file)
    .sort();
}

/**
 * The URL prefixes those routes answer on: everything up to the first dynamic
 * segment, which is the part an in-app caller writes as a literal before
 * interpolating an id.
 *
 * `app/api/v1/divisions/[id]/route.ts` -> `/api/v1/divisions/`.
 */
export function freezeCheckedUrlPrefixes(routes: readonly string[]): string[] {
  const out = new Set<string>();
  for (const route of routes) {
    const segments = route.slice("app/api/v1/".length).split("/").slice(0, -1);
    const fixed: string[] = [];
    for (const segment of segments) {
      if (segment.startsWith("[")) break;
      fixed.push(segment);
    }
    out.add(`/api/v1/${fixed.join("/")}/`);
  }
  return [...out].sort();
}
