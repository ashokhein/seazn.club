import "server-only";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { sql } from "@/lib/db";
import type { Organization, OrgMembership, OrgRole, User } from "@/lib/types";
import { EDITOR_ROLES } from "@/lib/types";
import { AuthError, HttpError } from "@/lib/errors";

const COOKIE_NAME = "seazn_session";
const ORG_COOKIE = "seazn_org";
const SESSION_DAYS = 30;

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production")
      throw new Error("AUTH_SECRET environment variable is required in production");
    return new TextEncoder().encode("dev-insecure-secret-change-me");
  }
  return new TextEncoder().encode(secret);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(
  password: string,
  hash: string | null,
): Promise<boolean> {
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

/** Issue a signed session cookie for the given user id. */
export async function createSession(userId: string): Promise<void> {
  const token = await new SignJWT({ uid: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secretKey());

  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE_NAME);
  jar.delete(ORG_COOKIE);
}

/** Returns the logged-in user, or null. */
export async function getCurrentUser(): Promise<User | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return null;

  let uid: string;
  try {
    const { payload } = await jwtVerify(token, secretKey());
    uid = String(payload.uid);
  } catch {
    return null;
  }

  const rows = await sql<User[]>`
    select id, display_name, email, avatar_url
    from users where id = ${uid} limit 1
  `;
  return rows[0] ?? null;
}

/** Throws if not authenticated. Use inside API routes / server actions. */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new AuthError("Not authenticated");
  return user;
}

// ---------------------------------------------------------------------------
// Organizations / roles
// ---------------------------------------------------------------------------

/** Every organization the user belongs to, with their role, newest first. */
export async function getUserOrgs(userId: string): Promise<OrgMembership[]> {
  return sql<OrgMembership[]>`
    select o.id, o.name, o.slug, o.created_by, o.created_at,
           o.logo_url, o.logo_storage_path, m.role
    from org_members m
    join organizations o on o.id = m.org_id
    where m.user_id = ${userId}
    order by o.created_at asc`;
}

/** The user's role in an org, or null if they are not a member. */
export async function getOrgRole(
  orgId: string,
  userId: string,
): Promise<OrgRole | null> {
  const rows = await sql<{ role: OrgRole }[]>`
    select role from org_members
    where org_id = ${orgId} and user_id = ${userId} limit 1`;
  return rows[0]?.role ?? null;
}

/** Read the active-org cookie (the board currently selected in the UI). */
export async function getActiveOrgId(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(ORG_COOKIE)?.value ?? null;
}

export async function setActiveOrgId(orgId: string): Promise<void> {
  const jar = await cookies();
  jar.set(ORG_COOKIE, orgId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

/**
 * Resolve the active org for the current user. Falls back to the first org the
 * user belongs to (and repairs the cookie) when the cookie is missing or stale.
 */
export async function resolveActiveOrg(
  user: User,
): Promise<OrgMembership | null> {
  const orgs = await getUserOrgs(user.id);
  if (orgs.length === 0) return null;
  const activeId = await getActiveOrgId();
  const match = orgs.find((o) => o.id === activeId);
  if (match) return match;
  await setActiveOrgId(orgs[0].id);
  return orgs[0];
}

/** Generate a unique, auto-assigned org slug like `org-1a2b3c4d5e`. */
async function generateOrgSlug(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const slug = `org-${crypto.randomBytes(5).toString("hex")}`;
    const taken = await sql`select 1 from organizations where slug = ${slug}`;
    if (taken.length === 0) return slug;
  }
  return `org-${Date.now().toString(36)}`;
}

/** Create an organization owned by the user, with an auto-generated slug. */
export async function createOrgForUser(
  userId: string,
  name: string,
): Promise<Organization> {
  const slug = await generateOrgSlug();
  return sql.begin(async (tx) => {
    const [o] = await tx<Organization[]>`
      insert into organizations (name, slug, created_by)
      values (${name}, ${slug}, ${userId})
      returning id, name, slug, created_by, created_at`;
    await tx`
      insert into org_members (org_id, user_id, role)
      values (${o.id}, ${userId}, 'owner')`;
    await tx`
      insert into subscriptions (org_id, plan_key, status)
      values (${o.id}, 'community', 'active')
      on conflict (org_id) do nothing`;
    const { seedDefaultSportPresets } = await import("@/lib/sport-presets");
    await seedDefaultSportPresets(tx, o.id);
    return o;
  });
}

/**
 * Ensure the user has an active org, auto-provisioning a default one when they
 * belong to none. Returns the active org id.
 */
export async function ensureActiveOrg(userId: string): Promise<string> {
  const orgs = await getUserOrgs(userId);
  if (orgs.length > 0) {
    const activeId = await getActiveOrgId();
    const target = orgs.find((o) => o.id === activeId) ?? orgs[0];
    if (target.id !== activeId) await setActiveOrgId(target.id);
    return target.id;
  }
  const created = await createOrgForUser(userId, "My organization");
  await setActiveOrgId(created.id);
  return created.id;
}

/** Validate a post-auth redirect target is a safe, internal path. */
export function safeNextPath(next: unknown): string | null {
  if (typeof next !== "string") return null;
  if (!next.startsWith("/") || next.startsWith("//")) return null;
  return next;
}

/**
 * Decide where to send a freshly-authenticated user. A safe `next` (e.g. an
 * invite link) is honored without provisioning a default org so invited users
 * land on the invite; otherwise the user is guaranteed an org and the
 * dashboard.
 */
export async function postAuthLanding(
  userId: string,
  next?: unknown,
): Promise<{ redirect: string; orgId: string | null; hasOrg: boolean }> {
  const safe = safeNextPath(next);
  if (safe) {
    const orgs = await getUserOrgs(userId);
    if (orgs.length > 0) {
      const activeId = await getActiveOrgId();
      const target = orgs.find((o) => o.id === activeId) ?? orgs[0];
      await setActiveOrgId(target.id);
      return { redirect: safe, orgId: target.id, hasOrg: true };
    }
    return { redirect: safe, orgId: null, hasOrg: false };
  }
  const orgId = await ensureActiveOrg(userId);
  // New users (onboarding_completed_at null) go to the first-run wizard.
  const { needsOnboarding } = await import("@/lib/activation");
  const isNew = await needsOnboarding(userId);
  return { redirect: isNew ? "/onboarding" : "/dashboard", orgId, hasOrg: true };
}

/**
 * Require the current user to hold one of `roles` in `orgId`. Returns the
 * user + role on success.
 */
export async function requireOrgRole(
  orgId: string,
  roles: readonly OrgRole[],
): Promise<{ user: User; role: OrgRole }> {
  const user = await requireUser();
  const role = await getOrgRole(orgId, user.id);
  if (!role) throw new AuthError("You are not a member of this organization");
  if (!roles.includes(role)) throw new AuthError("Insufficient permissions");
  return { user, role };
}

/**
 * Require the current user to be an editor (owner/admin) of the organization
 * that owns the given tournament. Returns the user and orgId for downstream use.
 */
export async function requireTournamentEditor(
  tournamentId: string,
): Promise<{ user: User; orgId: string }> {
  const user = await requireUser();
  const rows = await sql<{ org_id: string }[]>`
    select org_id from tournaments where id = ${tournamentId} limit 1`;
  if (!rows[0]) throw new HttpError(404, "Tournament not found");
  const orgId = rows[0].org_id;
  const role = await getOrgRole(orgId, user.id);
  if (!role || !EDITOR_ROLES.includes(role as (typeof EDITOR_ROLES)[number])) {
    throw new AuthError("You don't have edit access to this tournament");
  }
  return { user, orgId };
}

export { AuthError } from "@/lib/errors";
