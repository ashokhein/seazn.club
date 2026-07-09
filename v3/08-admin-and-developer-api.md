# v3/08 — Admin Console v2 & Developer API (OpenAPI, Scoped Keys, Docs)

Owns intake #26 (admin: coupons ✅ exist, extend trial, upgrade/downgrade orgs) and #6
(publish OpenAPI, restrict developer keys, documentation). Extends engine/08 (API design).

## 1. Admin console v2 (intake #26)

Exists today: `/admin` with users, orgs, coupons, impersonate, audit. Additions, all on
`/admin/orgs/[id]`:

- **Plan panel:** current plan, source (stripe / comped / pass), Stripe links.
  Actions: **Comp to Pro** (until date or forever), **Downgrade to Free** (immediate,
  runs the entitlement freeze preview first and *shows* what will freeze),
  **Extend trial** (+7/+14/custom — writes `trial_end` in-app and, when a Stripe sub
  exists, `subscriptions.update({trial_end})` so Stripe agrees).
- **Entitlement override editor:** table of `entitlement_overrides` for the org
  (feature key, value, expiry, reason) — the §grandfathering tool for v3/07 and the
  answer to one-off customer asks without code.
- **Event passes:** list/grant a comped pass on a competition (support tool).
- **Guardrails:** every action requires a reason string; writes an `admin_action` audit
  event (actor, org, before→after); destructive ones use ConfirmDialog `typedName`
  (v3/03 §3). No raw plan-column edits anywhere in admin UI.

## 2. Developer keys — restrict what a key can do (intake #6)

Today `/api/v1` accepts session OR api-key with the key acting as the org — too broad to
document publicly. Introduce scopes before the docs go live:

- **Scopes** (stored on `api_keys.scopes text[]`):
  - `read` — GET everything the org can see (comps, divisions, entrants, fixtures,
    standings, stats, registrations).
  - `score` — POST fixture events + start divisions (integration scoreboards).
  - `manage` — full v1 surface (create/generate/schedule/registrations moderation).
  - Never key-accessible regardless of scope: billing, org membership/roles, api-key
    management, admin, auth. Enforced by an explicit allowlist map route→scope in the
    v1 auth wrapper (default-deny for unlisted routes — new routes must declare a scope).
- **Optional resource pin:** `api_keys.competition_id` nullable — key valid only inside
  one competition (hand a scoreboard vendor a key that can't touch anything else).
- **Defaults:** new keys = `read` only; UI checkbox list with plain-language consequence
  lines (v3/03 §7 style). Existing keys migrate to `manage` (no breakage), flagged in UI
  ("this key has full access — consider narrowing").
- **Hygiene:** keys already hashed (assumed); add `last_used_at` touch, per-key rate
  limit (free 60 rpm / pro 300 rpm, token bucket), `X-RateLimit-*` headers, 429 body
  matching the standard error envelope.
- API keys remain a Pro feature (current gating unchanged).

## 3. Published OpenAPI + docs (intake #6)

`openapi/v1.json` (1.1 MB) and `/api/v1/openapi.json` exist but are generated-and-forgotten:

- **Curate the spec:** exclude session-only/internal routes from the published spec
  (publish exactly the scoped surface of §2); tag by resource; every operation gets
  `summary`, scope requirement (`x-required-scope`), and at least one example.
  Regenerate via existing `scripts/openapi-gen.ts`; CI check: spec diff must be committed
  (drift gate).
- **Docs UI:** `/developers` route rendering the spec with **Scalar** (MIT, self-hosted,
  no external calls — fits CSP) — try-it console with key auth, generated curl/TS
  snippets. Plus three hand-written MDX guides in the same route group: *Authentication &
  scopes*, *Read standings into a sheet/site*, *Push live scores from your scoreboard*
  (the two real integration jobs seen in intake history).
- **Versioning promise page:** `/developers/changelog` — additive changes announced,
  breaking = new version path. Cheap now, priceless later.
- Public read API (no key) for public dashboards stays as is — document it in the same
  spec under a `public` tag.

## 4. Acceptance sketch

Unit: route→scope map default-denies an unlisted route; pinned key 403s outside its comp;
read key 403s on POST. E2E: create key with `read` → GET ok, POST 403 with actionable
error body. Admin: trial extend reflects in Stripe test clock; downgrade shows freeze
preview; every admin action lands in audit with reason. Docs: `/developers` renders
offline (no CDN), spec diff gate green.

Related: engine/08 (API design), [[v3/03]] ConfirmDialog + consequence-line copy,
[[v3/07]] plan panel interplay (comped Pro downgrades path exists — reuse
`/api/billing/downgrade` logic, don't fork it).
