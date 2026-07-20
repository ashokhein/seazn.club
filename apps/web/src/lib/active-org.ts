/**
 * Which org the console chrome belongs to. URL beats cookie (v3/01 §2): an
 * /o/[orgSlug] page authorises from the path, and the breadcrumb switcher is a
 * plain link into another org — the seazn_org cookie is only corrected
 * afterwards, by ActiveOrgSync, from the browser. A Nav that read the cookie
 * alone therefore rendered the PREVIOUS org for that whole page, pointing its
 * Settings link at the org the user just left.
 *
 * Pure so the precedence is pinned by unit tests rather than a browser run.
 */
export function pickActiveOrg<T extends { id: string; slug: string }>(
  orgs: readonly T[],
  opts: { pathSlug?: string | null; cookieOrgId?: string | null },
): T | null {
  if (orgs.length === 0) return null;
  const fromPath = opts.pathSlug ? orgs.find((o) => o.slug === opts.pathSlug) : undefined;
  if (fromPath) return fromPath;
  const fromCookie = opts.cookieOrgId ? orgs.find((o) => o.id === opts.cookieOrgId) : undefined;
  return fromCookie ?? orgs[0];
}
