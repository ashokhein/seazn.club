// Help-centre link registry (v3/06 §3). Client-safe on purpose — <Tip> runs
// in the browser and cannot walk content/help, so the article slugs are
// listed here and the stale-doc test (help-content.test.ts) proves this list
// and the Markdown files on disk agree in BOTH directions. A slug outside the
// registry resolves to null and "Learn more" simply doesn't render — never a
// dead link.

export const HELP_ARTICLE_SLUGS = [
  "getting-started/create-your-organisation",
  "getting-started/create-a-competition",
  "getting-started/add-a-division",
  "getting-started/add-entrants",
  "getting-started/generate-fixtures",
  "getting-started/start-scoring",
  "getting-started/share-your-dashboard",
  "entrants/kinds",
  "entrants/withdrawals",
  "entrants/duplicate-players",
  "registration/open-registration",
  "registration/reference-numbers",
  "registration/waitlist",
  "registration/youth",
  "scheduling/board",
  "scheduling/locks",
  "scheduling/undo",
  "scheduling/constraints",
  "scoring/basics",
  "scoring/conflicts",
  "scoring/device-links",
  "scoring/scorer-role",
  "scoring/tennis",
  "scoring/hockey",
  "divisions/lifecycle",
  "divisions/archive",
  "divisions/settings",
  "sharing/visibility",
  "sharing/dashboard",
  "sharing/slideshow",
  "sharing/embeds",
  "billing/plans",
  "billing/downgrade",
  "billing/event-pass",
  "api/keys",
] as const;

const ARTICLES = new Set<string>(HELP_ARTICLE_SLUGS);

// Slugs that resolve to generated pages rather than Markdown articles —
// the format gallery (v3/06 §4) renders from the engine registry.
const VIRTUAL: Record<string, string> = {
  "formats/overview": "/help/formats",
};

export function helpUrl(slug: string | undefined): string | null {
  if (!slug) return null;
  if (VIRTUAL[slug]) return VIRTUAL[slug];
  if (slug.startsWith("formats/")) return `/help/formats/${slug.slice("formats/".length)}`;
  return ARTICLES.has(slug) ? `/help/${slug}` : null;
}
