# Marketing + Auth UX Audit

Viewports: desktop 1440x900, mobile 390x844. Server: localhost:3000, logged out.
Pages covered: home (`/`), `/login`, `/login?tab=signup`, `/pricing`. Screenshots in `screenshots/`.

---

### [high] Floating help/chat FAB overlaps content on every marketing page, both viewports
**What I saw:** The bottom-left circular "N" FAB (help/chat launcher) is fixed-position with
no collision-awareness of page content underneath it:
- Desktop `/pricing` (`m-pricing-desktop.png`): sits directly on top of the left edge of the
  "Community" pricing card / the back-arrow button.
- Mobile `/pricing` (`m-pricing-mobile-top.png`): covers part of the "League, groups +
  knockout & swiss formats" checklist line on the Community card.
- Mobile `/` (`m-home-mobile-full.png`): sits over the hero illustration area, right at the
  edge of the "Setup →" form.
- Mobile `/login`, `/login?tab=signup` (`m-login-desktop.png` shows desktop version, same FAB
  position): sits in the bottom-left corner, clipping into empty space here but confirms the
  FAB is present pre-login too, not just in-console.

This matches a "high" finding already logged in `02-console-org.md` for the same FAB overlapping
console content — this is a systemic, page-independent bug, not console-specific.
**Fix prompt:** Find the FAB's fixed-position component (likely a shared layout-level chat/help
widget, e.g. `apps/web/src/components/**/HelpFab*` or similar — same component used in both
marketing and console layouts). Either give it a scroll-aware/viewport-aware offset that avoids
overlapping card/CTA content (e.g. increase `bottom` on pages with cards ending near the
viewport edge, or make it collapse to a smaller tap target that hugs the very corner outside
the content column's max-width), or move it to bottom-right so it doesn't collide with primary
CTAs and pricing cards, which are left/center-aligned on this site.

### [medium] Mobile nav drops all primary marketing links — no hamburger menu
**What I saw:** At 390px width, the header nav (`m-home-mobile-top.png` / snapshot) only
renders "Log in" and "Start free" — the desktop links (Formats, Scheduling, Pricing, Use cases)
disappear entirely with no hamburger/menu button to reveal them. The only way to reach
`/formats`, `/scheduling`, `/use-cases/*` on mobile is scrolling all the way to the footer.
**Fix prompt:** Add a mobile menu (hamburger icon → slide-down/drawer nav) that surfaces
Formats/Scheduling/Pricing/Use cases on small viewports, in the marketing header component
(likely `apps/web/src/app/(marketing)/**/Header*` or a shared `SiteHeader` component). At
minimum, don't silently drop navigation — a first-time mobile visitor has no path to the
feature-explainer pages short of the footer.

### [low] Full-page Playwright screenshot misses scroll-reveal animated sections (informational, not a real bug)
**What I saw:** A `fullPage: true` screenshot of `/` captured "The Draw", "Matchday tools" and
"Pick your season" sections as blank/empty space, even though the accessibility snapshot shows
full content there. Manually scrolling to the same position and screenshotting the viewport
(`m-home-draw-scrolled.png`) shows the content renders correctly. This is a Playwright
full-page-capture limitation with IntersectionObserver-based reveal animations, not a real user-facing
bug — confirmed by real scroll. Noting only so it isn't mistaken for a rendering defect in
future automated screenshot diffs; no fix needed unless the site wants full-page screenshots to
be reliable for future automated visual regression (in which case scroll-reveal could fall back
to "already visible" for `prefers-reduced-motion` or bots).

### [high] `/start` funnel step 3 — raw i18n key "legal.notice.body" leaks onto the page, right before the email field
**What I saw:** On the final step of the no-account `/start` funnel (name → format → email), the
clickwrap legal notice below the email field renders the literal text `legal.notice.body`
instead of "By continuing, you agree to our Terms of Service and Privacy Policy." — a broken
i18n key visible in a production conversion path, right where a first-time visitor is about to
hand over their email. See `screenshots/01-start-step3.png`.
**Root cause (confirmed by reading the code, not guessed):** `LegalNotice`
(`apps/web/src/components/legal-notice.tsx`) calls `useMsg()` expecting the full shared `ui`
catalog (its own comment says so: "Reads the `ui` catalog via useMsg"). But
`apps/web/src/app/[lang]/(marketing)/start/page.tsx:56` wraps it in
`<DictProvider dict={dict} locale={lang}>` where `dict = await getDictionary(lang, "marketing")`
— the **marketing-namespace** dictionary (`dictionaries/en/marketing.json`), which contains zero
`legal.notice.*` keys (verified: `grep -c "legal.notice" dictionaries/en/marketing.json` → 0).
Because a `DictProvider` IS present (just scoped to the wrong namespace), `useMsg()` uses that
narrow `dict` instead of falling back to the full `uiEn` catalog it would use with no provider at
all — so the lookup misses and `i18n-runtime.ts`'s `t()` returns the raw key as its last-resort
fallback (`apps/web/src/lib/i18n-runtime.ts:34`, `return key;`).
**Fix prompt:** `legal.notice.*` lives in the shared `ui` catalog (`dictionaries/en/ui.json`) but
`LegalNotice` is used from a page whose `DictProvider` only carries the `marketing` namespace.
Either (a) merge the `ui` namespace's `legal.notice.*` keys into `marketing.json` (and its
fr/es/nl siblings) so every namespace that renders `LegalNotice` carries them, or (b) change
`start/page.tsx` to pass a merged dict (`{ ...marketingDict, ...(await getDictionary(lang,
"ui"))}`) into its `DictProvider`, or (c) have `LegalNotice` read from a dedicated always-loaded
mini-catalog instead of the general `ui` one. Confirmed this is isolated to `/start`: the other
three pages rendering `LegalNotice` via `AuthForm` (`/login`, `/join/[token]`, `/checkin/[token]`)
all correctly pass the full `ui` dict into their `DictProvider` (`dict={ui}`) and render the
notice correctly — `/start` is the one place that passes a namespace-scoped dict instead.

### [note, verified OK] Login/signup page has no visible tab distinction
**What I saw:** `/login` and `/login?tab=signup` render the identical form (Google button +
email magic-link field, no password field). This is consistent with the existing project
gotcha ("login UI has no password field, it's magic-link/Google only") — not a bug, the same
form serves both entry points by design, and the copy ("New here? Entering your email creates
your account.") already explains this. No fix needed.

### [medium] `/discover` and `/live` — dozens of E2E/test-seed records leak onto the public discover feed
**What I saw:** `/discover` lists 34+ cards, the large majority named `Discoverfest mrXXXXXXX`
or `Showcase Cup XXXXXX` with orgs like "My organization" / "Disc Org 67a8f4f5" — clearly
automated E2E test fixtures, not real clubs. See `screenshots/01-discover-desktop.png`. `/live`
shows the same pattern at smaller scale — 3 of 5 "live now" cards are labelled "TEST001". This
is publicly reachable, logged out, with no filtering. Also: `/discover` has no pagination for 34+
cards — one very long scroll with no "load more"/page control.
**Fix prompt:** If this reproduces on staging/production (not just this dev DB, which is full of
seeded E2E fixtures), add an `is_test`/`seed`-style flag to filter these out of the public
`/discover` and `/live` queries, or ensure E2E runs clean up their org/competition rows after the
suite finishes rather than leaving them live. Separately, once real orgs push `/discover` past
~20-30 cards, add pagination or infinite scroll — confirm with the team whether this is expected
to matter yet given current real-org volume.

### [high] `/start` funnel step 3 — raw i18n key "legal.notice.body" leaks onto the page, right before the email field
**What I saw:** On the final step of the no-account `/start` funnel (name → format → email), the
clickwrap legal notice below the email field renders the literal text `legal.notice.body`
instead of "By continuing, you agree to our Terms of Service and Privacy Policy." — a broken
i18n key visible in a production conversion path, right where a first-time visitor is about to
hand over their email. Reproduces on both desktop (`screenshots/01-start-step3.png`) and mobile
(`screenshots/01-start-step3-mobile.png`).
**Root cause (confirmed by reading the code, not guessed):** `LegalNotice`
(`apps/web/src/components/legal-notice.tsx`) calls `useMsg()` expecting the full shared `ui`
catalog (its own comment says so: "Reads the `ui` catalog via useMsg"). But
`apps/web/src/app/[lang]/(marketing)/start/page.tsx:56` wraps it in
`<DictProvider dict={dict} locale={lang}>` where `dict = await getDictionary(lang, "marketing")`
— the **marketing-namespace** dictionary (`dictionaries/en/marketing.json`), which contains zero
`legal.notice.*` keys (verified: `grep -c "legal.notice" dictionaries/en/marketing.json` → 0).
Because a `DictProvider` IS present (just scoped to the wrong namespace), `useMsg()` uses that
narrow `dict` instead of falling back to the full `uiEn` catalog it would use with no provider at
all — so the lookup misses and `i18n-runtime.ts`'s `t()` returns the raw key as its last-resort
fallback (`apps/web/src/lib/i18n-runtime.ts:34`, `return key;`).
**Fix prompt:** `legal.notice.*` lives in the shared `ui` catalog (`dictionaries/en/ui.json`) but
`LegalNotice` is used from a page whose `DictProvider` only carries the `marketing` namespace.
Either (a) merge the `ui` namespace's `legal.notice.*` keys into `marketing.json` (and its
fr/es/nl siblings) so every namespace that renders `LegalNotice` carries them, or (b) change
`start/page.tsx` to pass a merged dict (`{ ...marketingDict, ...(await getDictionary(lang,
"ui"))}`) into its `DictProvider`, or (c) have `LegalNotice` read from a dedicated always-loaded
mini-catalog instead of the general `ui` one. Confirmed this is isolated to `/start`: the other
three pages rendering `LegalNotice` via `AuthForm` (`/login`, `/join/[token]`, `/checkin/[token]`)
all correctly pass the full `ui` dict into their `DictProvider` (`dict={ui}`) and render the
notice correctly — `/start` is the one place that passes a namespace-scoped dict instead.

### [OK] `/formats`, `/scheduling` (incl. interactive demo), `/use-cases/*`, `/help`, `/developers/reference` (Scalar API docs), `/developers/guides`, `/developers/changelog`, all 5 `/legal/*` pages, cookie-settings modal
All loaded correctly, fully in English, no console errors beyond a harmless dev-only
report-only-CSP warning. The `/scheduling` drag-and-place demo (tap a fixture, tap a court) works
correctly and updates its own caption text. The cookie-settings modal correctly reproduces the
FAB-overlap issue already flagged (banner sits right above the FAB) — not logged again here,
see the cross-cutting note in `README.md`.

## Not reached this pass
`/pricing` FAQ accordion interaction, `/start` funnel's actual email submission (magic-link
creation from an anonymous funnel), free-tier equivalents of any page above (all checked
logged-in-as-Pro or logged-out).

## Summary
- Checked: home, login, signup, pricing, formats, scheduling (+ interactive demo), use-cases x3,
  discover, live, help, developers x3, legal x5, cookie-settings modal, start funnel (all 3
  steps, desktop + mobile)
- Severity counts: 2 high (FAB overlap systemic; broken i18n key on `/start`), 2 medium (mobile
  nav gap; test-data leak on discover/live), 1 low (informational, not a real bug), 2
  verified-OK notes
- Top priority: **(1)** the `/start` i18n key leak — precisely diagnosed, cheap namespace-merge
  fix, sits in a conversion-critical path, **(2)** FAB overlap fix — cheap, high-visibility,
  affects every page site-wide, **(3)** mobile nav — affects discoverability of core marketing
  pages for mobile-first visitors
