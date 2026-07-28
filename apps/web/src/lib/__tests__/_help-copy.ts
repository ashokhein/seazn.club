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
import { readdirSync, readFileSync } from "node:fs";
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
let strippedCache: Array<[string, string]> | null = null;

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
  if (strippedCache) return strippedCache;
  strippedCache = allSourceFiles().map(([file, source]) => [file, codeOnly(source, file)]);
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
 * every comment replaced by spaces.
 *
 * A guard that asserts an idiom is ABSENT must not read prose, or it fires on
 * the comment explaining why the idiom is absent — which is what happened when
 * `billing-groups.ts`'s stale "charged immediately" note was corrected: the
 * correction has to name `always_invoice`, and the negative scan then failed on
 * its own explanation.
 *
 * ── WHY THIS USES THE TYPESCRIPT PARSER ──────────────────────────────────────
 * The first version was a hand-rolled scanner that ran `/\/\*[\s\S]*?\*\//g`
 * over the whole file BEFORE tracking strings, so a `/*` inside a string
 * literal opened a phantom comment that swallowed everything up to the next
 * `*` + `/`. That was not hypothetical: `components/v2/division-settings.tsx`
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
 */
export function codeOnly(source: string, fileName = "file.tsx"): string {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out = source.split("");
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
    node.forEachChild(visit);
  };
  visit(sourceFile);
  // The file's own leading block, which belongs to no node's full start when
  // the file begins with trivia.
  take(ts.getLeadingCommentRanges(source, 0));
  return out.join("");
}
