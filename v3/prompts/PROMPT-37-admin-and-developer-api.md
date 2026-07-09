# PROMPT-37 — Admin Console v2 + Developer API (Scopes, OpenAPI, Docs)

**Read first:** `v3/08-admin-and-developer-api.md` (normative); `engine/08-api-design.md`;
billing-map memory (comped-downgrade path — reuse `/api/billing/downgrade`, don't fork).
Preamble: PROMPT-00. **Depends:** PROMPT-32 (ConfirmDialog `typedName`).

## Task
1. **Admin plan panel** (v3/08 §1) on `/admin/orgs/[id]`: plan + source + Stripe links;
   comp-to-Pro (until/forever), downgrade-with-freeze-preview, extend-trial (+7/+14/
   custom; syncs Stripe `trial_end` when sub exists); entitlement-override editor
   (key, value, expiry, reason); grant comped Event Pass. Every action requires reason →
   `admin_action` audit event (actor, before→after); destructive = `typedName` confirm.
2. **Key scopes** (v3/08 §2): `api_keys.scopes text[]` + nullable `competition_id` pin;
   route→scope allowlist map in the v1 auth wrapper, **default-deny unlisted routes**;
   never-key-accessible surfaces excluded structurally; new keys default `read`; existing
   migrate to `manage` + UI nudge; `last_used_at`; per-key token-bucket rate limit
   (free 60 / pro 300 rpm) + `X-RateLimit-*` + enveloped 429.
3. **Published docs** (v3/08 §3): curate spec to the scoped surface (exclude internal/
   session-only routes; tags, summaries, `x-required-scope`, examples) via
   `scripts/openapi-gen.ts`; CI spec-drift gate; `/developers` route with self-hosted
   Scalar (no CDN), three MDX guides (auth & scopes, read standings, push scores);
   `/developers/changelog` page.

## Acceptance
- Unit: default-deny on an unlisted route (add a fake route in test); pinned key 403
  outside its competition; `read` key 403 on POST with actionable error envelope; rate
  limit 429 after burst.
- E2E: admin extends trial → Stripe test reflects; downgrade preview lists frozen comps
  before confirm; override with expiry lapses (clock-controlled test); all admin actions
  present in audit with reason.
- `/developers` renders with JS from own origin only; spec-drift gate fails on uncommitted
  regeneration (prove once).
- `npm test` + `tsc` green; smoke.ts: read-key GET standings on pro; update v3/README.
