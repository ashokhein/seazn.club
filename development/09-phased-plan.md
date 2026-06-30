# 09 — Phased Delivery Plan

## 1. Goal

Sequence the work from docs 01–08 into phases with clear themes, deliverables, exit
criteria, and dependencies — so the product can be built incrementally without rework.

## 2. Guiding principles

- **Foundations before features.** Don't ship monetized features on un-hardened infra.
- **Revenue early.** Billing + entitlements land right after hardening so we can charge.
- **Sell up later.** Enterprise (SSO/SCIM/SOC 2) follows once self-serve validates demand.
- **Each phase is shippable** and leaves the product in a coherent, sellable state.

## 3. Phases

### Phase 0 — Production hardening (foundation)
**Theme:** Make it a real, operable system. **Docs:** 02, 03, 04, 07.

Deliverables:
- Environments (dev/staging/prod) with isolated data + secrets (07).
- CI/CD: lint, typecheck, engine-check, smoke, security scans; staging→prod gate (07).
- Connection pooler in front of Postgres (02, 07).
- Observability: Sentry, structured logs, metrics, uptime + SLO alerts (07).
- Backups + PITR + tested restore drill (07).
- Security baseline: secret store + `AUTH_SECRET` rotation, session revocation, rate
  limiting, security headers, CSRF (04).
- Tenant isolation hardening: RLS + `withTenant` + `org_id` denormalization (03).

**Exit criteria:** prod deploys are gated, observable, reversible, and backed up; tenant
isolation enforced at the DB; no secrets in repo.

### Phase 1 — Monetization (get paid)
**Theme:** Plans, entitlements, billing, and a marketing front door. **Docs:** 01, 03, 05, 06.

Deliverables:
- Plans/subscriptions/entitlements/usage tables (03).
- `entitlements.ts` single gate; enforce on create-tournament + player limits (03, 05).
- Stripe Checkout + Customer Portal + verified idempotent webhooks (05).
- Billing UI: plan page, upgrade prompts, dunning banner (05).
- Marketing site: home, pricing, ≥3 use-case pages, legal pages; analytics + consent (06).
- 14-day Pro trial; suspended = read-only (01, 05).

**Exit criteria:** a new user can sign up, start a trial, pay, and be correctly entitled;
limits enforced server-side; marketing site live and converting.

### Phase 2 — Stickiness (retention & PLG flywheel)
**Theme:** Make it delightful and self-marketing. **Docs:** 06, 08.

Deliverables:
- Realtime scoreboards (Supabase Realtime — doc 10) gated by `realtime`.
- Managed uploads (Supabase Storage — doc 11) gated by `branding`.
- Managed media uploads (player/org images) + branding (08, doc 11).
- Public branded tournament pages `/t/[slug]` with OG images + SEO + public/private (06, 08).
- Email notifications (round start, match ready, results) (08).
- PWA: installable + offline-tolerant score entry (08).

**Exit criteria:** live updates < 1s across devices; shareable public pages drive signups;
organizers get timely notifications; scorekeeping works on mobile.

### Phase 3 — Move upmarket (enterprise readiness)
**Theme:** Governance, depth, integrations. **Docs:** 03, 04, 08.

Deliverables:
- SSO/SAML + SCIM (buy via WorkOS/Auth0) gated by `sso` (04).
- Custom roles + permission catalog + `can()` (04).
- Tamper-evident audit + export/SIEM gated by `audit.export` (04).
- Leagues/seasons depth + cross-event standings (03, 08).
- Analytics + player ratings (Elo/Glicko) + reports (08).
- Public API + outbound webhooks gated by `api` (08).
- SOC 2 Type II program kickoff (Vanta/Drata) + pen test (04).

**Exit criteria:** an enterprise can authenticate via their IdP, get provisioned via SCIM,
operate under custom roles, export audit to SIEM, and integrate via API; SOC 2 in progress.

### Phase 4 — Scale & expansion (ongoing)
**Theme:** Grow TAM and harden at scale. **Docs:** 02, 03, 07, 08.

Deliverables:
- i18n + white-label (08).
- Additional engine formats by demand (double-elim, groups→knockout, Americano) (08).
- Read replica + regional data residency (02, 03, 07).
- SOC 2 completion → ISO 27001 as needed (04).
- Cost-per-tenant optimization + capacity reviews (07).

**Exit criteria:** product serves international, large, multi-region customers with
compliance evidence and healthy unit economics.

## 4. Dependency graph (summary)

```
Phase 0 (hardening) ──▶ Phase 1 (billing/entitlements) ──▶ Phase 2 (stickiness)
        │                       │                                  │
        └──────────────┬────────┴──────────────────────────────────┘
                       ▼
                 Phase 3 (enterprise) ──▶ Phase 4 (scale/expansion)
```

- Entitlements (Phase 1) is a hard dependency for every gated feature in Phases 2–4.
- RLS + observability + CI/CD (Phase 0) underpin everything.
- SSO/SCIM/audit (Phase 3) gate enterprise revenue; SOC 2 timeline is the long pole.

## 5. Workstreams (parallelizable within phases)

- **Platform/Infra:** envs, CI/CD, pooling, observability, backups, queue/redis/storage.
- **Core product:** engine features, realtime, uploads, analytics, API.
- **Growth:** marketing site, public pages, SEO, conversion.
- **Trust:** security hardening, SSO/SCIM, compliance program.
- **Billing:** Stripe, entitlements, plan management.

## 6. Cross-phase definition of done (every feature)

- Zod types in `types.ts`; thin API route via `handler()`; server-only effectful module.
- Entitlement-gated (server-enforced) where applicable; UI upgrade prompts.
- Tests: pure logic in `engine-check.ts`; flows in `smoke.ts`.
- Observability: logs/metrics/traces; errors to Sentry.
- Docs updated (this folder + project skill); changelog entry.

## 7. Acceptance criteria (for the plan itself)

- Every doc 01–08 deliverable is assigned to a phase.
- Dependencies explicit; entitlements precede gated features.
- Each phase has clear exit criteria and leaves a shippable product.

## 8. Decisions (locked vs open)

**Locked:**
- Beachhead: **Pro/clubs**; Enterprise **coming soon** (Phase 3, not Phase 1).
- Hosting: **Vercel + Supabase**; realtime via **Supabase Realtime broadcast** (doc 10).

**Still open:**
1. Team capacity / calendar per phase.
