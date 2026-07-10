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

`eslint-config-next` 16 enables React-Compiler-era rules that flag existing components
(several offenders were deleted at the PROMPT-15 cutover; remaining):
- `react-hooks/set-state-in-effect`: `client-time`, `cookie-consent`, `org-team`,
  `verify-email`, `v2/pads/cricket-pad` — mount-time/state-sync patterns; refactor per
  https://react.dev/learn/you-might-not-need-an-effect.
- `react-hooks/purity` (1×): `org-team` calls `Date.now()` during render.

Fix the components, then raise the rules back to `error`.

## Engine v1 cutover (PROMPT-15) — remainders
**Status:** code cutover complete; v1 engine/UI/routes deleted, migration tooling shipped.

- **Per-org `ENGINE_V2` flag / staged rollout — consciously dropped.** The flag only makes
  sense while v1 and v2 UIs coexist in one build; keeping v1 alive for it would contradict
  the acceptance bar ("v1 code deleted, bundle free of old engine"). The staged-rollout
  role is covered by `scripts/migrate-v1-to-v2.ts` per-org batching (`--org=<uuid>`) +
  `--dry-run`, rehearsed on staging before the single cutover deploy.
- **Production cutover runbook** (do in order): ① restore a prod snapshot into staging;
  ② `npm run db:apply`-equivalent state (schema_v2 + 012 applied); ③ run
  `migrate-v1-to-v2.ts --dry-run`, then real run — verification must print `✓ verified`
  (0 mismatches) for every org; ④ manual checklist: open one real historical tournament in
  the v2 UI (standings, fixtures, winners) and its old `/t/{slug}` URL (must 301);
  ⑤ apply `supabase/migrations/013_v1_cutover.sql` (archives `audit_log → audit_log_v1`,
  drops v1 tables); ⑥ deploy; ⑦ smoke (`npm run test:smoke`) against staging, then repeat
  on prod.
- **Eligibility enforcement at roster add** (doc 06 §2.2) — the division builder stores
  `EligibilityRule[]` and the entrants panel displays them, but the service layer does not
  yet block/override on DOB/gender; lands with the compliance panel.
- **Scheduling console** (auto-scheduler, drag-and-drop board) — PROMPT-17.
- **Scorer role & scoped console** — PROMPT-18; the fixture console currently requires an
  editor role.
- **Organiser realtime** — the fixture console resyncs on action/409; live push (the
  public dashboard already has it) can be wired to `fixture:{id}` later.

## Other larger tracks still open (docs 06–15)
- Observability: OpenTelemetry traces, structured-log sink, status page (doc 07).
- Backups/PITR + tested restore drills, runbooks, SLAs (doc 07).
- Content moderation for public images/text; a11y (axe in Playwright); property-based engine
  tests with fast-check (docs 12, 15).
