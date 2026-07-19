// SPEC-2 public news feed — a night-mode matchday programme, paginated 20.
// Server component over publicPosts (published + visibility-guarded in the
// usecase). Cards read against markup targets (public pages test markup, not
// labels — v5 lesson).
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ChevronRight } from "lucide-react";
import { getPublicOrg } from "@/server/public-site/data";
import { publicPosts } from "@/server/usecases/org-posts";
import { postHeroUrl } from "@/server/news/public-view";
import { kindEyebrow, scoreboardFor } from "@/lib/news-presentation";
import { PostCard, type PostCardView } from "@/components/news/post-card";
import { getDictionary, t } from "@/lib/i18n";
import { hasLocale, DEFAULT_LOCALE, type Locale } from "@/lib/i18n-constants";

export const revalidate = 30;
export async function generateStaticParams() {
  return [];
}

type Props = {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ page?: string }>;
};

function orgLocale(defaultLocale: string): Locale {
  return hasLocale(defaultLocale) ? defaultLocale : DEFAULT_LOCALE;
}

function fmtDate(iso: string, locale: Locale): string {
  return new Date(iso).toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { orgSlug } = await params;
  const data = await getPublicOrg(orgSlug);
  if (!data) return {};
  const dict = await getDictionary(orgLocale(data.org.default_locale), "public");
  return {
    title: `${t(dict, "news.title")} · ${data.org.name}`,
    description: t(dict, "news.feedIntro", { org: data.org.name }),
  };
}

export default async function NewsFeedPage({ params, searchParams }: Props) {
  const { orgSlug } = await params;
  const { page: rawPage } = await searchParams;
  const data = await getPublicOrg(orgSlug);
  if (!data) notFound();
  const { org } = data;
  const locale = orgLocale(org.default_locale);
  const dict = await getDictionary(locale, "public");

  const page = Math.max(0, Number(rawPage) || 0);
  const { posts, hasMore } = await publicPosts(orgSlug, page);

  const views: PostCardView[] = posts.map((p) => ({
    href: `/shared/${orgSlug}/news/${p.slug}`,
    kind: p.kind,
    eyebrow: t(dict, kindEyebrow(p.kind).labelKey),
    title: p.title,
    date: p.publishedAt ? fmtDate(p.publishedAt, locale) : "",
    heroUrl: postHeroUrl(p),
    scoreline: scoreboardFor(p.kind, p.title),
  }));

  return (
    <div>
      <section className="mb-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent-strong">
          {t(dict, "news.eyebrow")}
        </p>
        <h1 className="mt-1 font-display text-4xl font-bold uppercase leading-none tracking-tight text-ink sm:text-5xl">
          {t(dict, "news.title")}
        </h1>
      </section>

      {views.length === 0 ? (
        <p
          data-testid="news-empty"
          className="rounded-xl border border-dashed border-zinc-300 bg-surface p-6 text-center text-sm text-ink-muted"
        >
          {t(dict, "news.empty")}
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {views.map((v) => (
            <li key={v.href}>
              <PostCard post={v} />
            </li>
          ))}
        </ul>
      )}

      {(hasMore || page > 0) && (
        <nav className="mt-8 flex items-center justify-between text-sm" aria-label={t(dict, "news.pagination")}>
          {page > 0 ? (
            <Link
              href={`/shared/${orgSlug}/news${page - 1 > 0 ? `?page=${page - 1}` : ""}`}
              className="inline-flex items-center gap-1.5 text-accent-strong hover:underline"
            >
              <ChevronRight aria-hidden className="h-4 w-4 rotate-180" />
              {t(dict, "news.newer")}
            </Link>
          ) : (
            <span />
          )}
          {hasMore ? (
            <Link
              href={`/shared/${orgSlug}/news?page=${page + 1}`}
              data-testid="news-older"
              className="inline-flex items-center gap-1.5 text-accent-strong hover:underline"
            >
              {t(dict, "news.older")}
              <ChevronRight aria-hidden className="h-4 w-4" />
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  );
}
