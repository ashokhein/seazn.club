// SPEC-2 / PROMPT-83 — the PURE presentation half of the news surfaces. Kept
// free of JSX/DB so the scorebug parse + kind vocabulary unit-test without a
// render or a database (mirrors lib/og/model + lib/public-site). The signature
// element is "a result post IS a scorebug": a result post's title is
// `"{home} {homeScore}–{awayScore} {away}"` (draft-templates.ts), and these
// helpers pull the two sides + numerals back out so the feed card and post hero
// can render the scoreline in huge tabular numerals with crests.
import type { PostKind } from "@/server/usecases/org-posts";

// Kind eyebrow vocabulary (SPEC-2 "Design direction"): RESULT lime pitch-line /
// RECAP white / ANNOUNCEMENT red-ball / CLUB NEWS muted. Text is org-locale copy
// (public dict), so this returns a dictionary KEY + a tone token, never a string.
export type EyebrowTone = "lime" | "white" | "red" | "muted";

export interface KindEyebrow {
  /** public-dict key resolved by the page via t(dict, key). */
  labelKey: string;
  tone: EyebrowTone;
}

const KIND_EYEBROW: Record<PostKind, KindEyebrow> = {
  result: { labelKey: "news.kind.result", tone: "lime" },
  round_recap: { labelKey: "news.kind.recap", tone: "white" },
  announcement: { labelKey: "news.kind.announcement", tone: "red" },
  news: { labelKey: "news.kind.news", tone: "muted" },
};

export function kindEyebrow(kind: PostKind): KindEyebrow {
  return KIND_EYEBROW[kind] ?? KIND_EYEBROW.news;
}

export interface Scoreline {
  home: string;
  homeScore: string;
  awayScore: string;
  away: string;
}

// A score is only rendered as a scorebug when both sides are NUMERIC-ish (digits
// with optional `/` or `.` — "3", "252/8", "2.5"). Anything else (cricket overs
// "(50)", forfeit words) fails the guard so the post falls back to a styled title
// hero instead of a mangled split — an empty hero is never a grey placeholder,
// but a wrong scoreline is worse than a clean headline.
const NUMERIC = /^\d[\d/.]*$/;
// `{home} {a}–{b} {away}` with an en dash (U+2013, the draft-template separator);
// scores are the single non-space tokens either side of the dash.
const SCORELINE = /^(.+?)\s+(\S+)\s*–\s*(\S+)\s+(.+)$/u;

/** Parse a result/round title into its two sides, or null when it is not a
 *  clean numeric scoreline (manual "news" titles, cricket-over scores, etc). */
export function parseScoreline(title: string): Scoreline | null {
  const m = SCORELINE.exec(title.trim());
  if (!m) return null;
  const [, home, homeScore, awayScore, away] = m;
  if (!NUMERIC.test(homeScore!) || !NUMERIC.test(awayScore!)) return null;
  return {
    home: home!.trim(),
    homeScore: homeScore!,
    awayScore: awayScore!,
    away: away!.trim(),
  };
}

/** Does this post render as a scorebug? Result-kind posts whose title is a clean
 *  numeric scoreline. (round_recap titles are prose — "Round 3 recap: …" — so
 *  they never scorebug; they show the styled title hero.) */
export function scoreboardFor(kind: PostKind, title: string): Scoreline | null {
  if (kind !== "result") return null;
  return parseScoreline(title);
}

/** Two-letter monogram fallback when a crest image is missing (SPEC-2: the
 *  scorebug "falls back cleanly when a crest is missing"). */
export function crestMonogram(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}
