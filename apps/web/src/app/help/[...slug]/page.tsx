import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ArrowLeft, ArrowRight } from "lucide-react";
import {
  HELP_SECTIONS, allHelpArticles, helpArticle, helpNav, renderHelpMarkdown,
} from "@/server/help-content";
import { CompetitionProse } from "@/components/public-site/competition-prose";

export const revalidate = 3600;

type Props = { params: Promise<{ slug: string[] }> };

export function generateStaticParams(): { slug: string[] }[] {
  return [...allHelpArticles().keys()].map((slug) => ({ slug: slug.split("/") }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const article = helpArticle(slug.join("/"));
  if (!article) return {};
  return { title: article.title, description: article.description };
}

export default async function HelpArticlePage({ params }: Props) {
  const { slug } = await params;
  const article = helpArticle(slug.join("/"));
  if (!article) notFound();

  const html = await renderHelpMarkdown(article.markdown);
  const sectionLabel =
    HELP_SECTIONS.find((s) => s.key === article.section)?.label ?? article.section;

  // Prev/next within the section for a guided read (the getting-started rail).
  const section = helpNav().find((s) => s.section === article.section);
  const i = section?.articles.findIndex((a) => a.slug === article.slug) ?? -1;
  const prev = i > 0 ? section!.articles[i - 1] : null;
  const next = i >= 0 && section ? (section.articles[i + 1] ?? null) : null;

  return (
    <article>
      <p className="font-mono text-xs uppercase tracking-[0.25em] text-purple-600">
        {sectionLabel}
      </p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900">
        {article.title}
      </h1>
      {article.description ? (
        <p className="mt-2 text-lg text-slate-600">{article.description}</p>
      ) : null}
      <div className="mt-6">
        <CompetitionProse html={html} className="help-prose" />
      </div>

      {(prev || next) && (
        <nav aria-label="Article pagination" className="mt-10 flex justify-between gap-4 border-t border-purple-100 pt-5 text-sm">
          {prev ? (
            <Link
              href={`/help/${prev.slug}`}
              className="inline-flex items-center gap-1.5 text-slate-600 hover:text-purple-700"
            >
              <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} /> {prev.title}
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link
              href={`/help/${next.slug}`}
              className="inline-flex items-center gap-1.5 text-right text-slate-600 hover:text-purple-700"
            >
              {next.title} <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} />
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </article>
  );
}
