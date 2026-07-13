import "server-only";
// Server Component auth for the organiser UI (doc 08 §1: pages read through
// the same service layer as /api/v1 — no HTTP hop). Builds the AuthCtx the
// use-cases expect from the session cookie.
//
// PROMPT-30: the /o tree authorises from the URL (requireOrgPage family) —
// the seazn_org cookie no longer decides what a page shows, so two tabs on
// two orgs can't corrupt each other. Renamed slugs permanent-redirect.
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { getCurrentUser, getUserOrgs, getActiveOrgId } from "@/lib/auth";
import { EDITOR_ROLES, type OrgMembership, type User } from "@/lib/types";
import { resourceOrg, type AuthCtx, type ResourceKind } from "@/server/api-v1/auth";
import { HttpError } from "@/lib/errors";
import { routes } from "@/lib/routes";
import {
  orgBySlug,
  compBySlug,
  divBySlug,
  fixtureByNo,
  type ResolvedEntity,
  type Resolution,
} from "@/server/slug-resolve";

export interface PageAuth {
  auth: AuthCtx;
  user: User;
  org: OrgMembership;
  canEdit: boolean;
}

/** Session auth against the active org. Redirects out when unauthenticated.
 *  A scorer-role active org has no organiser surface (doc 13 §4): straight
 *  to "My matches". */
export async function requirePageAuth(): Promise<PageAuth> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const orgs = await getUserOrgs(user.id);
  if (orgs.length === 0) redirect("/orgs/new");
  const activeId = await getActiveOrgId();
  const org = orgs.find((o) => o.id === activeId) ?? (orgs[0] as OrgMembership);
  if (org.role === "scorer") redirect("/my-matches");
  return {
    auth: { orgId: org.id, via: "session", userId: user.id, role: org.role, keyId: null },
    user,
    org,
    canEdit: (EDITOR_ROLES as readonly string[]).includes(org.role),
  };
}

// ---------------------------------------------------------------------------
// PROMPT-30: URL-derived auth for the /o/[orgSlug]/... tree.
// ---------------------------------------------------------------------------

/** Unwrap a slug resolution: miss → 404 (existence never leaks past
 *  membership, which callers check first); rename → 301 to the URL the
 *  builder makes from the current slug. */
function settle(res: Resolution, target: (newSlug: string) => string): ResolvedEntity {
  if (res && "renamedTo" in res) permanentRedirect(target(res.renamedTo));
  if (!res) notFound();
  return res;
}

/**
 * Session auth from the org slug in the path. Members only — non-members
 * 404 (existence never leaks). Scorers have no organiser surface (doc 13
 * §4) and bounce to "My matches" unless the caller opts in (the /o layout
 * does, so scorer fixture deep-links can reach requireFixturePage).
 */
export async function requireOrgPage(
  orgSlug: string,
  opts: { allowScorer?: boolean; tail?: string } = {},
): Promise<PageAuth> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const resolved = await orgBySlug(orgSlug);
  if (resolved && "renamedTo" in resolved) {
    permanentRedirect(routes.orgHome(resolved.renamedTo) + (opts.tail ?? ""));
  }
  if (!resolved) notFound();
  const orgs = await getUserOrgs(user.id);
  const org = orgs.find((o) => o.id === resolved.id);
  if (!org) notFound();
  if (org.role === "scorer" && !opts.allowScorer) redirect("/my-matches");
  return {
    auth: { orgId: org.id, via: "session", userId: user.id, role: org.role, keyId: null },
    user,
    org,
    canEdit: (EDITOR_ROLES as readonly string[]).includes(org.role),
  };
}

/** `tail` keeps sub-pages (/schedule, /settings, …) on their own page after
 *  a rename redirect. */
export async function requireCompetitionPage(
  orgSlug: string,
  compSlug: string,
  opts: { tail?: string } = {},
): Promise<PageAuth & { competition: ResolvedEntity }> {
  // Scorers have no organiser surface below the org level — 404, never a
  // redirect (doc 13 §2 parity with requireResourcePageAuth).
  const page = await requireOrgPage(orgSlug, { allowScorer: true });
  if (page.org.role === "scorer") notFound();
  const competition = settle(
    await compBySlug(page.org.id, compSlug),
    (s) => routes.competition(orgSlug, s) + (opts.tail ?? ""),
  );
  return { ...page, competition };
}

export async function requireDivisionPage(
  orgSlug: string,
  compSlug: string,
  divSlug: string,
  opts: { tail?: string } = {},
): Promise<PageAuth & { competition: ResolvedEntity; division: ResolvedEntity }> {
  const withComp = await requireCompetitionPage(orgSlug, compSlug);
  const division = settle(
    await divBySlug(withComp.competition.id, divSlug),
    (s) => routes.division(orgSlug, compSlug, s) + (opts.tail ?? ""),
  );
  return { ...withComp, division };
}

/**
 * Fixture pages allow scorers WITH a covering assignment (doc 13 §2) —
 * parity with requireResourcePageAuth's fixture path.
 */
export async function requireFixturePage(
  orgSlug: string,
  compSlug: string,
  divSlug: string,
  no: number,
): Promise<
  PageAuth & {
    competition: ResolvedEntity;
    division: ResolvedEntity;
    fixtureId: string;
    canScore: boolean;
  }
> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const org = settle(await orgBySlug(orgSlug), (s) => routes.orgHome(s));
  const orgs = await getUserOrgs(user.id);
  const membership = orgs.find((o) => o.id === org.id);
  if (!membership) notFound();
  const competition = settle(await compBySlug(org.id, compSlug), (s) =>
    routes.competition(orgSlug, s),
  );
  const division = settle(await divBySlug(competition.id, divSlug), (s) =>
    routes.division(orgSlug, compSlug, s),
  );
  const fixture = await fixtureByNo(division.id, no);
  if (!fixture) notFound();

  const canEdit = (EDITOR_ROLES as readonly string[]).includes(membership.role);
  let canScore = canEdit;
  if (membership.role === "scorer") {
    const { fixtureScope, scorerCovers } = await import("@/server/usecases/scorers");
    const scope = await fixtureScope(fixture.id);
    if (!scope || !(await scorerCovers(org.id, user.id, scope))) notFound();
    canScore = true;
  } else if (membership.role === "viewer") {
    // A viewer scores the fixtures their umpire-invite assignments cover
    // (additive invites) — the page stays readable either way.
    const { fixtureScope, scorerCovers } = await import("@/server/usecases/scorers");
    const scope = await fixtureScope(fixture.id);
    canScore = !!scope && (await scorerCovers(org.id, user.id, scope));
  }
  return {
    auth: { orgId: org.id, via: "session", userId: user.id, role: membership.role, keyId: null },
    user,
    org: membership,
    canEdit,
    canScore,
    competition,
    division,
    fixtureId: fixture.id,
  };
}

/**
 * Session auth against the org that OWNS a resource (deep links keep working
 * across the user's orgs). 404 when the resource doesn't exist or the user
 * has no role in its org — existence is never leaked.
 *
 * Scorers (doc 13 §2) see their ASSIGNED scope only: a fixture page renders
 * when a covering assignment exists (canScore true); every other organiser
 * page 404s for them.
 */
export async function requireResourcePageAuth(
  kind: ResourceKind,
  id: string,
): Promise<PageAuth & { canScore: boolean }> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  let orgId: string;
  try {
    orgId = await resourceOrg(kind, id);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }
  const orgs = await getUserOrgs(user.id);
  const org = orgs.find((o) => o.id === orgId);
  if (!org) notFound();

  const canEdit = (EDITOR_ROLES as readonly string[]).includes(org.role);
  let canScore = canEdit;
  if (org.role === "scorer") {
    if (kind !== "fixture") notFound();
    const { fixtureScope, scorerCovers } = await import("@/server/usecases/scorers");
    const scope = await fixtureScope(id);
    if (!scope || !(await scorerCovers(orgId, user.id, scope))) notFound();
    canScore = true;
  } else if (org.role === "viewer" && kind === "fixture") {
    // Additive invites: a viewer's covering assignment turns the score pad on.
    const { fixtureScope, scorerCovers } = await import("@/server/usecases/scorers");
    const scope = await fixtureScope(id);
    canScore = !!scope && (await scorerCovers(orgId, user.id, scope));
  }
  return {
    auth: { orgId, via: "session", userId: user.id, role: org.role, keyId: null },
    user,
    org,
    canEdit,
    canScore,
  };
}
