# 10 — Supabase Realtime Integration

## 1. Goal

Replace the 5-second polling loop in the live tournament UI with **instant updates** using
**Supabase Realtime** — without self-hosting WebSockets on Vercel and without moving
writes off the existing `postgres` package + `tournament.ts` engine.

**Locked decision:** Supabase Realtime (broadcast channels) — not WebSockets, not SSE on
Vercel, not Redis pub/sub for fan-out.

## 2. Current state

- **Writes:** `recordResult` / `startTournament` / etc. mutate Postgres via `src/lib/db.ts`
  (`postgres` npm package) inside `sql.begin()` transactions. No Supabase client SDK.
- **Reads:** `GET /api/tournaments/[id]/state` → `loadState()` returns full `TournamentState`.
- **Live UI:** `LiveTournament` polls every **5 seconds** (`setInterval(refresh, 5000)`).
- **Auth:** Custom JWT in httpOnly cookie `seazn_session` — **not** Supabase Auth.
- **Env today:** `DATABASE_URL` only. No `NEXT_PUBLIC_SUPABASE_*` keys.

## 3. Why broadcast (not postgres_changes)

Supabase Realtime offers two relevant mechanisms:

| Mechanism | How it works | Fit for Seazn Club |
|-----------|--------------|-----------------|
| **`postgres_changes`** | WAL replication pushes row INSERT/UPDATE/DELETE to subscribers | Zero server publish code, but sends **row payloads** to the client and requires RLS aligned with Supabase's JWT roles. Harder with custom cookie auth. |
| **`broadcast`** | Explicit messages on a named channel; server publishes after writes | **Recommended.** Server controls what is sent; client refetches authoritative state via existing `/state` API. Minimal payload = no stale partial state. |

**Chosen pattern: broadcast + refetch**

1. Server publishes a tiny event after a successful mutation (`{ version, reason }`).
2. Client receives event → debounced `refresh()` → `GET /state` (existing, authoritative).
3. Engine logic stays untouched; realtime is a **notification layer only**.

This avoids duplicating standings/bracket logic on the client and avoids leaking match rows
through overly permissive RLS.

## 4. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (LiveTournament, slideshow, public page)               │
│   @supabase/supabase-js  ← realtime ONLY (no DB queries)        │
│   subscribe: tournament:{id}  →  on event  →  GET /state        │
└───────────────────────────────┬─────────────────────────────────┘
                                │ WebSocket (Supabase Realtime)
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Supabase Realtime service                                       │
│   private channel: tournament:{uuid}                             │
└───────────────────────────────┬─────────────────────────────────┘
                                ▲
                                │ broadcast (service role, server-only)
┌───────────────────────────────┴─────────────────────────────────┐
│  Vercel — Next.js API routes                                     │
│   recordResult / undo / reset / start  →  postgres tx  →        │
│   publishTournamentUpdate(tournamentId, reason)  ← NEW            │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
                         PostgreSQL (Supabase)
                         (unchanged write path)
```

## 5. Environment variables

Add to `.env.example` and Vercel project settings:

```bash
# Supabase project (Settings → API)
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...          # public, safe in browser

# Server-only — never expose to client
SUPABASE_SERVICE_ROLE_KEY=eyJ...              # broadcast publish
SUPABASE_JWT_SECRET=your-jwt-secret           # mint realtime subscriber tokens
                                              # (Settings → API → JWT Secret)
```

Keep `DATABASE_URL` as-is for the `postgres` package. Realtime uses the HTTP/WebSocket API,
not the database connection string.

## 6. Channel design

### 6.1 Channel name

```
tournament:{tournamentId}
```

Example: `tournament:263c5164-0465-464c-ba96-ed2a66145838`

- One channel per tournament.
- Private channel (`config: { private: true }`) — requires a valid subscriber JWT.

### 6.2 Event name

```
state_changed
```

### 6.3 Payload (minimal — client refetches full state)

```ts
type RealtimeTournamentEvent = {
  v: number;           // monotonic version (see §7)
  reason: "result" | "undo" | "reset" | "start" | "checkin" | "players";
  at: string;          // ISO timestamp
};
```

Do **not** send full `TournamentState` over realtime — `/state` remains the source of truth.

## 7. Version / debouncing

**Problem:** one `recordResult` can update multiple rows (match + next round matches).
Multiple WAL/broadcast events could cause N refetches.

**Solution:** maintain a lightweight version counter per tournament.

```sql
-- greenfield addition when implementing (not a migration of existing data doc)
ALTER TABLE tournaments ADD COLUMN state_version bigint NOT NULL DEFAULT 0;
```

Inside the same transaction as the mutation:

```sql
UPDATE tournaments SET state_version = state_version + 1 WHERE id = ${tournamentId}
RETURNING state_version;
```

Publish includes the returned `v`. Client debounces refetch (200–300 ms) and skips if it
already fetched `v` or higher.

Alternative without schema change: publish once per mutation from application code only
(after `sql.begin()` completes) — **preferred for first implementation** since it needs no
column. One broadcast per user action, not per row.

## 8. Server modules (new)

### 8.1 `src/lib/supabase-admin.ts` (server-only)

```ts
import "server-only";
import { createClient } from "@supabase/supabase-js";

let admin: ReturnType<typeof createClient> | null = null;

export function supabaseAdmin() {
  if (!admin) {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }
  return admin;
}
```

### 8.2 `src/lib/realtime.ts` (server-only)

```ts
import "server-only";
import { supabaseAdmin } from "./supabase-admin";
import type { RealtimeTournamentEvent } from "./types";

export async function publishTournamentUpdate(
  tournamentId: string,
  reason: RealtimeTournamentEvent["reason"],
): Promise<void> {
  const channel = supabaseAdmin().channel(`tournament:${tournamentId}`);
  const payload: RealtimeTournamentEvent = {
    v: Date.now(), // or state_version from DB
    reason,
    at: new Date().toISOString(),
  };
  await channel.send({
    type: "broadcast",
    event: "state_changed",
    payload,
  });
  // fire-and-forget; log errors to Sentry, never fail the mutation
}
```

Call `publishTournamentUpdate` **after** transaction commit in:
- `recordResult`
- `undoLast`
- `resetTournament`
- `startTournament`
- player check-in / add / remove (if live UI should update)

Wrap in `try/catch` — a failed broadcast must **not** roll back a recorded result.

### 8.3 Entitlement gate

Before issuing a subscriber token or enabling client subscription:

```ts
await requireFeature(orgId, "realtime");  // doc 05
```

**Community tier:** no token endpoint → client keeps 5 s polling fallback.

## 9. Subscriber authentication (custom auth + Supabase Realtime)

We do **not** use Supabase Auth for login. Subscribers authenticate to Realtime with a
**short-lived JWT** minted by our API, signed with `SUPABASE_JWT_SECRET`.

### 9.1 Token endpoint

```
GET /api/tournaments/[id]/realtime-token
```

**Auth:** existing `seazn_session` cookie (or public access rules for public tournaments —
doc 06).

**Response:**

```json
{
  "ok": true,
  "data": {
    "token": "eyJ...",
    "channel": "tournament:263c5164-...",
    "expires_at": "2026-06-30T11:00:00.000Z"
  }
}
```

**Minting (jose — already in project):**

```ts
import { SignJWT } from "jose";

export async function mintRealtimeToken(
  userId: string,
  tournamentId: string,
  ttlSeconds = 3600,
): Promise<string> {
  return new SignJWT({
    role: "authenticated",
    sub: userId,
    tournament_id: tournamentId,  // custom claim for logging
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .setAudience("authenticated")
    .sign(new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET!));
}
```

### 9.2 Realtime Authorization (Supabase dashboard)

Enable **Realtime Authorization** for broadcast channels. Add a policy (via Supabase
dashboard or SQL) allowing `authenticated` role to subscribe to channels matching the
tournament the user may access.

Example policy concept (exact SQL per Supabase Realtime auth docs at implementation time):

- Allow `subscribe` on `tournament:{id}` if request carries valid JWT and user has access
  to that tournament (org member or public tournament).

For v1, a pragmatic approach: token endpoint already enforces access; channel name includes
unguessable UUID; private channel + short-lived JWT is sufficient for Pro launch. Tighten
with Realtime Authorization policies in Phase 3.

## 10. Client integration

### 10.1 `src/lib/supabase-browser.ts` (client-only)

```ts
"use client";
import { createClient } from "@supabase/supabase-js";

export function supabaseBrowser() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
```

**Scope:** realtime subscriptions only. Do not use for DB reads/writes — keep `api()` +
route handlers.

### 10.2 `src/hooks/use-tournament-realtime.ts` (new)

```ts
"use client";

export function useTournamentRealtime(
  tournamentId: string,
  onUpdate: () => void,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled) return;

    let channel: RealtimeChannel | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    (async () => {
      const { token, channel: ch } = await api<RealtimeToken>(
        `/api/tournaments/${tournamentId}/realtime-token`,
      );
      if (cancelled) return;

      const sb = supabaseBrowser();
      await sb.realtime.setAuth(token);

      channel = sb
        .channel(ch, { config: { private: true } })
        .on("broadcast", { event: "state_changed" }, () => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(onUpdate, 250);
        })
        .subscribe((status) => {
          if (status === "CHANNEL_ERROR") {
            /* fall back silently; polling continues if enabled */
          }
        });
    })();

    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      channel?.unsubscribe();
    };
  }, [tournamentId, onUpdate, enabled]);
}
```

### 10.3 Changes to `LiveTournament`

```tsx
// Replace unconditional polling with:
const realtimeEnabled = /* from props or /entitlements */;

useTournamentRealtime(id, refresh, realtimeEnabled);

useEffect(() => {
  if (realtimeEnabled) return;           // realtime handles updates
  const t = setInterval(refresh, 5000);  // Community fallback
  return () => clearInterval(t);
}, [refresh, realtimeEnabled]);
```

After local `act()` (scorekeeper records result), still call `refresh()` once immediately
(optimistic UX) — broadcast confirms other clients.

### 10.4 Slideshow + public pages

Same hook on `/tournaments/[id]/slideshow` and future `/t/[slug]` public page when
`realtime` entitlement is active (or always for public live events — product choice).

## 11. Supabase project configuration

When implementing, configure in Supabase dashboard:

1. **Realtime enabled** (default on).
2. **Broadcast** enabled for the project.
3. Do **not** enable `postgres_changes` replication on `matches`/`rounds` unless we pivot
   — not needed for broadcast pattern.
4. **JWT secret** copied to `SUPABASE_JWT_SECRET` on Vercel.
5. **Service role key** server-only on Vercel.

## 12. Security

| Risk | Mitigation |
|------|------------|
| Service role key leaked | Server-only env; never `NEXT_PUBLIC_*`; scan CI for leaks |
| Unauthorized subscribe | Token endpoint checks session + org access + `realtime` entitlement |
| Channel enumeration | UUID tournament ids; private channels; short-lived JWT |
| Broadcast injection | Only server (service role) publishes; clients subscribe only |
| Stale subscriber token | 1 h TTL; client reconnects on `TOKEN_EXPIRED`; refresh token via endpoint |

## 13. Failure modes & fallbacks

| Failure | Behavior |
|---------|----------|
| Realtime disconnect | Client auto-reconnects (supabase-js); keep optional slow poll as safety net (30–60 s) on Pro |
| Token endpoint 403 (Community) | Polling only (current behavior) |
| Broadcast publish fails | Result still saved; log to Sentry; other clients update on next poll |
| Supabase outage | Degrade to polling; status page communication |

## 14. Dependencies

```json
"@supabase/supabase-js": "^2.x"
```

Add only this package. Do **not** adopt `@supabase/ssr` or move auth to Supabase Auth.

Shared with [11-supabase-storage.md](11-supabase-storage.md): `src/lib/supabase-admin.ts`.

## 15. Testing

### 15.1 Unit
- `mintRealtimeToken` produces valid JWT (verify with `jose` `jwtVerify`).

### 15.2 Integration (extend `scripts/smoke.ts`)
1. Create tournament, start, open two sessions (or fetch token + subscribe in test harness).
2. Session A records result.
3. Session B receives broadcast within 2 s (or state changes without manual refresh).

### 15.3 Manual
- Two browser tabs on same tournament; score in one; other updates < 1 s.
- Community org: confirm polling only, no token issued.

## 16. Implementation checklist

- [ ] Add env vars to `.env.example` + Vercel
- [ ] Install `@supabase/supabase-js`
- [ ] `src/lib/supabase-admin.ts`, `src/lib/realtime.ts`
- [ ] `GET /api/tournaments/[id]/realtime-token` with entitlement gate
- [ ] Call `publishTournamentUpdate` after mutations in `tournament.ts`
- [ ] `src/lib/supabase-browser.ts` + `use-tournament-realtime.ts`
- [ ] Wire `LiveTournament` (realtime on Pro+, polling fallback on Community)
- [ ] Wire slideshow / public pages
- [ ] Smoke test for two-client update
- [ ] Sentry breadcrumb on publish failure

## 17. Acceptance criteria

- Pro+ org: result entered on device A appears on device B **< 1 s** without manual refresh.
- Community org: unchanged polling behavior; no realtime token issued.
- Writes still go through `postgres` + `tournament.ts`; no regression in engine tests.
- Service role key never exposed to browser.
- Broadcast failure never blocks recording a result.

## 18. Phase placement

**Phase 2** (doc 09) — Stickiness, alongside public pages and uploads. Not required for
Phase 1 billing launch.

## 19. Decisions (locked)

- **Transport:** Supabase Realtime **broadcast** channels.
- **Not using:** self-hosted WebSockets on Vercel, SSE, Redis pub/sub for live scores.
- **SDK scope:** `@supabase/supabase-js` for realtime only; DB access stays on `postgres` package.
- **Client update strategy:** notify + refetch `/state` (not push full state).
