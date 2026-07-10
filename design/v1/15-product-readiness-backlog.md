# 15 — Product-Readiness Backlog (Accessibility, Moderation, Growth, Performance, Localization)

## 1. Goal

Capture the remaining product-readiness areas that don't each need a standalone doc yet, but
must not be lost: accessibility, public-content moderation/abuse, growth loops, performance &
load, localization depth, in-app help/feedback, and pricing mechanics. Each section is
implementation-ready enough to promote into its own doc when scheduled.

## 2. Accessibility (WCAG 2.1 AA)

### Why
Public-sector and education buyers (a core segment, doc 01) frequently **require** a11y.
Your slideshow animates and the live UI is dense — both are risk areas.

### Scope
- Semantic landmarks, headings, and labels on all forms (create tournament, score entry,
  settings). The enlarged score inputs already added `aria-label` — extend that everywhere.
- Full keyboard operability: tab order, focus-visible states, escape to close modals
  (`modal.tsx`, `confirm`/`audit` modals), no keyboard traps.
- Color contrast ≥ 4.5:1 (audit the purple/slate palette in `globals.css`).
- **Reduced motion:** respect `prefers-reduced-motion` for the slideshow and any transitions.
- Screen-reader pass on score entry and standings tables (proper `<th>`/scope, captions).
- Live regions for realtime score updates (announce "Match result recorded") (doc 10).

### Gates
- axe-core automated checks in Playwright on key pages as a CI gate (doc 12 §11).
- Manual screen-reader smoke (VoiceOver/NVDA) before Pro GA.

### Acceptance
- No critical/serious axe violations on dashboard, create, live, slideshow, settings.
- Keyboard-only user can run a tournament end-to-end.

## 3. Public content moderation & abuse

### Why
Once tournaments are public + indexable (doc 06) with **user-supplied names and uploaded
images** (doc 11), the product hosts third-party content. That brings spam, profanity,
illegal/abusive imagery, and brand risk.

### Scope
- **Image moderation:** uploaded avatars/logos screened (automated classifier on upload via
  worker, or a managed moderation API) before they appear on public pages; raster-only +
  SVG rejected already (doc 11). Quarantine on suspicion.
- **Text:** optional profanity filter on public-facing names; organizer override for legit
  names; never silently alter private data.
- **Report/takedown:** "Report this page" on public pages → staff queue (doc 13 admin);
  fast **make-private** and **takedown** controls.
- **Rate/abuse limits:** cap public page creation + upload-url minting per org (doc 04).
- **Robots control:** per-tournament public/private + noindex toggle (doc 06).

### Acceptance
- Public images pass moderation before display; report → staff action path exists; org can
  make any page private instantly.

## 4. Growth loops & lifecycle (beyond onboarding email)

### Scope
- **Public-page flywheel (doc 06):** "Powered by Seazn Club" + "Create your own" CTA on free
  public pages; entitlement removes branding on paid.
- **Invites/referrals:** incentivize inviting teammates/other organizers (e.g. extended
  trial or credit) — measure viral coefficient.
- **Share moments:** prompt sharing after first completed round and at champion reveal
  (OG images, doc 06).
- **Expansion nudges:** near plan limits or on gated-feature clicks → contextual upgrade
  (ties to entitlements, doc 05).
- **Win-back & re-engagement:** dormant-org journeys (doc 14).

### Acceptance
- Referral mechanic live + measured; public pages drive measurable signups (attribution,
  doc 06/14).

## 5. Performance & load

### Targets (define + enforce)
- API p95 latency budget (e.g. < 300 ms for reads, < 600 ms for writes excluding email/jobs).
- Live public page TTFB/LCP budget; bracket/standings render budget on large tournaments.
- Realtime update latency < 1 s end-to-end (doc 10).

### Work
- **Caching:** cache-aside (Redis, doc 02) for standings + public pages with explicit
  invalidation on writes; CDN for static + public pages.
- **DB:** connection pooler mandatory (doc 02/07); index hot queries (`loadState`, standings);
  watch N+1 in state assembly.
- **Load testing:** k6/Artillery scenario simulating a **hot tournament** — many spectators on
  the public page + realtime subscribers + an organizer scoring — run nightly in CI (doc 12).
- **Bundle:** keep marketing routes JS-light (doc 06); code-split heavy client components
  (`live-tournament.tsx`, slideshow).

### Acceptance
- Budgets documented and asserted in load tests; hot-tournament scenario meets targets before
  marketing push.

## 6. Localization & internationalization depth

### Scope (beyond string i18n in doc 08)
- Externalize all UI strings; locale routing; translation workflow.
- **Locale-aware** date/time (extend `ClientTime`), numbers, and **currency presentment** for
  pricing (doc 05) — even if billing currency stays single at launch.
- **Time zones** for scheduling (`starts_at`, round/clock minutes) — store UTC, render local;
  critical once events are scheduled across regions.
- RTL support; localized email templates (doc 14).
- Sport/format terminology localization (some sports use locale-specific terms).

### Acceptance
- App renders correctly in a second locale incl. dates/times/timezones; pricing shows
  localized currency formatting.

## 7. In-app help, feedback & changelog

### Scope
- **Help:** searchable help center/docs (doc 06) + contextual help links from complex screens
  (formats, scoring, undo).
- **Feedback widget:** capture bug reports/feature requests in-app → triage queue; link to
  staff console (doc 13).
- **Changelog / "What's new":** in-app + public (doc 06) — retention + SEO.
- **Status:** link to status page (doc 07) from app + marketing.

### Acceptance
- Users can find help, report issues, and see recent changes without leaving the app.

## 8. Pricing mechanics (Stripe-backed, doc 05)

### Scope
- **Coupons/promo codes**, education/nonprofit discounts, annual-upgrade prompts.
- **Tax** (Stripe Tax) + billing address capture (doc 05).
- **Grandfathering** via `org_entitlement_overrides` (doc 03) when plans change.
- Clear proration + downgrade behavior (no data loss; doc 05).

### Acceptance
- Promo codes and at least one discount class supported; tax handled; plan changes don't lose
  data or entitlements unexpectedly.

## 9. Legal & trust surface (consolidation)

Cross-refs doc 04/06 — ensure these exist before public GA:
- Terms of Service, Privacy Policy, DPA, sub-processor list, cookie policy + consent banner.
- Data ownership statement ("your tournament data is yours; export anytime").
- Security/trust page (compliance status, doc 04).

## 10. Branding & naming (pre-launch)
- Confirm product name/trademark availability ("Seazn Club"), domain, logo, OG imagery.
- Consistent brand kit shared between marketing and app (doc 06 §10 — Tailwind + shadcn/ui).

## 11. Prioritization summary

| Area | Priority | Phase | Owning/related doc |
|------|----------|-------|--------------------|
| Accessibility gates | High | 1–2 | 12 (axe), this doc |
| Moderation/abuse | High (before public pages GA) | 2 | 06, 11, 13 |
| Performance budgets + load test | High | 1–2 | 02, 07, 12 |
| Growth loops | Medium | 2 | 06, 14 |
| In-app help/feedback/changelog | Medium | 2 | 06, 13 |
| Pricing mechanics | Medium | 1–2 | 03, 05 |
| Localization depth | Medium | 3–4 | 08, 14 |
| Legal/trust surface | High (before GA) | 1 | 04, 06 |
| Branding/naming | High (pre-launch) | 0–1 | 06 |

## 12. Open questions / decisions
1. Image moderation: managed API vs self-hosted classifier?
2. Are Free public pages indexable (SEO upside) vs noindex-by-default (open in doc 01/06)?
3. Localization timing — defer to Phase 3, or start string externalization earlier to avoid
   retrofitting?
4. Which areas here graduate into their own deep docs (e.g. a dedicated accessibility or
   performance doc) before Phase 2?
