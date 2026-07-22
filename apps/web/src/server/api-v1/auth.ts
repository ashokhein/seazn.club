import "server-only";
// /api/v1 authentication (doc 08 §2): session cookie (our UI) or API key
// (Pro integrations — `Authorization: Bearer sc_…`). Both resolve to the
// same AuthCtx so use-cases don't care which door the caller came through.
import { createHash, randomBytes } from "node:crypto";
import { sql } from "@/lib/db";
import { getOrgRole, requireUser, resolveActiveOrg } from "@/lib/auth";
import { AuthError, HttpError } from "@/lib/errors";
import { requireFeature } from "@/lib/entitlements";
import { cacheEnabled, incrWindow } from "@/lib/cache";
import { rateLimit } from "@/lib/rate-limit";
import { EDITOR_ROLES, READ_ROLES, type OrgRole } from "@/lib/types";
import { matchKeyRoute, scopeSatisfies, type PinKind } from "./key-scopes";
import { setRateLimitInfo } from "./context";

export type Scope = "read" | "write";

export interface AuthCtx {
  orgId: string;
  via: "session" | "api_key" | "device_link";
  /** Session actor; null for API keys (recorded_by stays null on their
   *  events). For device links: the ISSUING organiser (doc 13 §7 attribution
   *  — recorded_by = issued_by, the issuer vouches for the device). */
  userId: string | null;
  role: OrgRole | null;
  keyId: string | null;
  /** Set only for via='device_link' — rides onto score_events.device_link_id. */
  deviceLinkId?: string;
}

const KEY_PREFIX = "sc_";
// Keys minted before the sc_ rename; still accepted (hash lookup is
// prefix-agnostic), just no longer minted.
const LEGACY_KEY_PREFIX = "sk_live_";
const DEVICE_LINK_PREFIX = "dl_";

export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Mint a new API key secret. Shown once; only the sha256 is stored. */
export function mintApiKeySecret(): string {
  return KEY_PREFIX + randomBytes(32).toString("base64url");
}

interface ApiKeyRow {
  id: string;
  org_id: string;
  scopes: string[];
  competition_id: string | null;
}

// Per-key rate limit (v3/08 §2): 60 rpm baseline, 300 rpm on Pro, counted on
// a one-minute window. Redis owns the counter in prod; the in-process map
// keeps the limit real (and testable) when no Redis is configured.
const KEY_RATE = { free: 60, pro: 300, windowSeconds: 60 };
const localWindows = new Map<string, { count: number; resetAt: number }>();

async function keyWindowCount(keyId: string, windowSeconds: number): Promise<number> {
  const fromRedis = await incrWindow(`rlk:${keyId}`, windowSeconds);
  if (fromRedis !== null) return fromRedis;
  if (cacheEnabled()) return 0; // Redis blip: fail open, same policy as lib/rate-limit
  const now = Date.now();
  const bucket = localWindows.get(keyId);
  if (!bucket || bucket.resetAt <= now) {
    if (localWindows.size > 10_000) localWindows.clear();
    localWindows.set(keyId, { count: 1, resetAt: now + windowSeconds * 1000 });
    return 1;
  }
  bucket.count += 1;
  return bucket.count;
}

async function apiKeyRateLimit(key: ApiKeyRow): Promise<void> {
  const [sub] = await sql<{ plan_key: string }[]>`
    select s.plan_key from subscriptions s
    join organizations o on o.subscription_id = s.id
    where o.id = ${key.org_id}`;
  const limit = sub?.plan_key === "pro" ? KEY_RATE.pro : KEY_RATE.free;
  const count = await keyWindowCount(key.id, KEY_RATE.windowSeconds);
  const reset = Math.ceil(Date.now() / 1000 / KEY_RATE.windowSeconds) * KEY_RATE.windowSeconds;
  setRateLimitInfo({ limit, remaining: limit - count, reset });
  if (count > limit) {
    throw new HttpError(429, "Rate limit exceeded for this API key — retry after the window resets.");
  }
}

// Pinned keys (api_keys.competition_id): resolve the owning competition of
// the addressed resource. A missing row falls through — the handler 404s it
// with its usual message, so the pin adds no existence oracle.
async function resolvePinCompetition(pin: PinKind, id: string): Promise<string | null> {
  if (!UUID_RE.test(id)) return null;
  switch (pin) {
    case "competition":
      return id;
    case "division": {
      const [r] = await sql<{ competition_id: string }[]>`
        select competition_id from divisions where id = ${id}`;
      return r?.competition_id ?? null;
    }
    case "stage": {
      const [r] = await sql<{ competition_id: string }[]>`
        select d.competition_id from stages s join divisions d on d.id = s.division_id
        where s.id = ${id}`;
      return r?.competition_id ?? null;
    }
    case "fixture": {
      const [r] = await sql<{ competition_id: string }[]>`
        select d.competition_id from fixtures f join divisions d on d.id = f.division_id
        where f.id = ${id}`;
      return r?.competition_id ?? null;
    }
    case "entrant": {
      const [r] = await sql<{ competition_id: string }[]>`
        select d.competition_id from entrants e join divisions d on d.id = e.division_id
        where e.id = ${id}`;
      return r?.competition_id ?? null;
    }
    case "registration": {
      const [r] = await sql<{ competition_id: string }[]>`
        select d.competition_id from registrations r join divisions d on d.id = r.division_id
        where r.id = ${id}`;
      return r?.competition_id ?? null;
    }
    case "pool": {
      const [r] = await sql<{ competition_id: string }[]>`
        select d.competition_id from pools p
        join stages s on s.id = p.stage_id join divisions d on d.id = s.division_id
        where p.id = ${id}`;
      return r?.competition_id ?? null;
    }
  }
}

async function apiKeyAuth(req: Request, token: string, orgId: string | null): Promise<AuthCtx> {
  const [key] = await sql<ApiKeyRow[]>`
    select id, org_id, scopes, competition_id from api_keys
    where key_hash = ${hashApiKey(token)} and revoked_at is null limit 1`;
  if (!key || (orgId !== null && key.org_id !== orgId)) throw new AuthError("Invalid API key");
  await requireFeature(key.org_id, "api.access");
  // Route allowlist (v3/08 §2): the map is the single authority for keys —
  // unlisted (method, path) pairs are denied outright, whatever the scope.
  const match = matchKeyRoute(req.method, req.url);
  if (!match) {
    throw new HttpError(403, "API keys cannot access this endpoint — use a session login.");
  }
  if (!scopeSatisfies(key.scopes, match.scope)) {
    throw new HttpError(
      403,
      `This key is limited to '${key.scopes.join("', '")}' — this endpoint needs the '${match.scope}' scope. Create a key with the right scope in org settings.`,
    );
  }
  if (key.competition_id) {
    if (!match.pin || !match.resourceId) {
      throw new HttpError(
        403,
        "This key is pinned to one competition and cannot call org-wide endpoints.",
      );
    }
    const owner = await resolvePinCompetition(match.pin, match.resourceId);
    if (owner !== null && owner !== key.competition_id) {
      throw new HttpError(403, "This key is pinned to a different competition.");
    }
  }
  await apiKeyRateLimit(key);
  // Observability only — never block the request on it.
  void sql`update api_keys set last_used_at = now() where id = ${key.id}`.catch(() => null);
  return { orgId: key.org_id, via: "api_key", userId: null, role: null, keyId: key.id };
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.startsWith(KEY_PREFIX) || token.startsWith(LEGACY_KEY_PREFIX) ? token : null;
}

function deviceLinkToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.startsWith(DEVICE_LINK_PREFIX) ? token : null;
}

/** dl_ tokens open exactly ONE door — the fixture-scoped scoring surface via
 *  requireFixtureActor. Every other auth path rejects them outright with 403
 *  (doc 13 §7: "everything else — finalize, lineups, any other resource"). */
function rejectDeviceLink(req: Request): void {
  if (deviceLinkToken(req)) {
    throw new HttpError(403, "Device links can only access their fixture's scoring surface");
  }
}

/**
 * Authenticate a request against an org: API key when a Bearer sc_ token
 * is present, else the session cookie. `write` needs an editor role
 * (owner/admin) or a write-scoped key; `read` an org-wide read role (doc 13
 * §2: scorers get NO org-wide access — their door is requireFixtureActor).
 * A member with an insufficient role is 403, not 401 — they are authenticated.
 */
export async function requireOrgAuth(req: Request, orgId: string, scope: Scope): Promise<AuthCtx> {
  rejectDeviceLink(req);
  const token = bearerToken(req);
  if (token) return apiKeyAuth(req, token, orgId);
  const user = await requireUser();
  const role = await getOrgRole(orgId, user.id);
  if (!role) throw new AuthError("You are not a member of this organization");
  const roles: readonly OrgRole[] = scope === "write" ? EDITOR_ROLES : READ_ROLES;
  if (!roles.includes(role)) throw new HttpError(403, "Insufficient permissions");
  // Downgrade freeze (doc 10 §2.4): an over-quota admin seat is read-only
  // until the owner frees seats. Owners are exempt.
  if (scope === "write" && role === "admin") {
    const { assertMemberNotFrozen } = await import("@/server/usecases/entitlement-freeze");
    await assertMemberNotFrozen(orgId, user.id);
  }
  return { orgId, via: "session", userId: user.id, role, keyId: null };
}

/**
 * Fixture-scoped authentication for the scoring surface (doc 13 §2/§3):
 * editors and write-scoped API keys pass outright; a scorer passes iff a
 * covering assignment exists (fixture ⊂ division ⊂ competition); a viewer
 * passes for `read` only; a non-member is only let in by an *accepted*
 * fixture_officials assignment (design v2 §A2/§A3 — officials are usually
 * non-members, so this branch runs off userId, never role/membership). The
 * capability config gates (finalize, lineups, void-pre-finalize) stay in the
 * use-cases, which re-check via requireScorable.
 */
export async function requireFixtureActor(
  req: Request,
  fixtureId: string,
  intent: "read" | "score",
): Promise<AuthCtx> {
  // Device links (doc 13 §7): THE one door a dl_ token opens, and only for
  // its own fixture. Capability limits (no finalize, void-own-only) apply in
  // the scoring use-case; per-link rate limiting at the door.
  const dlToken = deviceLinkToken(req);
  if (dlToken) {
    const { resolveDeviceLinkToken } = await import("@/server/usecases/device-links");
    const link = await resolveDeviceLinkToken(dlToken);
    assertUuid(fixtureId, "fixture");
    if (link.fixture_id !== fixtureId) {
      throw new HttpError(403, "This device link is for a different fixture");
    }
    // Scoring cadence per link (doc 08 §6): same 10/s budget as a scorer.
    if (intent === "score") {
      await rateLimit(`dlv1:${link.id}`, { max: 10, windowSeconds: 1 });
    }
    return {
      orgId: link.org_id,
      via: "device_link",
      userId: link.issued_by, // attribution: recorded_by = issued_by
      role: null,
      keyId: null,
      deviceLinkId: link.id,
    };
  }
  const orgId = await resourceOrg("fixture", fixtureId);
  const token = bearerToken(req);
  if (token) return apiKeyAuth(req, token, orgId);
  const user = await requireUser();
  const role = await getOrgRole(orgId, user.id);
  const ctx: AuthCtx = { orgId, via: "session", userId: user.id, role, keyId: null };
  if (role === "owner" || role === "admin") return ctx;
  if (role === "viewer" && intent === "read") return ctx;
  if (!role) {
    // Non-member — the only remaining door is an *accepted* fixture_officials
    // assignment on this exact fixture (doc 13 §A2/§A3). Covers both read and
    // score: the officiating rail has no separate read-only tier. Never a
    // membership-widening grant — `ctx.role` stays null either way.
    const { acceptedOfficialCovers } = await import("@/server/usecases/scorers");
    if (await acceptedOfficialCovers(user.id, fixtureId)) return ctx;
    throw new AuthError("You are not a member of this organization");
  }
  const { requireScorable, scoresViaAssignment } = await import("@/server/usecases/scorers");
  if (scoresViaAssignment(role)) {
    // Scorers always, viewers when writing (additive umpire invites) — both
    // need a covering assignment; 403 without one.
    await requireScorable(ctx, fixtureId);
    return ctx;
  }
  throw new HttpError(403, "Insufficient permissions");
}

/**
 * Authenticate an org-less collection endpoint (/competitions, /persons):
 * an API key pins its own org; a session uses the active-org cookie.
 */
export async function requireAuth(req: Request, scope: Scope): Promise<AuthCtx> {
  rejectDeviceLink(req);
  const token = bearerToken(req);
  if (token) return apiKeyAuth(req, token, null);
  const user = await requireUser();
  const org = await resolveActiveOrg(user);
  if (!org) throw new AuthError("No organization for this account");
  const roles: readonly OrgRole[] = scope === "write" ? EDITOR_ROLES : READ_ROLES;
  if (!roles.includes(org.role)) throw new HttpError(403, "Insufficient permissions");
  return { orgId: org.id, via: "session", userId: user.id, role: org.role, keyId: null };
}

// Resource kind → table holding its denormalized org_id. Whitelist keeps the
// dynamic identifier safe.
const ORG_TABLES = {
  competition: "competitions",
  division: "divisions",
  stage: "stages",
  entrant: "entrants",
  person: "persons",
  fixture: "fixtures",
  registration: "registrations",
  club: "clubs",
  team: "teams",
  import: "imports",
  official: "officials",
  fixture_official: "fixture_officials",
  suspension: "suspensions",
  org_post: "org_posts",
} as const;
export type ResourceKind = keyof typeof ORG_TABLES;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 404 (not 500) on a malformed uuid path segment. */
export function assertUuid(id: string, kind: string): void {
  if (!UUID_RE.test(id)) throw new HttpError(404, `${kind} not found`);
}

/** Look up the owning org of a resource (superuser read; 404 when absent). */
export async function resourceOrg(kind: ResourceKind, id: string): Promise<string> {
  assertUuid(id, kind);
  const table = ORG_TABLES[kind];
  const rows = await sql<{ org_id: string }[]>`
    select org_id from ${sql(table)} where id = ${id} limit 1`;
  if (!rows[0]) throw new HttpError(404, `${kind} not found`);
  return rows[0].org_id;
}

/** Resolve a resource's org, then authenticate the caller against it. */
export async function requireResourceAuth(
  req: Request,
  kind: ResourceKind,
  id: string,
  scope: Scope,
): Promise<AuthCtx> {
  const orgId = await resourceOrg(kind, id);
  return requireOrgAuth(req, orgId, scope);
}
