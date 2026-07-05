import "server-only";
// Server Component auth for the organiser UI (doc 08 §1: pages read through
// the same service layer as /api/v1 — no HTTP hop). Builds the AuthCtx the
// use-cases expect from the session cookie.
import { notFound, redirect } from "next/navigation";
import { getCurrentUser, getUserOrgs, getActiveOrgId } from "@/lib/auth";
import { EDITOR_ROLES, type OrgMembership, type User } from "@/lib/types";
import { resourceOrg, type AuthCtx, type ResourceKind } from "@/server/api-v1/auth";
import { HttpError } from "@/lib/errors";

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
  }
  return {
    auth: { orgId, via: "session", userId: user.id, role: org.role, keyId: null },
    user,
    org,
    canEdit,
    canScore,
  };
}
