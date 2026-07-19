// SPEC-2 feed card. A night-mode matchday programme entry, not a blog row: a
// kind-colored eyebrow, the title in the display face, a fixture-style date. A
// result card swaps its hero image for the scorebug block when no hero is
// uploaded — an empty hero is never a grey placeholder. Server component (no
// client hooks): the card never animates (only the post hero does).
import Link from "next/link";
import { kindEyebrow, type Scoreline } from "@/lib/news-presentation";
import { PostScorebug } from "@/components/news/post-scorebug";
import type { PostKind } from "@/server/usecases/org-posts";

const TONE_TEXT = {
  lime: "text-[#a3e635]",
  white: "text-court-ink",
  red: "text-[#ef4444]",
  muted: "text-ink-muted",
} as const;

export interface PostCardView {
  href: string;
  kind: PostKind;
  eyebrow: string;
  title: string;
  date: string;
  heroUrl: string | null;
  /** Result posts with a numeric scoreline (drives the scorebug swap). */
  scoreline: Scoreline | null;
}

export function PostCard({ post }: { post: PostCardView }) {
  const { tone } = kindEyebrow(post.kind);
  const showScorebug = !post.heroUrl && post.scoreline !== null;

  return (
    <Link
      href={post.href}
      data-testid="news-card"
      className="group block overflow-hidden rounded-2xl border border-zinc-200/80 bg-surface shadow-sm transition hover:-translate-y-0.5 hover:border-accent-line hover:shadow-md"
    >
      {showScorebug ? (
        <PostScorebug
          eyebrow={post.eyebrow}
          tone={tone}
          home={{ name: post.scoreline!.home }}
          away={{ name: post.scoreline!.away }}
          homeScore={post.scoreline!.homeScore}
          awayScore={post.scoreline!.awayScore}
          size="card"
        />
      ) : post.heroUrl ? (
        <div className="relative aspect-[16/9] w-full overflow-hidden bg-court">
          {/* eslint-disable-next-line @next/next/no-img-element -- confined public-storage URL (safeOrgHeroUrl) */}
          <img src={post.heroUrl} alt="" className="h-full w-full object-cover" />
          <span
            className={`absolute left-3 top-3 rounded-full bg-court/80 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.18em] ${TONE_TEXT[tone]}`}
          >
            {post.eyebrow}
          </span>
        </div>
      ) : null}

      <div className="p-4">
        {!showScorebug && !post.heroUrl ? (
          <span className={`text-[11px] font-semibold uppercase tracking-[0.22em] ${TONE_TEXT[tone]}`}>
            {post.eyebrow}
          </span>
        ) : null}
        <h3 className="mt-1 font-display text-xl font-semibold leading-tight text-ink group-hover:text-accent-strong">
          {post.title}
        </h3>
        <p className="mt-1.5 text-xs font-medium uppercase tracking-wide text-ink-muted">{post.date}</p>
      </div>
    </Link>
  );
}
