# Deferred work

Items from docs 00–15 that are intentionally **not implemented yet**, with why and how to
pick them up. Update this list as things land.

## Inngest — background jobs (docs 02 §5.5, 05, 14)
**Status:** deferred. Skipped for now.

Would cover: lifecycle emails (welcome, trial-ending, dunning), GDPR export/purge worker,
billing reconciliation, scheduled reports, webhook retries.

To implement later:
1. Create an Inngest account; set `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` (placeholders
   already stubbed in `.env.example`).
2. Add `/api/inngest` serve route + `src/lib/jobs/*` function definitions.
3. Move the heavy work in the Stripe webhook and any long requests onto the queue.

## SSO / SCIM (doc 04 §3.3–3.4)
**Status:** skipped by request. Enterprise-only.

WorkOS-based SAML/OIDC login + SCIM directory sync behind the `sso` entitlement. Needs a
WorkOS account (`WORKOS_API_KEY`, `WORKOS_CLIENT_ID`) and `org_sso_connections`.

## MFA / TOTP (doc 04 §3.2)
**Status:** deferred by request.

TOTP enrollment + hashed recovery codes + step-up for sensitive actions.

## Database migrations 010 + 011 — apply to live DBs
**Status:** code merged (PR #9), **not applied** to the hosted DB.

RLS org_id denormalization + audit hash-chain are dormant until applied. `/admin/audit`
degrades gracefully ("verification unavailable") meanwhile. Apply with `npm run db:apply`
(fresh DB) or run `010`/`011` against the existing DB.

## CSP enforcement (doc 04 §5)
**Status:** shipped as **Report-Only** (PR #9).

Flip `CSP_MODE=enforce` after verifying the browser console on staging. Enforcing forces
dynamic rendering (no static/CDN caching).

## Redis on production
**Status:** live on staging only.

`REDIS_URL` is set on `seazn-club-stg`. Set it on `seazn-club-prod` when ready to enable the
cache + Redis rate limiting there.

## gitleaks secret scan — make blocking
**Status:** advisory (`continue-on-error`) — the action's PR-API call is flaky.

Switch to a filesystem scan (gitleaks CLI, no GitHub API) with an allowlist for publishable
keys (Stripe `pk_`, Supabase anon), then make it block again.

## React hooks lint warnings — refactor flagged components
**Status:** downgraded to warnings in `apps/web/eslint.config.mjs`.

`eslint-config-next` 16 enables React-Compiler-era rules that flag existing components:
- `react-hooks/set-state-in-effect` (6×): `client-time`, `cookie-consent`,
  `new-tournament-form`, `org-team`, `slideshow-view`, `verify-email` — mostly
  mount-time/client-only state patterns; refactor per
  https://react.dev/learn/you-might-not-need-an-effect.
- `react-hooks/static-components` (1×): `org-sport-presets` creates `Icon` during render.
- `react-hooks/purity` (1×): `org-team` calls `Date.now()` during render.

Fix the components, then raise the three rules back to `error`.

## Other larger tracks still open (docs 06–15)
- Observability: OpenTelemetry traces, structured-log sink, status page (doc 07).
- Backups/PITR + tested restore drills, runbooks, SLAs (doc 07).
- Content moderation for public images/text; a11y (axe in Playwright); property-based engine
  tests with fast-check (docs 12, 15).
