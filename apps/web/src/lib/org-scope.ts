// Which organisation a request is FOR (v17 gap #334).
//
// The console tree is `/o/[orgSlug]/...` and every page under it already
// authorises from that slug (`requireOrgPage`, PROMPT-30). The API routes those
// pages POST to did not: they resolved the org from the `seazn_org` cookie,
// which `ActiveOrgSync` re-points from a client effect that runs AFTER the
// destination page has painted. A payer who owns two billing groups and saves
// inside that window is fully authorised — `requireBillingOwner` has nothing to
// refuse — and the write lands on the group they navigated AWAY from. For a
// control whose payload is a TOTAL rather than a delta (extra organisations,
// extra seats) that silently cancels riders on the other bill.
//
// The fix is not a faster cookie. Next 16 Server Components cannot set cookies,
// so the correction can never be hoisted into the render that already knows the
// right org — the window is structural. So the org travels WITH the request:
// the client seams stamp the slug from the URL the user is actually looking at,
// and the server prefers it over the cookie.
//
// This module is deliberately dependency-free (no React, no `server-only`, no
// imports) so both a "use client" island and a route handler can use it.

/** Request header carrying the org slug the caller's page is scoped to.
 *  Named like `x-seazn-locale` (the proxy's Accept-Language negotiation), the
 *  established convention for "this request's own context, decided upstream". */
export const ORG_SCOPE_HEADER = "x-seazn-org";

/** Org slugs are `slugify` output: lower-case alphanumerics and hyphens. The
 *  pattern is a SANITISER, not a security check — the slug is looked up and the
 *  payer gate still runs — but it keeps junk (and anything header-shaped) from
 *  reaching a query, and it means a non-console path can never be mistaken for
 *  an org. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,127}$/;

/**
 * The org slug a console path is about, or null for any other path.
 *
 * `/o/riverside/settings/add-ons` -> `riverside`
 * `/orgs/new`, `/admin/...`, `/` -> null
 *
 * Pure, so the rule is testable without a DOM: the caller supplies the
 * pathname.
 */
export function orgSlugFromPath(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  // Only the console tree. `/orgs/...` must not match `/o/...`, which is why
  // this splits on segments rather than testing a `/o/` prefix.
  const [, first, second] = pathname.split("/");
  if (first !== "o" || !second) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(second);
  } catch {
    // A malformed percent-escape is not a slug; it is not this module's job to
    // guess what was meant.
    return null;
  }
  return SLUG.test(slug) ? slug : null;
}

/**
 * Headers to merge into a same-origin request so it names its own org. Empty
 * when the caller is not on a console page — the server then falls back to the
 * cookie, which is the pre-#334 behaviour and still correct for surfaces that
 * genuinely have no org in their URL (e.g. `/orgs/new`).
 *
 * @param pathname defaults to the live location. Injectable so the seams that
 *   use it stay unit-testable outside a browser.
 */
export function orgScopeHeaders(
  pathname: string | null | undefined = typeof window === "undefined"
    ? null
    : window.location.pathname,
): Record<string, string> {
  const slug = orgSlugFromPath(pathname);
  return slug ? { [ORG_SCOPE_HEADER]: slug } : {};
}
