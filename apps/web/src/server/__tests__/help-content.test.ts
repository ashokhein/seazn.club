// The stale-doc gate (v3/06 §3, v3/11 gap 14): the Markdown on disk, the
// client-safe slug registry in lib/help.ts, the Tips deep-links and the
// feature-area sections must all agree — a feature area or tip cannot ship
// without its /help article, and a deleted article cannot leave dead links.
import { describe, expect, it } from "vitest";
import FlexSearch from "flexsearch";
import {
  HELP_SECTIONS, allHelpArticles, helpNav, helpPlainText, renderHelpMarkdown,
} from "@/server/help-content";
import { HELP_ARTICLE_SLUGS, helpUrl } from "@/lib/help";
import { TIPS } from "@/config/tips";

describe("help content ⇄ registry ⇄ tips", () => {
  const onDisk = allHelpArticles();

  it("every registry slug has a Markdown file", () => {
    for (const slug of HELP_ARTICLE_SLUGS) {
      expect(onDisk.has(slug), `lib/help.ts lists '${slug}' but content/help has no such file`).toBe(true);
    }
  });

  it("every Markdown file is in the registry (no unreachable articles)", () => {
    const registered = new Set<string>(HELP_ARTICLE_SLUGS);
    for (const slug of onDisk.keys()) {
      expect(registered.has(slug), `content/help/${slug}.md is not registered in lib/help.ts`).toBe(true);
    }
  });

  it("every tip's helpSlug resolves — Learn-more links can never be dead", () => {
    for (const [id, tip] of Object.entries(TIPS)) {
      if (!tip.helpSlug) continue;
      expect(helpUrl(tip.helpSlug), `tip '${id}' points at unresolvable '${tip.helpSlug}'`).toBeTruthy();
    }
  });

  it("every live feature area has at least one article", () => {
    const sections = new Set(helpNav().map((s) => s.section));
    for (const s of HELP_SECTIONS) {
      if (s.key === "formats") continue; // generated pages (v3/06 §4), not Markdown
      expect(sections.has(s.key), `feature area '${s.key}' has no help article`).toBe(true);
    }
  });

  it("articles carry frontmatter and render to sanitized HTML", async () => {
    for (const a of onDisk.values()) {
      expect(a.title.length, `${a.slug} missing title`).toBeGreaterThan(3);
      expect(a.description.length, `${a.slug} missing description`).toBeGreaterThan(10);
      const html = await renderHelpMarkdown(a.markdown);
      expect(html).not.toMatch(/<script|onerror|javascript:/i);
      expect(html.length).toBeGreaterThan(100);
    }
  });

  it("search finds the waitlist article (acceptance golden)", () => {
    const index = new FlexSearch.Document({
      document: { id: "slug", index: ["title", "text"], store: false },
      tokenize: "forward",
    });
    for (const a of onDisk.values()) {
      index.add({ slug: a.slug, title: a.title, text: helpPlainText(a.markdown) });
    }
    const results = index.search("waitlist");
    const slugs = results.flatMap((f) => f.result as string[]);
    expect(slugs).toContain("registration/waitlist");
  });
});
