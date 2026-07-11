// lib/prose (v3/06 §2): the ONE organiser-Markdown pipeline. Locks three
// things: the restricted grammar renders, the XSS corpus dies at the
// sanitizer, and the CTA grammar (paragraph = bold link only) becomes the
// branded button — and nothing else does.
import { describe, expect, it } from "vitest";
import { renderProse, DESCRIPTION_MAX } from "@/lib/prose";

describe("renderProse", () => {
  it("renders the restricted block set", async () => {
    const html = await renderProse(
      [
        "## Welcome",
        "",
        "### Details",
        "",
        "Some **bold** and *italic* text with a [link](https://example.com).",
        "",
        "- one",
        "- two",
        "",
        "1. first",
        "",
        "> quoted",
        "",
        "---",
        "",
        "![pitch](https://example.com/pitch.png)",
      ].join("\n"),
    );
    expect(html).toContain("<h2>Welcome</h2>");
    expect(html).toContain("<h3>Details</h3>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("<ul>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<hr>");
    expect(html).toContain('src="https://example.com/pitch.png"');
  });

  it("is deterministic — same input, same output (preview === public render)", async () => {
    const md = "## Hi\n\n**[Register](https://x.dev)**";
    expect(await renderProse(md)).toBe(await renderProse(md));
  });

  it("neutralises the XSS corpus", async () => {
    const payloads = [
      "<script>alert(1)</script>",
      '<img src=x onerror="alert(1)">',
      '<iframe src="https://evil.dev"></iframe>',
      '<a href="javascript:alert(1)">x</a>',
      '[x](javascript:alert(1))',
      '<svg onload="alert(1)"></svg>',
      '<div style="background:url(javascript:alert(1))">x</div>',
      '![x](javascript:alert(1))',
      '<details open ontoggle="alert(1)">x</details>',
    ];
    for (const p of payloads) {
      const html = await renderProse(`before\n\n${p}\n\nafter`);
      expect(html, p).not.toMatch(/<script|onerror|<iframe|javascript:|onload|ontoggle|style=/i);
    }
  });

  it("turns a bold-link-only paragraph into the CTA button", async () => {
    const html = await renderProse("**[Register now](https://seazn.club/r)**");
    expect(html).toContain('class="prose-cta"');
    expect(html).toContain(">Register now</a>");
    expect(html).not.toContain("<strong>"); // unwrapped into the button
  });

  it("does NOT make buttons from ordinary bold links inside sentences", async () => {
    const html = await renderProse("Please **[register](https://x.dev)** today.");
    expect(html).not.toContain("prose-cta");
    expect(html).toContain("<strong>");
  });

  it("caps input at DESCRIPTION_MAX and renders empty for whitespace", async () => {
    expect(await renderProse("   \n\n  ")).toBe("");
    expect(await renderProse(null)).toBe("");
    const long = "a".repeat(DESCRIPTION_MAX + 5000);
    const html = await renderProse(long);
    // the cap bites before the pipeline — no runaway output
    expect(html.length).toBeLessThan(DESCRIPTION_MAX + 100);
  });
});
