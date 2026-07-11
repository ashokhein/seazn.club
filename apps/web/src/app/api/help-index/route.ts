import { NextResponse } from "next/server";
import { allHelpArticles, helpPlainText } from "@/server/help-content";

// Search-index feed for the /help FlexSearch box (v3/06 §3): slug, title and
// plain text per article. Static content → long cache.
export async function GET() {
  const docs = [...allHelpArticles().values()].map((a) => ({
    slug: a.slug,
    title: a.title,
    description: a.description,
    text: helpPlainText(a.markdown),
  }));
  return NextResponse.json(docs, {
    headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
