import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PostScorebug } from "@/components/news/post-scorebug";

// The scorebug renders the scoreline in tabular numerals with crests, and falls
// back cleanly to a monogram when a crest is missing (SPEC-2: an empty hero is
// never a grey placeholder).
describe("PostScorebug", () => {
  const base = {
    eyebrow: "RESULT",
    tone: "lime" as const,
    home: { name: "Riverside Rovers" },
    away: { name: "Northside" },
    homeScore: "3",
    awayScore: "1",
  };

  it("renders both scores in a tabular-nums scoreline", () => {
    const html = renderToStaticMarkup(<PostScorebug {...base} />);
    expect(html).toContain("tabular-nums");
    expect(html).toContain(">3<");
    expect(html).toContain(">1<");
    expect(html).toContain('data-testid="post-scorebug"');
  });

  it("falls back to a monogram when a crest is missing", () => {
    const html = renderToStaticMarkup(<PostScorebug {...base} />);
    expect(html).toContain('data-testid="crest-monogram"');
    expect(html).toContain(">RR<"); // Riverside Rovers → RR
    expect(html).toContain(">N<"); // Northside → N
  });

  it("uses the crest image when one is provided (no monogram for that side)", () => {
    const html = renderToStaticMarkup(
      <PostScorebug
        {...base}
        home={{ name: "Riverside Rovers", crest: "https://cdn.example/badge.png" }}
      />,
    );
    expect(html).toContain("https://cdn.example/badge.png");
    // Only the away side falls back to a monogram now.
    expect(html.match(/data-testid="crest-monogram"/g)?.length).toBe(1);
  });

  it("very long team names carry the truncation class and still render (no layout break)", () => {
    const longHome = "Riverside Rovers Athletic Football and Social Club First Team";
    const longAway = "Northside United Old Boys Veterans Reserve Development Squad";
    const html = renderToStaticMarkup(
      <PostScorebug {...base} home={{ name: longHome }} away={{ name: longAway }} />,
    );
    // Name wrapper carries the truncation class regardless of string length.
    expect(html).toContain("max-w-full truncate");
    expect(html).toContain(longHome);
    expect(html).toContain(longAway);
    // A missing crest still falls back to a monogram even with a long name.
    expect(html.match(/data-testid="crest-monogram"/g)?.length).toBe(2);
  });

  it("animates the digits only for the hero size + animate flag", () => {
    const card = renderToStaticMarkup(<PostScorebug {...base} size="card" />);
    expect(card).not.toContain("news-digit-settle");
    const hero = renderToStaticMarkup(<PostScorebug {...base} size="hero" animate />);
    expect(hero).toContain("news-digit-settle");
    expect(hero).toContain('data-size="hero"');
  });
});
