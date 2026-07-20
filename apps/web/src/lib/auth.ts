import "server-only";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { sql } from "@/lib/db";
import { cacheGet, cacheSet, cacheDelPattern } from "@/lib/cache";
import type { Organization, OrgMembership, OrgRole, User } from "@/lib/types";
import { AuthError, PaymentRequiredError } from "@/lib/errors";
import { isReservedSlug } from "@/lib/public-site";
import { routes } from "@/lib/routes";
import { slugify, uniqueSlug } from "@/server/usecases/slugs";

const COOKIE_NAME = "seazn_session";
const ORG_COOKIE = "seazn_org";
const SESSION_DAYS = 30;

// Auth data is read on nearly every request but changes rarely, so it caches
// well (cache-aside, fail-open via lib/cache). Explicit busts run on the few
// writes that touch these rows; short TTLs bound staleness if a bust is missed.
const USER_TTL_SECONDS = 300;
const ORGS_TTL_SECONDS = 120;
const userKey = (uid: string) => `user:${uid}`;
const orgsKey = (uid: string) => `orgs:${uid}`;

/** Drop the cached `users` row for a user. Call after a profile/email write. */
export async function invalidateUser(userId: string): Promise<void> {
  await cacheDelPattern(userKey(userId));
}

/** Drop a user's cached org-membership list. Call after a membership change. */
export async function invalidateUserOrgs(userId: string): Promise<void> {
  await cacheDelPattern(orgsKey(userId));
}

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

  const cached = await cacheGet<User>(userKey(uid));
  if (cached) return cached;

  const rows = await sql<User[]>`
    select id, display_name, email, avatar_url, timezone, locale
    from users where id = ${uid} limit 1
  `;
  const user = rows[0] ?? null;
  if (user) await cacheSet(userKey(uid), user, USER_TTL_SECONDS);
  return user;
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
  const cached = await cacheGet<OrgMembership[]>(orgsKey(userId));
  if (cached) return cached;

  const orgs = await sql<OrgMembership[]>`
    select o.id, o.name, o.slug, o.created_by, o.created_at,
           o.logo_url, o.logo_storage_path, o.payment_instructions, o.default_payment_method, o.branding,
           o.timezone, m.role
    from org_members m
    join organizations o on o.id = m.org_id
    where m.user_id = ${userId}
    order by o.created_at asc`;
  await cacheSet(orgsKey(userId), orgs, ORGS_TTL_SECONDS);
  return orgs;
}

/**
 * The user's role in an org, or null if they are not a member. Derived from the
 * cached membership list, so it shares getUserOrgs's cache-aside path.
 */
export async function getOrgRole(
  orgId: string,
  userId: string,
): Promise<OrgRole | null> {
  const orgs = await getUserOrgs(userId);
  return orgs.find((o) => o.id === orgId)?.role ?? null;
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

/** Readable, name-derived org slug (PROMPT-30): `/o/[slug]` and `/shared/
 *  [slug]` are user-facing URLs. Globally unique; app routes stay reserved. */
export async function generateOrgSlug(name: string, excludeOrgId?: string): Promise<string> {
  return uniqueSlug(slugify(name), async (s) => {
    if (isReservedSlug(s)) return true;
    const taken = excludeOrgId
      ? await sql`select 1 from organizations where slug = ${s} and id <> ${excludeOrgId}`
      : await sql`select 1 from organizations where slug = ${s}`;
    return taken.length > 0;
  });
}

/**
 * `orgs.max_owned` (doc 13 §5, billing decision (a)): subscriptions stay
 * per-org; the quota only caps CREATION, judged against the creating user's
 * best owned-org plan. A user who owns nothing may always create their first.
 */
async function assertMayOwnAnotherOrg(userId: string): Promise<void> {
  const owned = await sql<{ plan_key: string }[]>`
    select coalesce(s.plan_key, 'community') as plan_key
    from org_members m
    left join subscriptions s on s.org_id = m.org_id
    where m.user_id = ${userId} and m.role = 'owner'`;
  if (owned.length === 0) return;
  // Overrides on any owned org lift the user too (v3 grandfathering: the pro
  // cap dropped 5 → 3, existing owners keep their headroom via override).
  const limits = await sql<{ int_value: number | null }[]>`
    select int_value from plan_entitlements
    where feature_key = 'orgs.max_owned'
      and plan_key in ${sql([...new Set(owned.map((o) => o.plan_key))])}
    union all
    select o.int_value from org_entitlement_overrides o
    join org_members m on m.org_id = o.org_id and m.user_id = ${userId} and m.role = 'owner'
    where o.feature_key = 'orgs.max_owned'
      and (o.expires_at is null or o.expires_at > now())`;
  // Best plan wins; a NULL int_value = unlimited; no rows = community default 1.
  if (limits.some((l) => l.int_value === null) && limits.length > 0) return;
  const limit = limits.length > 0 ? Math.max(...limits.map((l) => l.int_value as number)) : 1;
  if (owned.length + 1 > limit) throw new PaymentRequiredError("orgs.max_owned");
}

/** Create an organization owned by the user, with an auto-generated slug. */
export async function createOrgForUser(
  userId: string,
  name: string,
): Promise<Organization> {
  await assertMayOwnAnotherOrg(userId);
  // Readable slugs can collide when two same-named orgs sign up concurrently
  // (check-then-insert race) — retry past the unique index, then salt.
  let org: Organization | undefined;
  for (let attempt = 0; ; attempt++) {
    const base = await generateOrgSlug(name);
    const slug = attempt < 2 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      org = await sql.begin(async (tx) => {
        const [o] = await tx<Organization[]>`
          insert into organizations (name, slug, created_by)
          values (${name}, ${slug}, ${userId})
          returning id, name, slug, created_by, created_at, logo_url, logo_storage_path, payment_instructions, default_payment_method, branding, timezone`;
        await tx`
          insert into org_members (org_id, user_id, role)
          values (${o.id}, ${userId}, 'owner')`;
        await tx`
          insert into subscriptions (org_id, plan_key, status)
          values (${o.id}, 'community', 'active')
          on conflict (org_id) do nothing`;
        return o;
      });
      break;
    } catch (err) {
      const unique =
        typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
      if (!unique || attempt >= 4) throw err;
    }
  }
  await invalidateUserOrgs(userId);
  return org;
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
  // Scorer-only members land on their console, never the org dashboard
  // (doc 13 §4) — checked before auto-provisioning would give them an org.
  {
    const { isScorerOnly } = await import("@/server/usecases/scorers");
    if (await isScorerOnly(userId)) {
      const orgs = await getUserOrgs(userId);
      await setActiveOrgId(orgs[0].id);
      return { redirect: "/my-matches", orgId: orgs[0].id, hasOrg: true };
    }
  }
  // Same rule for claimed players (PROMPT-53): their home is /me — a player
  // must never be walked into organiser onboarding or handed a default org.
  {
    const { isPlayerOnly } = await import("@/server/usecases/me");
    if (await isPlayerOnly(userId)) {
      return { redirect: routes.me(), orgId: null, hasOrg: false };
    }
  }
  const orgId = await ensureActiveOrg(userId);
  // New users (onboarding_completed_at null) go to the first-run wizard.
  const { needsOnboarding } = await import("@/lib/activation");
  const isNew = await needsOnboarding(userId);
  if (isNew) return { redirect: "/onboarding", orgId, hasOrg: true };
  // PROMPT-30: land on the active org's slug home — the URL, not the cookie,
  // is what the session bookmarks and shares.
  const orgs = await getUserOrgs(userId);
  const active = orgs.find((o) => o.id === orgId) ?? orgs[0];
  return { redirect: routes.orgHome(active.slug), orgId, hasOrg: true };
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

export { AuthError } from "@/lib/errors";
