---
name: safe2026
description: >-
  Architecture, code structure, data model, and conventions for the S.A.F.E
  Tournaments Next.js app (multi-tenant orgs, tournament engine, auth). Use when
  editing safe2026, adding features, fixing bugs, or onboarding to this repo.
---

# S.A.F.E Tournaments — project skill

Multi-sport tournament management: organizations → seasons (optional) → tournaments → rounds/matches. Email/password + Google OAuth, org-scoped RBAC, Swiss/knockout/round-robin/stepladder formats.

## Tech stack

| Layer | Choice |
|-------|--------|
| App | Next.js 15 App Router, React 19, TypeScript |
| Styling | Tailwind CSS v4 (`src/app/globals.css` — `@apply` utility classes: `.btn`, `.card`, `.input`, `.badge`) |
| DB | PostgreSQL (Supabase) via `postgres` npm package — **no Supabase client SDK** |
| Validation | Zod schemas in `src/lib/types.ts` |
| Auth | bcrypt passwords, `jose` JWT in httpOnly cookie `safe_session`; active org in `safe_org` |
| Email | Resend (`src/lib/email.ts`) for verification links |

Env: see `.env.example` — `DATABASE_URL`, `AUTH_SECRET`, optional Google OAuth + Resend.

## Domain model (hierarchy)

```
User
 └── OrgMembership (role: owner | admin | viewer)
      └── Organization (name editable; slug auto e.g. org-abc123 — immutable ID)
           └── Season (optional grouping, e.g. SAFE2026)
                └── Tournament
                     ├── Player (name, optional image_url, checked_in)
                     ├── Round (stage: group | playoff | knockout | final)
                     └── Match (player1/2, winner, scores, next_match_id for bracket)
```

**Cross-cutting:** `match_events` (JSON snapshots for undo, max 3), `audit_log` (human-readable history, survives undo/reset).

Details: [reference.md](reference.md).

## Architecture layers

```
src/app/                    Pages (Server Components) + route handlers
src/app/api/                REST JSON API — wrap logic in handler() from lib/http.ts
src/components/             Client Components ("use client") — forms, live UI, modals
src/lib/
  types.ts                  Zod schemas + TypeScript types (source of truth for shapes)
  auth.ts                   Session, org resolution, RBAC helpers
  db.ts                     Lazy postgres client (server-only)
  http.ts                   handler() — { ok, data } / { ok, error } envelope
  client.ts                 Browser fetch helper (api())
  tournament.ts             Tournament lifecycle (start, result, undo, reset) — server-only
  pairing.ts                Pure pairing/bracket math (no DB)
  standings.ts              Pure standings (points, progress score, Buchholz)
  invites.ts, verification.ts, email.ts, oauth.ts
```

**Pattern:** Pure logic in `pairing.ts` / `standings.ts`; DB mutations in `tournament.ts` inside `sql.begin()` transactions; API routes stay thin (parse → authorize → delegate).

## Auth and multi-tenancy

### Sign-up / sign-in

- **Email only** (no username). Display name derived from email local-part on signup.
- Password signup: `email_verified = false` until `/verify-email?token=…`; no session until verified.
- Google OAuth: `email_verified = true` immediately; manual OAuth in `api/auth/google` + callback.
- **`next` param** preserved through signup/verify/login/OAuth (e.g. `/join/<token>` for invites).

### Post-auth landing (`postAuthLanding` in `auth.ts`)

| Scenario | Behavior |
|----------|----------|
| Safe `next` path (invite) | Redirect there; **no** auto-provision org if user has none |
| No `next` | `ensureActiveOrg()` — auto-create `"My organization"` with slug `org-<random>` if user belongs to no org; set `safe_org` cookie; redirect `/dashboard` |

### RBAC

| Role | Can |
|------|-----|
| `owner` | Everything + change member roles, remove members |
| `admin` | `EDITOR_ROLES`: create/edit tournaments, seasons, invites, rename org |
| `viewer` | Read tournament state only |

Check helpers: `requireUser()`, `requireOrgRole(orgId, roles)`, `requireTournamentEditor(tournamentId)`.

### Invites

- Created by editors; **1 hour TTL** (`expires_at` set server-side).
- Join flow: `/join/[token]` → sign in/up → accept via `POST /api/invites/[token]/accept` → sets active org.
- Role changes: `POST /api/orgs/[id]/members/[userId]/role` (owner only).

## Tournament engine

### Formats (`TournamentFormat`)

| Format | Flow |
|--------|------|
| `swiss_knockout` | N Swiss group rounds → knockout from standings |
| `knockout` | Single elimination only |
| `round_robin` | All-play-all, no knockout |
| `progress_stepladder` | Points league → conditional seeding playoffs → stepladder finals (Eliminator, Semi-final, Final) |

### Lifecycle

1. **Create** (`POST /api/tournaments`) — status `setup`, players inserted.
2. **Start** (`startTournament`) — generates round 1 pairings.
3. **Record result** (`recordResult`) — tap winner / enter scores; auto-advances players; generates next round when current round complete.
4. **Undo** (`undoLast`) — restores from `match_events` snapshot; decrements `undo_remaining` (default 3). **Disabled when status = completed.**
5. **Reset** (`resetTournament`) — back to `setup`, clears rounds/matches/events; keeps players. **Disabled when completed.**

### Scoring (`standings.ts`)

Points → progress score (win streak) → Buchholz → head-to-head. Configured per tournament via `ScoringConfig`.

### Key pure modules

- `pairing.ts` — `swissPairings`, `knockoutFirstRound`, `roundRobinRounds`, `recommendGroupRounds`
- `standings.ts` — `computeStandings`
- `format.ts` — display helpers, CSV export, active match filters

## API conventions

All routes use `handler(async () => { … })` returning `{ ok: true, data }` or `{ ok: false, error }`.

Client components call `api<T>(url, { method, json })` from `lib/client.ts`.

Full route list: [reference.md](reference.md#api-routes).

## UI pages

| Path | Purpose |
|------|---------|
| `/login` | AuthForm (email/password + Google) |
| `/verify-email` | Token consumption |
| `/dashboard` | Org-scoped tournament list by season |
| `/settings` | Active org details, rename, org switcher, team/invites |
| `/orgs/new` | Create additional org (name only; slug auto) |
| `/join/[token]` | Invite landing |
| `/tournaments/new` | Create tournament form |
| `/tournaments/[id]` | Live tournament (LiveTournament client component) |
| `/tournaments/[id]/slideshow` | Public-style slideshow |
| `/tournaments/[id]/print` | Printable bracket |

**Hydration:** use `ClientTime` for locale-formatted dates/times (avoids SSR mismatch).

## Development workflow

```bash
npm install
cp .env.example .env.local   # DATABASE_URL, AUTH_SECRET

# Apply schema (drops/recreates — dev only)
node --env-file=.env.local --experimental-strip-types scripts/apply-schema.ts

npm run dev                  # http://localhost:3000

# Tests
node --experimental-strip-types scripts/engine-check.ts   # pure logic
node --experimental-strip-types scripts/smoke.ts          # E2E vs running dev server
npm run lint && npx tsc --noEmit
npm run build
```

**Dev server note:** Do not run `next build` while `next dev` is active — stale `.next` cache causes MODULE_NOT_FOUND. Kill dev, delete `.next`, restart dev.

**Resend test mode:** only sends to account owner email; signup returns `verify_url` in dev when email fails.

## Conventions for changes

1. **Types first** — add Zod schema + inferred type in `types.ts`; use in API parse + UI.
2. **Scope mutations to org** — tournaments/seasons require active org + editor role.
3. **Server-only** — mark DB/auth/tournament modules with `import "server-only"`.
4. **Minimal diffs** — match existing patterns (`handler`, `api()`, Tailwind `@apply` classes).
5. **No demo seed** — DB starts empty; first user signs up via UI.
6. **Org slug** — never user-editable; auto-generated at create. Name editable via `PATCH /api/orgs/[id]`.
7. **Audit** — log user-visible actions via `writeAudit()` in tournament flows.

## File quick reference

| Task | Start here |
|------|------------|
| New API route | `src/app/api/.../route.ts` + `handler()` + types schema |
| Auth/session | `src/lib/auth.ts` |
| Tournament logic | `src/lib/tournament.ts` (mutations), `pairing.ts` / `standings.ts` (pure) |
| Schema change | `supabase/schema.sql` then `scripts/apply-schema.ts` |
| UI form | `src/components/*-form.tsx` pattern |
| RBAC on page | Server Component: `getCurrentUser` + `resolveActiveOrg` + role check |

## Additional resources

- [reference.md](reference.md) — full schema tables, API route map, tournament status machine
- [supabase/schema.sql](../../supabase/schema.sql) — canonical DDL
- [scripts/smoke.ts](../../scripts/smoke.ts) — integration test coverage examples
