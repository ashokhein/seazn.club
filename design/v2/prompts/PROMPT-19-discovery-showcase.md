# PROMPT-19 — Public Discovery & Homepage Showcase

**Read first:** `engine/15-public-discovery.md` (normative); `engine/09-public-dashboard.md`
(consumes its public views); `development/06-marketing-site.md` (existing marketing
structure). Preamble: PROMPT-00. Depends: PROMPT-12 (public dashboard live).

## Task
1. **Schema**: `competitions.discoverable` + `discovery` jsonb + `discovery_blocked`
   (staff flag); `public_discovery_v` view per doc 15 §4 (discoverable ∧ public ∧ not
   blocked ∧ org active ∧ quality floor: ≥1 decided fixture or published schedule);
   opt-in/out recorded as audited competition event.
2. **Settings UI**: "Showcase on seazn.club" toggle with the exact consent copy of doc 15
   §1; hard-coupled to `visibility='public'` (dropping visibility auto-disables
   discoverable, in the same tx); optional city/country/tagline/hero fields
   (`discovery.branding`-gated for tagline/hero).
3. **API**: `GET /api/v1/public/discovery` with sport/country/status filters, cursor
   pagination; Redis 30 s + `s-maxage=60`; zero queries beyond the view.
4. **Marketing surfaces**: home page "Live right now" strip + "Happening this week"
   cards (collapse when empty); `/discover` directory with filters/search; per-sport
   pages `/discover/{sport}` with SEO copy blocks; JSON-LD + sitemap inclusion for
   discoverable competitions only. ISR tag `discovery`, revalidated on toggle and on
   fixture-decided writes of discoverable competitions (cheap: fire tag only when
   competition is discoverable).
5. **Curation**: admin console — featured flag (Pro-eligible only), `discovery_blocked`
   with reason (staff_audit_log); ordering per doc 15 §3.
6. **Entitlements**: seed `discovery.listed` (all), `discovery.featured`,
   `discovery.branding` (Pro) per doc 15 §5.

## Acceptance
- Opt-in flow: public competition toggles on → appears on /discover and home within
  revalidation window; toggle off / visibility drop / staff block → gone after tag
  revalidation (test all three paths).
- Consent-filtered rendering verified: a no-consent minor in a discoverable competition
  never appears by name anywhere on marketing surfaces (reuse PROMPT-12 consent matrix).
- Empty state: fresh install renders home with both sections collapsed, no layout shift.
- Load: discovery endpoint p95 < 50 ms warm (view + cache only).
