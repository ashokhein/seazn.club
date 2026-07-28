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
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { HELP_ROOT } from "@/server/help-content";

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
 * A source file with its comments removed.
 *
 * A guard that asserts an idiom is ABSENT must not read prose, or it fires on
 * the comment explaining why the idiom is absent — which is exactly what
 * happened here: correcting `billing-groups.ts`'s stale "charged immediately"
 * note meant naming `always_invoice` in the correction, and the negative scan
 * then failed on its own explanation.
 *
 * Deliberately crude — block comments, line comments, and the string/regex
 * literals that could contain a `//`. It is not a parser and does not need to
 * be: every caller pairs it with a known-positive on the same read, so a
 * mangled result reds rather than passing.
 */
export function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => {
      // Drop a `//` only when it is not inside a quoted string on that line.
      let quote: string | null = null;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i]!;
        if (quote) {
          if (ch === "\\") i += 1;
          else if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'" || ch === "`") {
          quote = ch;
        } else if (ch === "/" && line[i + 1] === "/") {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
}
