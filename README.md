# Seazn Club

**Run any tournament, for any sport, in any format** — from a 4-player club night to a
multi-season regional league.

Seazn Club is a multi-tenant tournament management SaaS. Organisers create competitions
and divisions, enter live results, and share public standings and schedules. The product
differentiator is a **sport-aware tournament engine** with per-sport scoring fidelity
(cricket innings, football shootouts, volleyball sets, chess Swiss pairing) rather than
generic win/loss brackets.

---

## Repository layout

| Path | Purpose |
|------|---------|
| [`apps/web/`](apps/web/) | Next.js app — UI, API routes, billing, auth, public dashboard |
| [`packages/engine/`](packages/engine/) | Pure TypeScript tournament engine (`@seazn/engine`) |
| [`engine/`](engine/) | Engine v2 **design corpus** (PROMPT-00–15 landed) — domain model, sport specs, implementation prompts |
| [`development/`](development/) | Product & platform **design docs** — billing, security, realtime, phased plan |
| [`supabase/`](supabase/) | PostgreSQL schema + ordered migrations |
| [`openapi/`](openapi/) | Generated OpenAPI spec for `/api/v1` |
| [`scripts/`](scripts/) | DB bootstrap, engine checks, smoke tests, OpenAPI generation |

This is an npm workspace monorepo. Root scripts delegate to `apps/web` and
`packages/engine`.

---

## Stack

| Layer | Choice |
|-------|--------|
| App | Next.js App Router, React 19, TypeScript |
| Styling | Tailwind CSS v4 |
| Database | PostgreSQL (Supabase) via the `postgres` package — no Supabase client SDK for queries |
| Auth | bcrypt + `jose` JWT in httpOnly cookie; active org in a separate cookie |
| Realtime | Supabase Realtime broadcast (live scoreboards) |
| Storage | Supabase Storage (org logos, player avatars) |
| Billing | Stripe (flat per-org pricing) |
| Email | Resend |
| Cache / rate limits | Upstash Redis (optional; falls back to Postgres) |
| Observability | Sentry |

**Hosting (locked):** Vercel or Fly.io for the app, Supabase for Postgres. See
[`development/02-architecture.md`](development/02-architecture.md) for the target topology.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  apps/web — modular monolith                            │
│  Server Components · /api routes · webhooks · public UI │
└──────────────────────────┬──────────────────────────────┘
                           │ imports (pure logic only)
┌──────────────────────────▼──────────────────────────────┐
│  packages/engine — zero I/O, event-sourced, deterministic│
│  SportModule plugins · Competition engine · Scheduling  │
└──────────────────────────┬──────────────────────────────┘
                           │ events + snapshots persisted
┌──────────────────────────▼──────────────────────────────┐
│  PostgreSQL (Supabase) — RLS, billing, audit hash-chain   │
└───────────────────────────────────────────────────────────┘
```

**Two engines, one contract** (see [`engine/03-engine-architecture.md`](engine/03-engine-architecture.md)):

1. **Match Engine** — per-sport `SportModule` plugins own fixture scoring: event
   vocabulary, live state, validity, outcome.
2. **Competition Engine** — sport-agnostic core owns progression: stage graphs, fixture
   generation, standings, tiebreaker cascades.

The DB adapter persists events and derived snapshots; business rules never live in SQL.

### Engine modules (implemented)

| Module | Sports |
|--------|--------|
| `boardgame` | Chess, generic 1v1 |
| `setbased` | Volleyball, badminton, table tennis |
| `football` | Association football |
| `cricket` | T20 / ODI / 100-ball variants, NRR, DLS hook |
| `generic` | Fallback win/loss scoring |

Scheduling: round-robin (circle method), Swiss pairing, brackets, calendar slotting.
Conformance tests live in `packages/engine/src/testkit/`.

The [`engine/`](engine/) folder holds the full greenfield design — sport deep-dives,
greenfield schema, API design, entitlements matrix, and ordered
[`engine/prompts/`](engine/prompts/) for incremental implementation. Most prompts are landed
in `packages/engine` and `apps/web`; each design wave under [`design/`](design/) ships as
an ordered `PROMPT-*` batch (see status table below for per-wave status).

---

## Implementation status

Design corpus lives in [`design/`](design/) as ordered `PROMPT-*` waves. Waves v2, v3, v5,
v6–v13 are complete and merged to `main`. v4, v14 and v15 are designed, not yet built.

| Wave | Prompts | Focus | Status |
|------|---------|-------|--------|
| v2 | 00–29 | Engine v2 build-out + Jul3 batch (modules, scheduling, tier-1) | ✅ Complete |
| v3 | 30–40 | Routing, UI system, mobile, pricing v3, marketing redesign | ✅ Complete |
| v4 | 41–43 | AI schedule engine, refine/repair, board UX | ⬜ Pending |
| v5 | 44–47 | i18n foundation (en/fr/es/nl); modernized across app + score pads | ✅ Complete |
| v6 | 48–50 | Tennis, ice hockey, field hockey modules + pads | ✅ Complete |
| v7 | 51–52 | Platform revenue report, registration settings redesign | ✅ Complete |
| v8 | 53–54 | Player accounts, DB connection budget | ✅ Complete |
| v9 | 55 | Dispute / loss recovery | ✅ Complete |
| v10 | 56 | Sponsor CRM + monetization | ✅ Complete |
| v11 | 57 | Official onboarding | ✅ Complete |
| v12 | 58 | Scheduling docs + doc branding | ✅ Complete |
| v13 | 59–66 | Competition fidelity, bulk enrol, brackets, audit export, ad-hoc fixtures | ✅ Complete |
| v14 | 67 | Visual flow help pages | ⬜ Pending |
| v15 | 68–71 | Venue library + multi-venue scheduling | ⬜ Pending |

---

## Getting started

### Prerequisites

- Node.js 22+
- PostgreSQL (local or Supabase project)

### Install

```bash
npm ci
```

### Environment

One env file, and it lives at the repo root. `apps/web/.env.local` is a **symlink** to it,
so the dev server, the `db:*` scripts and vitest all read the same values. Both paths are
gitignored, so recreate the symlink in every fresh clone or worktree:

```bash
cp apps/web/.env.example .env.local
ln -sf ../../.env.local apps/web/.env.local
```

Required for local dev:

- `DATABASE_URL` — Supabase transaction pooler (port 6543) or local Postgres
- `AUTH_SECRET` — `openssl rand -hex 32`

Optional but needed for full feature coverage: Supabase keys (realtime, storage), Stripe
(test keys), Resend, Google OAuth. See [`apps/web/.env.example`](apps/web/.env.example)
for the full list.

### Database

Apply schema and migrations (local dev or CI bootstrap):

```bash
npm run db:apply
```

> **Warning:** `scripts/apply-schema.ts` drops data — use only on empty local databases.
> Production/staging should run migrations incrementally.

Sync the sport catalog from the engine registry after schema apply:

```bash
npm run sync:sports
```

### Run

```bash
npm run dev        # Next.js dev server at http://localhost:3000
npm run build      # production build
npm run start      # serve production build
```

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start the web app in development |
| `npm test` | Vitest in `apps/web` + `packages/engine` |
| `npm run test:smoke` | End-to-end HTTP smoke test (needs running server + DB) |
| `npm run engine:boundary` | Enforce zero-I/O boundary on `@seazn/engine` |
| `node --experimental-strip-types scripts/migrate-v1-to-v2.ts --dry-run` | v1→v2 data migration (idempotent; see script header) |
| `npm run db:apply` | Apply `schema.sql`, migrations, and `schema_v2.sql` |
| `npm run sync:sports` | Sync sport catalog from engine registry to DB |
| `npm run openapi:gen` | Regenerate `openapi/v1.json` |
| `npm run check:rls` | Fail if any `org_id` table lacks an RLS policy |

---

## Testing & CI

CI (`.github/workflows/ci.yml`) runs on every push and PR:

1. **Unit + typecheck** — TypeScript, engine checks, OpenAPI drift gate, Vitest
2. **Security** — gitleaks secret scan, `npm audit` (advisory)
3. **Smoke** — Postgres container → `db:apply` → RLS check → integration tests → dev
   server → HTTP smoke test

Integration tests under `apps/web/src/server/` and `apps/web/src/lib/__tests__/` require
`DATABASE_URL`. `apps/web/vitest.config.ts` loads the root `.env.local`, so a bare
`npx vitest run` picks it up; without a `.env.local` (CI) the vars must come from the
environment, or ~700 tests skip and the run still reports green. The **Smoke** job runs
both directories against a real Postgres.

The smoke test needs `DATABASE_URL` (DB-backed suites skip silently without it). Stripe
Connect destination charges additionally need `STRIPE_CONNECT_TEST_ACCOUNT` — a *real*
test-mode connected account id with charges enabled, since smoke's fabricated
`acct_smoke_*` id is rejected by Stripe. Without it that one assertion is skipped, not
failed, and the check count is unchanged. See [`apps/web/.env.example`](apps/web/.env.example).

---

## Documentation

### Product & platform — [`development/`](development/)

Detailed technical designs for turning the app into a paid, enterprise-grade SaaS.
Start with the [development README](development/README.md) and the
[Phase 0/1 build checklist](development/00-phase-0-1-build-checklist.md).

| Theme | Entry point |
|-------|-------------|
| Product strategy & tiers | [01-product-strategy.md](development/01-product-strategy.md) |
| System architecture | [02-architecture.md](development/02-architecture.md) |
| Multi-tenancy & RLS | [03-multi-tenancy-data-model.md](development/03-multi-tenancy-data-model.md) |
| Security & compliance | [04-security-compliance.md](development/04-security-compliance.md) |
| Stripe billing & entitlements | [05-payments-billing.md](development/05-payments-billing.md) |
| Supabase Realtime | [10-supabase-realtime.md](development/10-supabase-realtime.md) |
| Engine quality & CI gates | [12-quality-and-engine-correctness.md](development/12-quality-and-engine-correctness.md) |
| Deferred work tracker | [DEFERRED.md](development/DEFERRED.md) |

### Tournament engine — [`engine/`](engine/)

Greenfield design for Engine v2. Start with the [engine README](engine/README.md).

| Theme | Entry point |
|-------|-------------|
| Strategy & principles | [01-strategy.md](engine/01-strategy.md) |
| Domain model | [02-domain-model.md](engine/02-domain-model.md) |
| Package layout & SportModule contract | [03-engine-architecture.md](engine/03-engine-architecture.md) |
| Per-sport scoring specs | [04-sport-scoring-specs.md](engine/04-sport-scoring-specs.md) |
| Formats, tiebreakers, scheduling | [05-formats-progression-tiebreakers.md](engine/05-formats-progression-tiebreakers.md) |
| Greenfield DB schema | [07-greenfield-schema.md](engine/07-greenfield-schema.md) |
| Versioned API (`/api/v1`) | [08-api-design.md](engine/08-api-design.md) |
| Implementation prompts (ordered) | [engine/prompts/](engine/prompts/) |

---

## Conventions

These apply across app and engine code:

- **Types first** — Zod schema + inferred type before behaviour
- **Thin API routes** — parse → authorize → delegate to a server-only module; wrap in `handler()`
- **Pure vs effectful** — tournament math in `@seazn/engine` or pure lib modules; DB and side effects in transactional server modules (`import "server-only"`)
- **Entitlement gate** — all paid capability checks go through one helper, enforced server-side and reflected in UI
- **Engine boundary** — no `postgres`, `fetch`, `Date.now()`, or `Math.random()` inside `packages/engine`

---

## Product tiers (summary)

| Tier | Target | Highlights |
|------|--------|------------|
| Community | Hobbyists, small clubs | Free; limited tournaments/players |
| Pro | Clubs & academies (beachhead) | Unlimited events, branding, public pages, realtime |
| Business | Multi-venue operators | API, analytics, multiple admins |
| Enterprise | Federations, districts | SSO/SCIM, audit export, SLA (coming soon) |

Full entitlement matrix: [`development/01-product-strategy.md`](development/01-product-strategy.md)
and [`engine/10-pro-entitlements.md`](engine/10-pro-entitlements.md).
