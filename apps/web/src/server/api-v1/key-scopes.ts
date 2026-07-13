// Route → scope allowlist for API keys (v3/08 §2). Sessions are untouched —
// this map is the single authority for what a Bearer sc_ key may call.
// Default-deny: a (method, path) pair not listed here is 403 for every key,
// so a new route must declare its scope before keys can reach it (the
// key-scopes test enumerates route files against this map).
//
// Scopes are ranked: read < score < manage. `score` exists for integration
// scoreboards — push events and start divisions without handing over the
// whole management surface. Structurally excluded (never key-accessible):
// api-key management, Stripe connect, refunds, device-link minting, and the
// session-bound /me surface.

export type KeyScope = "read" | "score" | "manage";

const RANK: Record<KeyScope, number> = { read: 1, score: 2, manage: 3 };

/** Highest rank among a key's stored scopes (legacy: write ⇒ manage). */
export function keyRank(scopes: readonly string[]): number {
  let rank = 0;
  for (const s of scopes) {
    const mapped = s === "write" ? "manage" : (s as KeyScope);
    const r = RANK[mapped] ?? 0;
    if (r > rank) rank = r;
  }
  return rank;
}

export function scopeSatisfies(scopes: readonly string[], required: KeyScope): boolean {
  return keyRank(scopes) >= RANK[required];
}

/** Resource kinds a competition pin can be resolved through (see auth.ts). */
export type PinKind =
  | "competition"
  | "division"
  | "stage"
  | "fixture"
  | "entrant"
  | "registration"
  | "pool";

interface RouteRule {
  method: string;
  /** Path template relative to /api/v1, `:x` matches one segment. */
  path: string;
  scope: KeyScope;
  /** How to resolve the owning competition for pinned keys; a pinned key is
   *  403 on rules without one (org-wide surface). */
  pin?: PinKind;
}

// One line per (method, route) that keys may call. GET = read; mutations are
// manage unless they are the two scoring doors (score) or structurally
// excluded (absent). Keep sorted roughly by resource.
const RULES: RouteRule[] = [
  // clubs / teams (org-wide)
  { method: "GET", path: "/clubs", scope: "read" },
  { method: "POST", path: "/clubs", scope: "manage" },
  { method: "GET", path: "/clubs/:id", scope: "read" },
  { method: "PATCH", path: "/clubs/:id", scope: "manage" },
  { method: "DELETE", path: "/clubs/:id", scope: "manage" },
  { method: "POST", path: "/clubs/:id/teams", scope: "manage" },
  { method: "POST", path: "/clubs/logos", scope: "manage" },
  { method: "GET", path: "/teams", scope: "read" },
  { method: "POST", path: "/teams/:id/logo", scope: "manage" },
  { method: "DELETE", path: "/teams/:id/logo", scope: "manage" },
  { method: "GET", path: "/teams/:id/squad", scope: "read" },
  { method: "PUT", path: "/teams/:id/squad", scope: "manage" },

  // competitions
  { method: "GET", path: "/competitions", scope: "read" },
  { method: "POST", path: "/competitions", scope: "manage" },
  { method: "GET", path: "/competitions/:id", scope: "read", pin: "competition" },
  { method: "PATCH", path: "/competitions/:id", scope: "manage", pin: "competition" },
  { method: "DELETE", path: "/competitions/:id", scope: "manage", pin: "competition" },
  { method: "GET", path: "/competitions/:id/divisions", scope: "read", pin: "competition" },
  { method: "POST", path: "/competitions/:id/divisions", scope: "manage", pin: "competition" },
  { method: "GET", path: "/competitions/:id/exports/timetable", scope: "read", pin: "competition" },

  // divisions
  { method: "GET", path: "/divisions/:id", scope: "read", pin: "division" },
  { method: "PATCH", path: "/divisions/:id", scope: "manage", pin: "division" },
  { method: "DELETE", path: "/divisions/:id", scope: "manage", pin: "division" },
  { method: "POST", path: "/divisions/:id/archive", scope: "manage", pin: "division" },
  { method: "DELETE", path: "/divisions/:id/archive", scope: "manage", pin: "division" },
  { method: "GET", path: "/divisions/:id/checkpoints", scope: "read", pin: "division" },
  { method: "POST", path: "/divisions/:id/checkpoints", scope: "manage", pin: "division" },
  { method: "GET", path: "/divisions/:id/entrants", scope: "read", pin: "division" },
  { method: "POST", path: "/divisions/:id/entrants", scope: "manage", pin: "division" },
  { method: "GET", path: "/divisions/:id/exports/:kind", scope: "read", pin: "division" },
  { method: "GET", path: "/divisions/:id/history", scope: "read", pin: "division" },
  { method: "PATCH", path: "/divisions/:id/locks", scope: "manage", pin: "division" },
  { method: "POST", path: "/divisions/:id/officials/apply", scope: "manage", pin: "division" },
  { method: "POST", path: "/divisions/:id/officials/auto", scope: "manage", pin: "division" },
  { method: "POST", path: "/divisions/:id/publish-schedule", scope: "manage", pin: "division" },
  { method: "POST", path: "/divisions/:id/redo", scope: "manage", pin: "division" },
  { method: "GET", path: "/divisions/:id/registration-settings", scope: "read", pin: "division" },
  { method: "PUT", path: "/divisions/:id/registration-settings", scope: "manage", pin: "division" },
  { method: "GET", path: "/divisions/:id/registrations", scope: "read", pin: "division" },
  { method: "GET", path: "/divisions/:id/registrations/export", scope: "read", pin: "division" },
  { method: "POST", path: "/divisions/:id/restore", scope: "manage", pin: "division" },
  { method: "GET", path: "/divisions/:id/roster", scope: "read", pin: "division" },
  { method: "GET", path: "/divisions/:id/schedule-settings", scope: "read", pin: "division" },
  { method: "PUT", path: "/divisions/:id/schedule-settings", scope: "manage", pin: "division" },
  { method: "POST", path: "/divisions/:id/schedule/ai-constraints", scope: "manage", pin: "division" },
  { method: "GET", path: "/divisions/:id/schedule/report", scope: "read", pin: "division" },
  { method: "POST", path: "/divisions/:id/schedule/validate", scope: "read", pin: "division" },
  { method: "GET", path: "/divisions/:id/stages", scope: "read", pin: "division" },
  { method: "POST", path: "/divisions/:id/stages", scope: "manage", pin: "division" },
  { method: "PUT", path: "/divisions/:id/stages", scope: "manage", pin: "division" },
  { method: "POST", path: "/divisions/:id/start", scope: "score", pin: "division" },
  { method: "GET", path: "/divisions/:id/stats/players", scope: "read", pin: "division" },
  { method: "POST", path: "/divisions/:id/undo", scope: "manage", pin: "division" },

  // entrants
  { method: "GET", path: "/entrants/:id", scope: "read", pin: "entrant" },
  { method: "PATCH", path: "/entrants/:id", scope: "manage", pin: "entrant" },
  { method: "POST", path: "/entrants/:id/withdraw", scope: "manage", pin: "entrant" },

  // fixtures — events + state are the scoreboard surface
  { method: "GET", path: "/fixtures/:id", scope: "read", pin: "fixture" },
  { method: "PATCH", path: "/fixtures/:id", scope: "manage", pin: "fixture" },
  { method: "GET", path: "/fixtures/:id/events", scope: "read", pin: "fixture" },
  { method: "POST", path: "/fixtures/:id/events", scope: "score", pin: "fixture" },
  { method: "POST", path: "/fixtures/:id/finalize", scope: "manage", pin: "fixture" },
  { method: "GET", path: "/fixtures/:id/lineups/:entrantId", scope: "read", pin: "fixture" },
  { method: "PUT", path: "/fixtures/:id/lineups/:entrantId", scope: "manage", pin: "fixture" },
  { method: "PATCH", path: "/fixtures/:id/officials", scope: "manage", pin: "fixture" },
  { method: "GET", path: "/fixtures/:id/state", scope: "read", pin: "fixture" },

  // format preview: POST but a pure computation — read keys may plan
  { method: "POST", path: "/format-preview", scope: "read" },

  // imports (org-wide)
  { method: "POST", path: "/imports", scope: "manage" },
  { method: "GET", path: "/imports/:id", scope: "read" },
  { method: "POST", path: "/imports/:id/commit", scope: "manage" },

  // officials / persons (org-wide)
  { method: "GET", path: "/officials", scope: "read" },
  { method: "POST", path: "/officials", scope: "manage" },
  { method: "GET", path: "/officials/:id", scope: "read" },
  { method: "PATCH", path: "/officials/:id", scope: "manage" },
  { method: "DELETE", path: "/officials/:id", scope: "manage" },
  { method: "POST", path: "/officials/import", scope: "manage" },
  { method: "GET", path: "/persons", scope: "read" },
  { method: "POST", path: "/persons", scope: "manage" },
  { method: "GET", path: "/persons/:id", scope: "read" },
  { method: "PATCH", path: "/persons/:id", scope: "manage" },
  { method: "POST", path: "/persons/:id/merge", scope: "manage" },
  { method: "POST", path: "/persons/:id/photo", scope: "manage" },
  { method: "GET", path: "/persons/:id/profiles/:sport", scope: "read" },
  { method: "PUT", path: "/persons/:id/profiles/:sport", scope: "manage" },
  { method: "GET", path: "/persons/:id/stats", scope: "read" },
  { method: "GET", path: "/participants/export", scope: "read" },

  // pools / stages
  { method: "POST", path: "/pools/:id/clear-entrants", scope: "manage", pin: "pool" },
  { method: "DELETE", path: "/stages/:id", scope: "manage", pin: "stage" },
  { method: "GET", path: "/stages/:id/americano", scope: "read", pin: "stage" },
  { method: "POST", path: "/stages/:id/challenges", scope: "manage", pin: "stage" },
  { method: "POST", path: "/stages/:id/complete", scope: "manage", pin: "stage" },
  { method: "POST", path: "/stages/:id/generate", scope: "manage", pin: "stage" },
  { method: "POST", path: "/stages/:id/officials/source", scope: "manage", pin: "stage" },
  { method: "POST", path: "/stages/:id/schedule/apply", scope: "manage", pin: "stage" },
  { method: "POST", path: "/stages/:id/schedule/auto", scope: "manage", pin: "stage" },
  { method: "GET", path: "/stages/:id/standings", scope: "read", pin: "stage" },
  { method: "POST", path: "/stages/:id/standings/override", scope: "manage", pin: "stage" },

  // registrations moderation (refund excluded — money moves are billing;
  // mark-paid records receipt of an OFFLINE fee, no money moves online)
  { method: "POST", path: "/registrations/:id/confirm", scope: "manage", pin: "registration" },
  { method: "POST", path: "/registrations/:id/mark-paid", scope: "manage", pin: "registration" },
  { method: "POST", path: "/registrations/:id/waive", scope: "manage", pin: "registration" },
  { method: "POST", path: "/registrations/:id/remind", scope: "manage", pin: "registration" },
  { method: "POST", path: "/registrations/:id/waitlist", scope: "manage", pin: "registration" },
  { method: "POST", path: "/registrations/:id/withdraw", scope: "manage", pin: "registration" },

  // cross-division schedule ops (org-wide bodies — unpinnable)
  { method: "POST", path: "/schedule/clear", scope: "manage" },
  { method: "POST", path: "/schedule/shift", scope: "manage" },
];

// Never key-accessible, regardless of scope (v3/08 §2): credentials, money,
// membership, session-bound surfaces. Listed so the enumeration test can
// prove every route file is consciously classified.
export const NEVER_KEY_ROUTES: readonly string[] = [
  "GET /orgs/:id/api-keys",
  "POST /orgs/:id/api-keys",
  "DELETE /orgs/:id/api-keys/:keyId",
  "GET /orgs/:id/connect",
  "POST /orgs/:id/connect",
  "GET /me/assigned-fixtures",
  "POST /fixtures/:id/device-links",
  "GET /fixtures/:id/device-links",
  "DELETE /fixtures/:id/device-links/:linkId",
  "POST /registrations/:id/refund",
  // Browser-upload handshake (v8): signed URLs are a console UX, not an API
  // surface — a leaked key must not mint writable storage URLs.
  "POST /divisions/:id/logo-upload-url",
  // Player accounts (PROMPT-53): claim invites and check-in links mint login
  // capabilities; the /me surface is session-personal. Never key-accessible.
  "POST /persons/:id/claim-invites",
  "GET /persons/:id/claim-invites",
  "DELETE /persons/:id/claim-invites",
  "POST /persons/:id/unlink",
  "GET /me/fixtures",
  "PUT /me/fixtures/:id/availability",
  "GET /me/persons",
  "PATCH /me/persons/:id/consent",
  "POST /fixtures/:id/checkin-link",
];

// /api/v1/public/** and openapi.json take no auth at all — out of key scope.
export const PUBLIC_PREFIXES = ["/public/", "/openapi.json"] as const;

interface Compiled extends RouteRule {
  re: RegExp;
}

function compile(path: string): RegExp {
  const pattern = path
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${pattern}/?$`);
}

const COMPILED: Compiled[] = RULES.map((r) => ({ ...r, re: compile(r.path) }));

export interface RouteMatch {
  scope: KeyScope;
  pin?: PinKind;
  /** The `:id`-position segment (second path segment) when the rule pins. */
  resourceId: string | null;
}

/** Strip an absolute URL or pathname down to the part after /api/v1. */
export function v1Path(urlOrPath: string): string {
  const pathname = urlOrPath.startsWith("http") ? new URL(urlOrPath).pathname : urlOrPath;
  const i = pathname.indexOf("/api/v1");
  return i === -1 ? pathname : pathname.slice(i + "/api/v1".length) || "/";
}

/**
 * Look up the allowlist rule for a request. `null` means keys cannot call
 * this route at all (unlisted or structurally excluded) — default-deny.
 */
export function matchKeyRoute(method: string, urlOrPath: string): RouteMatch | null {
  const path = v1Path(urlOrPath);
  for (const rule of COMPILED) {
    if (rule.method === method.toUpperCase() && rule.re.test(path)) {
      // The resource id is always the segment right after the collection name.
      const resourceId = rule.pin ? (path.split("/")[2] ?? null) : null;
      return { scope: rule.scope, pin: rule.pin, resourceId };
    }
  }
  return null;
}

/** Exported for the enumeration test only. */
export const KEY_ROUTE_RULES: readonly RouteRule[] = RULES;
