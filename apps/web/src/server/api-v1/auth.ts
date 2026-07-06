import "server-only";
// /api/v1 authentication (doc 08 §2): session cookie (our UI) or API key
// (Pro integrations — `Authorization: Bearer sc_…`). Both resolve to the
// same AuthCtx so use-cases don't care which door the caller came through.
import { createHash, randomBytes } from "node:crypto";
import { sql } from "@/lib/db";
import { getOrgRole, requireUser, resolveActiveOrg } from "@/lib/auth";
import { AuthError, HttpError } from "@/lib/errors";
import { requireFeature } from "@/lib/entitlements";
import { rateLimit } from "@/lib/rate-limit";
import { EDITOR_ROLES, READ_ROLES, type OrgRole } from "@/lib/types";

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
}

// Pro sustained rate (doc 08 §6): 10 rps per key, enforced on a 10 s window so
// courtside bursts don't trip it.
const API_KEY_LIMIT = { max: 100, windowSeconds: 10 };

async function apiKeyAuth(token: string, orgId: string | null, scope: Scope): Promise<AuthCtx> {
  const [key] = await sql<ApiKeyRow[]>`
    select id, org_id, scopes from api_keys
    where key_hash = ${hashApiKey(token)} and revoked_at is null limit 1`;
  if (!key || (orgId !== null && key.org_id !== orgId)) throw new AuthError("Invalid API key");
  await requireFeature(key.org_id, "api.access");
  // write scope implies read.
  const granted = key.scopes.includes(scope) || (scope === "read" && key.scopes.includes("write"));
  if (!granted) throw new HttpError(403, `API key lacks the '${scope}' scope`);
  await rateLimit(`apikeyv1:${key.id}`, API_KEY_LIMIT);
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
  if (token) return apiKeyAuth(token, orgId, scope);
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
 * passes for `read` only. The capability config gates (finalize, lineups,
 * void-pre-finalize) stay in the use-cases, which re-check via
 * requireScorable.
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
  if (token) return apiKeyAuth(token, orgId, intent === "read" ? "read" : "write");
  const user = await requireUser();
  const role = await getOrgRole(orgId, user.id);
  if (!role) throw new AuthError("You are not a member of this organization");
  const ctx: AuthCtx = { orgId, via: "session", userId: user.id, role, keyId: null };
  if (role === "owner" || role === "admin") return ctx;
  if (role === "viewer" && intent === "read") return ctx;
  if (role === "scorer") {
    const { requireScorable } = await import("@/server/usecases/scorers");
    await requireScorable(ctx, fixtureId); // 403 without a covering assignment
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
  if (token) return apiKeyAuth(token, null, scope);
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
  import: "imports",
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
