# PROMPT-12 — Public Open Dashboard

**Read first:** `engine/09-public-dashboard.md` (normative); `engine/06-divisions-and-eligibility.md`
§4.7 (consent — legal requirement); `node_modules/next/dist/docs/` for ISR/caching APIs.
Preamble: PROMPT-00. Depends: PROMPT-11.

## Task
1. Routes per 09 §1 under `apps/web/src/app/(public)/[orgSlug]/…` with reserved-slug
   guard (build-time list + runtime 404). Visibility handling: public/unlisted
   (noindex meta) /private (404 — not 403, don't leak existence).
2. Competition home, division home (Schedule / Standings / Entrants tabs), live match
   page, player card — content per 09 §2. Standings columns driven by the sport module's
   `MetricSpec[]` (label/format/precision) — **zero per-sport table components**; bracket
   + ladder views for KO/stepladder stages; tie-explanation popover from cascade trace
   (competition engine must expose which rule split each tie — add to standings snapshot
   if missing).
3. Live updates: realtime `fixture:{id}` for `realtime`-entitled orgs; 15 s polling
   fallback (reuse `use-tournament-realtime.ts` pattern, renamed).
4. All reads through public views/endpoints only — no auth'd query paths in these pages.
   ISR + `revalidateTag` per 09 §3, tags fired from the same service-layer writes that
   publish realtime.
5. SEO: JSON-LD `SportsEvent` on fixtures, dynamic OG image route (standings snapshot),
   sitemap entries for `public` competitions, `.ics` feeds per division/entrant.
6. QR poster route per competition (existing `qrcode` dep).
7. Entitlement split per 09 §4: platform footer + single-public-competition for
   Community; branding theme fields for Pro (nulled in the view for non-entitled orgs —
   verify server-side).

## Acceptance
- Lighthouse ≥ 90 perf/SEO/a11y on division home with 16 entrants.
- Consent matrix test: person without name consent renders initials everywhere (schedule,
  standings, lineups, player card 404s); DOB never in any payload (assert on API
  responses).
- Dashboard fully functional logged-out, cold cache.
