# Seazn Club — Development & Productization Docs

This folder holds the **detailed technical design docs** for turning Seazn Club
from its current app state into an enterprise-grade SaaS product. Each document is a
self-contained design that an engineer (or agent) can pick up and implement later.

> **Scope note:** These docs deliberately **do not** cover migrating the *current*
> database or writing migrations for existing data. Schemas shown here are **greenfield
> designs** for new capabilities (billing, entitlements, SSO, etc.) to be built when the
> corresponding feature is scheduled.

## How to read these docs

Each doc follows the same structure so they're predictable to implement against:

1. **Goal** — what this section delivers and why it matters for the product.
2. **Current state** — what exists in the codebase today (grounding).
3. **Target design** — architecture, data shapes, APIs, components.
4. **Implementation detail** — concrete files, libraries, code-level guidance.
5. **Security & failure modes** — what can go wrong and how we guard it.
6. **Acceptance criteria** — definition of done.
7. **Open questions / decisions** — what to confirm before building.

## Document index

**Status:** ✅ done · 🟡 partial (remainder tracked in [DEFERRED.md](DEFERRED.md)) · ⏸ deferred · — planning only

| # | Document | Theme | Status |
|---|----------|-------|--------|
| 00 | [Phase 0/1 build checklist](00-phase-0-1-build-checklist.md) | **Start here** — ordered must-do list to paid launch | 🟡 |
| 01 | [Product strategy & positioning](01-product-strategy.md) | Segments, tiers, pricing model, GTM | — |
| 02 | [Target architecture](02-architecture.md) | System topology, runtime, services | 🟡 monolith · RLS · CSP · Redis done; Inngest/OTel deferred |
| 03 | [Multi-tenancy & data model](03-multi-tenancy-data-model.md) | Tenant isolation, RLS, entitlements schema | ✅ (migrations 010/011 pending apply) |
| 04 | [Security & compliance](04-security-compliance.md) | AuthN/Z, SSO/SCIM, app-sec, SOC 2/GDPR | 🟡 CSRF · headers · CSP · audit hash-chain · rate-limit done; SSO/SCIM/MFA deferred |
| 05 | [Payments & billing](05-payments-billing.md) | Stripe, plans, entitlements, webhooks | ✅ |
| 06 | [Marketing site & home page](06-marketing-site.md) | Public site, SEO, pricing, public pages | 🟡 |
| 07 | [Reliability, scale & operations](07-reliability-operations.md) | Envs, CI/CD, observability, DR, SLA | 🟡 CI gates · health · staging auto-deploy done; OTel/backups/status page deferred |
| 08 | [Feature roadmap](08-feature-roadmap.md) | Realtime, uploads, analytics, API, mobile | 🟡 realtime + uploads done |
| 09 | [Phased delivery plan](09-phased-plan.md) | Sequencing, milestones, staffing | — |
| 10 | [Supabase Realtime integration](10-supabase-realtime.md) | Live scoreboards via broadcast + refetch | ✅ |
| 11 | [Supabase Storage for assets](11-supabase-storage.md) | Player avatars, org logos, exports | ✅ |
| 12 | [Quality & engine correctness](12-quality-and-engine-correctness.md) | Tests, property/fuzz, engine invariants, CI gates | 🟡 engine-check · smoke · CI gates done; property/axe deferred |
| 13 | [Admin console & account lifecycle](13-admin-and-account-lifecycle.md) | Support console, impersonation, ownership transfer, account delete | ✅ |
| 14 | [Onboarding & lifecycle email](14-onboarding-and-lifecycle-email.md) | Activation, templates, email deliverability, journeys | 🟡 transactional email done; journeys need Inngest (deferred) |
| 15 | [Product-readiness backlog](15-product-readiness-backlog.md) | A11y, moderation, growth, performance, l10n, legal | ⏸ |

## Stack baseline (today)

These are the technologies the docs build on.

- **App:** Next.js 15 App Router, React 19, TypeScript
- **Styling:** Tailwind CSS v4 + shadcn/ui look ([doc 06 §10](06-marketing-site.md))
- **DB:** PostgreSQL (Supabase) via the `postgres` npm package — no Supabase client SDK
- **Validation:** Zod (`src/lib/types.ts`)
- **Auth:** bcrypt + `jose` JWT in httpOnly cookie `seazn_session`; active org in `seazn_org`
- **Email:** Resend (`src/lib/email.ts`)

## Conventions these docs assume

- **Types first** — every new shape is a Zod schema + inferred type in `src/lib/types.ts`.
- **Thin API routes** — parse → authorize → delegate to a server-only lib module; wrap in `handler()`.
- **Pure vs effectful** — keep pure logic (math, policy decisions) in dedicated modules; side effects in transactional lib functions.
- **Server-only modules** — DB/auth/billing modules import `"server-only"`.
- **Entitlement gate** — all paid capability checks go through one helper (see doc 05), enforced server-side, reflected in UI.

## Locked product decisions (2026-06)

| Decision | Choice |
|----------|--------|
| **Hosting** | Vercel (app) + Supabase (Postgres) — see doc 02 for realtime implications |
| **Pricing** | **Flat per-org only** — no per-seat or per-participant metering at launch |
| **Beachhead** | **Pro / clubs & academies** first; Enterprise tier **coming soon** (not Phase 1) |
| **Realtime on Vercel** | **Supabase Realtime** (broadcast) — [doc 10](10-supabase-realtime.md) |
| **Assets / media** | **Supabase Storage** (signed upload URLs) — [doc 11](11-supabase-storage.md) |

## Status legend used inside docs

- `MUST` — required for the phase that owns it.
- `SHOULD` — strongly recommended; defer only with rationale.
- `LATER` — explicitly out of scope for first build; captured so it isn't lost.
