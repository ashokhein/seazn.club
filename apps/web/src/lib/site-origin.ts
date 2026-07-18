// Canonical site origin for metadata-time absolute URLs (metadataBase,
// sitemap, robots, canonicals). Env-driven so staging emits its own host
// instead of the production domain; falls back to the production domain when
// nothing is set. Deliberately NOT header-derived: a dynamic read in the root
// layout would opt every page out of static rendering (PERF-A).
export function siteOrigin(): string {
  return (
    process.env.OAUTH_BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    "https://seazn.club"
  ).replace(/\/$/, "");
}
