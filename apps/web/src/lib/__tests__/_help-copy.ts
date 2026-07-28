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
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Matches `HELP_ROOT` in `@/server/help-content` — the help tree is a single
 *  English Markdown tree with no locale segment, so there is one file per slug
 *  and no four-locale fan-out to scan. */
export const HELP_BILLING_DIR = join(process.cwd(), "content", "help", "billing");

/** One billing help article's raw Markdown, frontmatter included. Throws on a
 *  missing file rather than returning "" — an empty string would scan clean and
 *  every guard in this wave would report no faults. */
export function helpArticle(slug: string): string {
  const text = readFileSync(join(HELP_BILLING_DIR, `${slug}.md`), "utf8");
  if (text.trim().length === 0) throw new Error(`content/help/billing/${slug}.md is empty`);
  return text;
}
