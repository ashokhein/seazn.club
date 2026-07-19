// SPEC-2 public post page. Hero (uploaded image, or the scorebug for a result
// post), measure-limited markdown body (~68ch) through the help-content
// sanitizing pipeline (org-authored content on a public page — no new renderer,
// no dangerouslySetInnerHTML of unsanitized input), share-bar after the fold,
// related-competition card when scoped, and a "Download image card" button on
// published result posts. The ONE motion moment (digits settle) is on the
// scorebug hero. OG image is injected by the sibling opengraph-image route (Next
// hashes it — never hardcoded).
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ChevronRight } from "lucide-react";
import { getPublicOrg } from "@/server/public-site/data";
import { publicPost } from "@/server/usecases/org-posts";
import { HttpError } from "@/lib/errors";
import { postHeroUrl, resolvePostSides, relatedCompetition } from "@/server/news/public-view";
import { renderHelpMarkdown } from "@/server/help-content";
import { CompetitionProse } from "@/components/public-site/competition-prose";
import { ShareBar } from "@/components/share-bar";
import { DownloadCardButton } from "@/components/news/download-card-button";
import { PostScorebug } from "@/components/news/post-scorebug";
import { kindEyebrow, scoreboardFor } from "@/lib/news-presentation";
import { getDictionary, t } from "@/lib/i18n";
import { hasLocale, DEFAULT_LOCALE, type Locale } from "@/lib/i18n-constants";

export const revalidate = 30;
export async function generateStaticParams() {
  return [];
}

type Props = { params: Promise<{ orgSlug: string; postSlug: string }> };

function orgLocale(defaultLocale: string): Locale {
  return hasLocale(defaultLocale) ? defaultLocale : DEFAULT_LOCALE;
}

async function load(orgSlug: string, postSlug: string) {
  const data = await getPublicOrg(orgSlug);
  if (!data) return null;
  try {
    const post = await publicPost(orgSlug, postSlug);
    return { org: data.org, post };
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { orgSlug, postSlug } = await params;
  const loaded = await load(orgSlug, postSlug);
  if (!loaded) return {};
  return { title: `${loaded.post.title} · ${loaded.org.name}` };
}

export default async function PostPage({ params }: Props) {
  const { orgSlug, postSlug } = await params;
  const loaded = await load(orgSlug, postSlug);
  if (!loaded) notFound();
  const { org, post } = loaded;
  const locale = orgLocale(org.default_locale);
  const dict = await getDictionary(locale, "public");

  const eb = kindEyebrow(post.kind);
  const eyebrow = t(dict, eb.labelKey);
  const heroUrl = postHeroUrl(post);
  const scoreline = scoreboardFor(post.kind, post.title);
  const sides = scoreline && !heroUrl ? await resolvePostSides(post) : null;
  const related = await relatedCompetition(post);
  const bodyHtml = await renderHelpMarkdown(post.bodyMd);
  const date = post.publishedAt
    ? new Date(post.publishedAt).toLocaleDateString(locale, {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "";
  const isPublishedResult = post.status === "published" && scoreline !== null;

  const TONE_TEXT = {
    lime: "text-[#a3e635]",
    white: "text-court-ink",
    red: "text-[#ef4444]",
    muted: "text-ink-muted",
  } as const;

  return (
    <article className="mx-auto max-w-2xl">
      <Link
        href={`/shared/${orgSlug}/news`}
        className="mb-4 inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-ink-muted hover:text-accent-strong"
      >
        <ChevronRight aria-hidden className="h-3.5 w-3.5 rotate-180" />
        {t(dict, "news.title")}
      </Link>

      {/* Hero: uploaded image, else the scorebug for a result, else a styled
          title block — never a grey placeholder. */}
      {heroUrl ? (
        <div className="overflow-hidden rounded-2xl bg-court">
          {/* eslint-disable-next-line @next/next/no-img-element -- confined public-storage URL (safeOrgHeroUrl) */}
          <img src={heroUrl} alt="" className="w-full object-cover" />
        </div>
      ) : scoreline ? (
        <PostScorebug
          eyebrow={eyebrow}
          tone={eb.tone}
          home={sides?.home ?? { name: scoreline.home }}
          away={sides?.away ?? { name: scoreline.away }}
          homeScore={scoreline.homeScore}
          awayScore={scoreline.awayScore}
          size="hero"
          animate
        />
      ) : null}

      <header className="mt-5">
        {!scoreline ? (
          <span
            className={`text-[11px] font-semibold uppercase tracking-[0.22em] ${TONE_TEXT[eb.tone]}`}
          >
            {eyebrow}
          </span>
        ) : null}
        <h1 className="mt-1 font-display text-3xl font-bold uppercase leading-tight tracking-tight text-ink sm:text-4xl">
          {post.title}
        </h1>
        {date ? (
          <p className="mt-1.5 text-xs font-medium uppercase tracking-wide text-ink-muted">{date}</p>
        ) : null}
      </header>

      {post.bodyMd.trim() ? (
        <div className="mt-6 max-w-[68ch]">
          <CompetitionProse html={bodyHtml} />
        </div>
      ) : null}

      {/* Share + download — after the fold on mobile (the hero + body come first). */}
      <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-zinc-200/70 pt-5">
        <ShareBar
          path={`/shared/${orgSlug}/news/${post.slug}`}
          title={post.title}
          postShare={{ kind: post.kind }}
        />
        {isPublishedResult ? (
          <DownloadCardButton
            href={`/shared/${orgSlug}/news/${post.slug}/story.png`}
            kind={post.kind}
            label={t(dict, "news.download")}
          />
        ) : null}
      </div>

      {related ? (
        <Link
          href={`/shared/${orgSlug}/${related.slug}`}
          data-testid="news-related-comp"
          className="mt-6 flex items-center justify-between gap-3 rounded-xl border border-zinc-200/80 bg-surface p-4 shadow-sm transition hover:border-accent-line hover:shadow-md"
        >
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
              {t(dict, "news.related")}
            </p>
            <p className="mt-0.5 font-display text-lg font-semibold text-ink">{related.name}</p>
          </div>
          <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-accent" />
        </Link>
      ) : null}
    </article>
  );
}
