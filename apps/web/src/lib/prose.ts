// Markdown → sanitized HTML — THE one pipeline for organiser-authored prose
// (v3/06 §2). Deliberately isomorphic (no "server-only"): the editor's
// Preview tab runs this exact function in the browser, so preview === public
// render by construction, org branding included (both sit inside the same
// --ps-* themed subtree).
//
// Restricted grammar: h2/h3, bold/italic, lists, links, images, blockquote,
// divider. Raw HTML never survives — remark parses it to `html` nodes that
// remark-rehype drops (no allowDangerousHtml), and rehype-sanitize is belt
// and braces on the element level.
//
// Sponsor/CTA button (v3/06 §2): a paragraph that is ONLY a bold link —
// **[Label](https://…)** — renders as a branded button. Chosen over a custom
// directive so the stored Markdown stays portable (round-trips through any
// Markdown tool, degrades to a bold link in emails/exports).
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Options as SanitizeSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import type { Element, Root as HastRoot } from "hast";

export const DESCRIPTION_MAX = 20_000;

const SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    "h2", "h3", "p", "strong", "em", "ul", "ol", "li",
    "a", "img", "blockquote", "hr", "br", "del",
  ],
  attributes: {
    a: [["className", "prose-cta"], "href", "title"],
    img: ["src", "alt", "title"],
    "*": [],
  },
  protocols: { href: ["http", "https", "mailto"], src: ["http", "https"] },
};

/** Paragraph that is exactly one strong>a → the branded CTA button. */
function ctaButtons() {
  return (tree: HastRoot) => {
    for (const node of tree.children) {
      if (node.type !== "element" || node.tagName !== "p") continue;
      const kids = node.children.filter(
        (c) => !(c.type === "text" && c.value.trim() === ""),
      );
      const [only] = kids;
      if (
        kids.length === 1 &&
        only?.type === "element" &&
        only.tagName === "strong" &&
        only.children.length === 1 &&
        only.children[0]?.type === "element" &&
        (only.children[0] as Element).tagName === "a"
      ) {
        const link = only.children[0] as Element;
        link.properties = { ...link.properties, className: ["prose-cta"] };
        node.children = [link];
      }
    }
  };
}

const pipeline = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(ctaButtons)
  .use(rehypeSanitize, SCHEMA)
  .use(rehypeStringify);

/** Render organiser Markdown to safe HTML. Empty/whitespace input → "". */
export async function renderProse(markdown: string | null | undefined): Promise<string> {
  const src = (markdown ?? "").slice(0, DESCRIPTION_MAX);
  if (!src.trim()) return "";
  const file = await pipeline.process(src);
  return String(file);
}
