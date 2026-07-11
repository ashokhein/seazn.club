import "server-only";
// Help centre content layer (v3/06 §3): in-repo Markdown under
// apps/web/content/help/<section>/<article>.md → /help/<section>/<article>.
// No CMS, no sync — versioned with the code it documents; the stale-doc test
// (help-content.test.ts) keeps articles, tips deep-links and the slug
// registry in lib/help.ts agreeing with each other.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Options as SanitizeSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";

export const HELP_ROOT = join(process.cwd(), "content", "help");

// Section order = the product's own hierarchy (v3/06 §3).
export const HELP_SECTIONS: { key: string; label: string }[] = [
  { key: "getting-started", label: "Getting started" },
  { key: "formats", label: "Formats" },
  { key: "entrants", label: "Entrants & clubs" },
  { key: "registration", label: "Registration" },
  { key: "scheduling", label: "Scheduling" },
  { key: "scoring", label: "Scoring" },
  { key: "divisions", label: "Divisions" },
  { key: "sharing", label: "Sharing & dashboards" },
  { key: "billing", label: "Plans & billing" },
  { key: "api", label: "API & integrations" },
];

export interface HelpArticle {
  /** "getting-started/create-your-organisation" */
  slug: string;
  section: string;
  title: string;
  description: string;
  order: number;
  markdown: string;
}

// Help prose allows a little more than organiser prose: inline code and
// tables (for shortcut/limit tables), still no raw HTML survivors.
const HELP_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    "h2", "h3", "p", "strong", "em", "ul", "ol", "li", "a", "img",
    "blockquote", "hr", "br", "del", "code", "pre",
    "table", "thead", "tbody", "tr", "th", "td",
  ],
  attributes: {
    a: ["href", "title"],
    img: ["src", "alt", "title"],
    th: ["align"],
    td: ["align"],
    "*": [],
  },
  protocols: { href: ["http", "https", "mailto"], src: ["http", "https"] },
};

const pipeline = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSanitize, HELP_SCHEMA)
  .use(rehypeStringify);

export async function renderHelpMarkdown(markdown: string): Promise<string> {
  return String(await pipeline.process(markdown));
}

/** Minimal frontmatter: `---\nkey: value\n---` — deliberate, no dependency. */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: raw.slice(m[0].length) };
}

let cache: Map<string, HelpArticle> | null = null;

export function allHelpArticles(): Map<string, HelpArticle> {
  if (cache && process.env.NODE_ENV === "production") return cache;
  const articles = new Map<string, HelpArticle>();
  for (const section of readdirSync(HELP_ROOT, { withFileTypes: true })) {
    if (!section.isDirectory()) continue;
    for (const file of readdirSync(join(HELP_ROOT, section.name))) {
      if (!file.endsWith(".md")) continue;
      const raw = readFileSync(join(HELP_ROOT, section.name, file), "utf8");
      const { meta, body } = parseFrontmatter(raw);
      const slug = `${section.name}/${file.replace(/\.md$/, "")}`;
      articles.set(slug, {
        slug,
        section: section.name,
        title: meta.title ?? file.replace(/\.md$/, ""),
        description: meta.description ?? "",
        order: Number(meta.order ?? 99),
        markdown: body,
      });
    }
  }
  cache = articles;
  return articles;
}

export function helpArticle(slug: string): HelpArticle | null {
  return allHelpArticles().get(slug) ?? null;
}

export function helpNav(): { section: string; label: string; articles: HelpArticle[] }[] {
  const all = [...allHelpArticles().values()];
  return HELP_SECTIONS.map((s) => ({
    section: s.key,
    label: s.label,
    articles: all
      .filter((a) => a.section === s.key)
      .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)),
  })).filter((s) => s.articles.length > 0);
}

/** Plain text of an article for the search index (strip markdown syntax). */
export function helpPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
