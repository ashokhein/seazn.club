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
import { HELP_ROOT } from "@/server/help-content";

/** Taken from `HELP_ROOT`, never re-derived: a second copy of the path is a
 *  second thing to keep in step, and a wrong one reads as "no faults found".
 *  (`lib/help.ts` holds only the client-safe slug registry; the filesystem root
 *  lives in the server module.) The help tree is a single English Markdown tree
 *  with no locale segment, so there is one file per slug and no four-locale
 *  fan-out to scan. */
export const HELP_BILLING_DIR = join(HELP_ROOT, "billing");

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
