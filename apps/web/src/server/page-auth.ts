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
import { sql } from "@/lib/db";
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

/**
 * Session auth for the BILLING tabs under `/o/[orgSlug]/settings`
 * (Billing, Credits, Add-ons) — v17 gap #333.
 *
 * `requireOrgPage`'s rule is membership, and that is right for every organiser
 * surface: those pages are about the club. Billing is not about the club, it is
 * about the GROUP — `subscriptions` is its own row with its own
 * `owner_user_id`, one bill may fund many clubs, and `transferGroup` moves that
 * column ALONE, leaving memberships untouched. So a payer can end up funding a
 * bill they are not a member of (by transfer, or by an org owner removing them)
 * and, gated on membership, has no route to any of the pages that manage it —
 * not even to cancel.
 *
 * THE ONE RELAXATION, stated exactly: membership is no longer the only way in.
 * The group's payer is admitted as well. Nothing else moves —
 *
 *   - a member is admitted on exactly the terms `requireOrgPage` gives them,
 *     with the same role and the same `canEdit`;
 *   - a non-member who does NOT pay for this org's group still 404s, so
 *     existence is never leaked to a stranger;
 *   - a scorer who does not pay still bounces to "My matches" (doc 13 §4);
 *   - the payer is admitted READ-ONLY as far as the org goes: `role` is null
 *     and `canEdit` is false, so nothing here becomes a way to edit a club.
 *     What they get is the bill, which is theirs already.
 *
 * `requireOrgPage` itself is deliberately UNCHANGED. Putting the exception
 * inside it would relax the membership rule for every organiser page in the
 * tree to serve three tabs; a separate gate keeps the widening where it is
 * legible and where a reviewer can see its whole audience.
 *
 * `viaPayer` tells the page which of the two it is looking at. Chrome that
 * assumes membership — the back link into the org's own Settings index, which
 * IS member-gated — must not be rendered for a payer who would only 404 on it.
 */
export async function requireBillingPage(
  orgSlug: string,
  opts: { tail?: string } = {},
): Promise<PageAuth & { viaPayer: boolean }> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const resolved = await orgBySlug(orgSlug);
  if (resolved && "renamedTo" in resolved) {
    permanentRedirect(routes.orgHome(resolved.renamedTo) + (opts.tail ?? ""));
  }
  if (!resolved) notFound();
  const orgs = await getUserOrgs(user.id);
  const org = orgs.find((o) => o.id === resolved.id);

  // Members first, and untouched: whatever `requireOrgPage` would have handed
  // them, they still get. Only the two arms it REFUSES are reconsidered below,
  // so no existing visitor's outcome can move.
  if (org && org.role !== "scorer") {
    return {
      auth: { orgId: org.id, via: "session", userId: user.id, role: org.role, keyId: null },
      user,
      org,
      canEdit: (EDITOR_ROLES as readonly string[]).includes(org.role),
      viaPayer: false,
    };
  }

  // Does this person pay for the group this organisation bills through? Read
  // straight off `subscriptions.owner_user_id` — the same column
  // `requireBillingOwner` gates the mutating routes on, so the pages a payer
  // can OPEN and the writes a payer can MAKE cannot answer differently. An org
  // with no group (`subscription_id` null) simply has no payer, and the join
  // drops it.
  const [payer] = await sql<{ owner_user_id: string }[]>`
    select s.owner_user_id
      from organizations o
      join subscriptions s on s.id = o.subscription_id
     where o.id = ${resolved.id}`;
  if (!payer || payer.owner_user_id !== user.id) {
    // Unchanged refusals: a scorer keeps its own bounce (doc 13 §4), and a
    // non-member gets the 404 that never leaks existence.
    if (org) redirect("/my-matches");
    notFound();
  }

  return {
    auth: { orgId: resolved.id, via: "session", userId: user.id, role: null, keyId: null },
    user,
    // Payer placeholder. They hold no role in this organisation and must not
    // acquire one here: the pages read `org.id` for the bill and `org.role`
    // only to decide what a MEMBER may see, and null denies all of it. Same
    // shape requireFixturePage uses for a non-member official.
    org: {
      id: resolved.id,
      slug: resolved.slug,
      name: resolved.name,
      role: null,
    } as unknown as OrgMembership,
    canEdit: false,
    viaPayer: true,
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
  // Membership is checked below, AFTER resolving comp/division/fixture and
  // the accepted-official branch — a non-member with an accepted assignment
  // still needs those to render the fixture console (design v2 §A2/§A5).
  const compRes = await compBySlug(org.id, compSlug);
  if (!compRes) notFound();
  if ("renamedTo" in compRes) {
    if (membership) permanentRedirect(routes.competition(orgSlug, compRes.renamedTo));
    notFound(); // non-member must not learn a renamed slug (existence leak)
  }
  const competition = compRes;

  const divRes = await divBySlug(competition.id, divSlug);
  if (!divRes) notFound();
  if ("renamedTo" in divRes) {
    if (membership) permanentRedirect(routes.division(orgSlug, compSlug, divRes.renamedTo));
    notFound();
  }
  const division = divRes;
  const fixture = await fixtureByNo(division.id, no);
  if (!fixture) notFound();

  const canEdit = membership
    ? (EDITOR_ROLES as readonly string[]).includes(membership.role)
    : false;
  let canScore = canEdit;
  if (membership?.role === "scorer") {
    const { fixtureScope, scorerCovers } = await import("@/server/usecases/scorers");
    const scope = await fixtureScope(fixture.id);
    if (!scope || !(await scorerCovers(org.id, user.id, scope))) notFound();
    canScore = true;
  } else if (membership?.role === "viewer") {
    // A viewer scores the fixtures their umpire-invite assignments cover
    // (additive invites) — the page stays readable either way.
    const { fixtureScope, scorerCovers } = await import("@/server/usecases/scorers");
    const scope = await fixtureScope(fixture.id);
    canScore = !!scope && (await scorerCovers(org.id, user.id, scope));
  }
  if (!canScore) {
    // Non-member (or a member who can't score this fixture) — an accepted
    // fixture_officials assignment is the only remaining way in. Never a
    // member-widening grant: canEdit stays false either way (doc 13 §A2/§A5).
    const { acceptedOfficialCovers } = await import("@/server/usecases/scorers");
    if (await acceptedOfficialCovers(user.id, fixture.id)) canScore = true;
    else if (!membership) notFound();
  }
  return {
    auth: { orgId: org.id, via: "session", userId: user.id, role: membership?.role ?? null, keyId: null },
    user,
    org:
      membership ??
      // Non-member official placeholder — the fixture page never reads
      // `org` for identity (only auth/canScore/canEdit/fixtureId), so this
      // only needs to typecheck against PageAuth["org"].
      ({ id: org.id, slug: org.slug, name: org.name, role: null } as unknown as OrgMembership),
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
  // Membership is checked below — a non-member official may still reach a
  // "fixture" resource via an accepted fixture_officials assignment.

  const canEdit = org ? (EDITOR_ROLES as readonly string[]).includes(org.role) : false;
  let canScore = canEdit;
  if (org?.role === "scorer") {
    if (kind !== "fixture") notFound();
    const { fixtureScope, scorerCovers } = await import("@/server/usecases/scorers");
    const scope = await fixtureScope(id);
    if (!scope || !(await scorerCovers(orgId, user.id, scope))) notFound();
    canScore = true;
  } else if (org?.role === "viewer" && kind === "fixture") {
    // Additive invites: a viewer's covering assignment turns the score pad on.
    const { fixtureScope, scorerCovers } = await import("@/server/usecases/scorers");
    const scope = await fixtureScope(id);
    canScore = !!scope && (await scorerCovers(orgId, user.id, scope));
  }
  if (!canScore) {
    if (kind === "fixture") {
      // Non-member (or a member who can't score this fixture) — an accepted
      // fixture_officials assignment is the only remaining way in.
      const { acceptedOfficialCovers } = await import("@/server/usecases/scorers");
      if (await acceptedOfficialCovers(user.id, id)) canScore = true;
      else if (!org) notFound();
    } else if (!org) {
      // Officials pass ONLY for kind === "fixture" — every other resource
      // 404s a non-member outright (existence never leaks, doc 13 §A5).
      notFound();
    }
  }
  return {
    auth: { orgId, via: "session", userId: user.id, role: org?.role ?? null, keyId: null },
    user,
    org:
      org ??
      // Non-member official placeholder — only reachable for kind==="fixture"
      // (see notFound() above for every other kind); callers of this path
      // only read auth/canScore/canEdit, so this only needs to typecheck.
      ({ id: orgId, slug: "", name: "", role: null } as unknown as OrgMembership),
    canEdit,
    canScore,
  };
}
