# Console theme — "floodlit console" (stadium night after login)

Date: 2026-07-12
Status: approved (autonomous session; user brief: "update the similar theme as well after login")
Branch: `worktree-app-stadium-theme`

## 1. Context and goal

PROMPT-40 (#69) gave marketing the stadium-night identity: night bookends, cream
condensed display type, floodlight lime, matchday-arc structure. Logging in still
lands on the pre-v3 lavender SaaS chrome — white nav, white breadcrumb strip,
generic purple glows. The continuity break is the brief: the console must read as
the same product the marketing site promised, without hurting a data-dense tool
people use all day.

Success criteria:

- A user arriving from the night hero into `/login` and on into the console never
  feels the theme change products.
- Zero readability regression on work surfaces (forms, tables, cards) — the axe
  serious/critical gate on the six key surfaces stays green.
- Zero behavioural change: no route, copy, role, or aria-name changes; every
  existing e2e assertion still holds.

## 2. Direction — "night chrome, daylight pitch"

Rejected:

1. **Full night console** — the marketing spec itself rejected all-dark for reading
   fatigue; the console is forms and tables all day. Also the largest possible
   regression surface.
2. **Light-only refresh** (fonts and headers only) — delivers no night anywhere;
   fails the brief.
3. **Dark sidebar re-IA** — an information-architecture rewrite disguised as a
   theme; breaks nav e2e and mobile patterns for no thematic gain.

Approved: the matchday arc, folded into the app frame. The chrome you look
*through* goes night; the surface you work *on* stays daylight. The auth pages —
the tunnel between the marketing site and the console — are the one full-night
moment, because their content is a single small card.

Three intensities of one system:

| Surface | Treatment |
|---|---|
| Marketing | night → light → night (shipped, PROMPT-40) |
| Auth tunnel (`/login`, magic-link, verify, reset, join) | full night stage, white card |
| Console (`/o/*`, directory, settings, my-matches, …) | night gantry chrome over a warm floodlit-daylight canvas |

## 3. Tokens and type

No new palette. The `--mk-*` vars (night `#150b36`, night-2 `#1d1145`, cream
`#f5f0e8`, lime `#a3e635`, purple `#7c3aed`) become the shared stadium-night
source of truth; console classes are namespaced `.app-*` and consume them.

**Lime discipline (unchanged from PROMPT-40):** lime appears only as — the gantry
hairline, LIVE signals, eyebrow ticks, focus rings on night, the auth submit
button. Never lime text on light. Action buttons on light surfaces stay purple —
`.btn-primary` and every form primitive are untouched.

**Type:** Barlow Condensed (600/700) mounts once at the root layout on
`--font-barlow` (same font files next/font already serves for public + marketing;
new var only). New classes: `.app-display` (condensed, uppercase, tracked) for
page titles and the wordmark; `.app-eyebrow` (lime tick + condensed violet label,
the marketing `.mk-eyebrow` recipe) for top-level page headers.

**Motion: none added.** The marketing site owns the show; the console owns calm.
Only the existing live-chip pulse remains (recoloured).

## 4. The gantry (signature element)

Nav + breadcrumb fuse into one night block — the scoreboard truss you look
through at the pitch:

- **Nav row:** night gradient (night-2 → night). Cream condensed wordmark
  (image logo hidden on night, as marketing's night nav already does; org logo
  images keep rendering — they sit in a lifted chip). Org chip becomes a
  **scorebug**: night-lifted pill, lime pulsing dot, cream org name. Nav links
  (Dashboard / Directory / Settings), help menu, user name, sign-out go cream
  at ~85% opacity, full cream + soft white-8% pill on hover. All aria-labels,
  link names, and `data-tour` hooks unchanged.
- **Breadcrumb row:** night at a lifted tint (white 4%), cream-muted crumbs,
  cream hover; the org-switcher popover becomes a night-2 panel with cream
  items. Same DOM, same roles.
- **The floodlight hairline:** the gantry's bottom edge is a 2px lime line —
  the one place the chrome touches the pitch. This is the element the console
  is remembered by.
- **Focus on night:** gantry-scoped `outline-color: var(--mk-lime)` (10.7:1);
  the global purple focus ring is 2.6:1 on night and stays for light surfaces.

Contrast (WCAG AA): cream/night 15.4:1 · cream-64%/night ≈ 7.9:1 · lime/night
10.7:1 · night/lime 10.7:1. All pass; the axe e2e gate re-verifies.

## 5. Daylight pitch (work surface)

- Body canvas: cool lavender `#faf7ff` + purple blobs → warm `#fdfcf8` with two
  faint violet **floodlight beams** angling in from the top corners (pure CSS
  gradients, ≤5% alpha). Cards/panels/tables/forms untouched — white on warm
  reads as chalk lines on a lit pitch.
- **Page headers:** top-level surfaces (org home, directory, settings,
  my-matches, import, orgs/new) get `.app-eyebrow` + condensed `.page-title`;
  deeper pages (competition, division) get the condensed title only — their
  place is already told by breadcrumbs, and an eyebrow there would be
  decoration. Heading text never changes (e2e names hold; `text-transform`
  does not alter the accessible name).
- **LIVE goes floodlit:** the `live` status chip flips from purple-600/white to
  night bg + lime dot + lime text everywhere (cards, headers, fixture rows) —
  the scorebug moment of the console. `data-chip` and copy unchanged.
- **Empty states:** purple-100 tile + purple icon → night tile + lime icon: an
  unlit stadium waiting for a season.

## 6. Auth tunnel

New tiny server component `NightStage` (night gradient + corner beams + cream
condensed wordmark + tagline + centered children) wraps `/login`,
`/forgot-password`, `/reset-password`, `/magic-link`, `/verify-email`,
`/join/[token]`. The auth cards stay white — a floodlit ticket window; zero
changes inside `AuthForm` and friends beyond the page swapping its shell. The
login submit stays `.btn-primary` inside the white card (purple-on-white), so
form conventions hold.

## 7. Files

**New:** `src/lib/fonts.ts` (shared Barlow export) · `src/components/night-stage.tsx`.

**Changed:** `globals.css` (app floodlit-console section) · root `layout.tsx`
(font var) · `nav.tsx` · `breadcrumbs.tsx` · `help-menu.tsx` · `logout-button.tsx`
(nav-scoped colours) · `ui/status-chip.tsx` (live style row) · org home ·
`directory` · `settings` · `my-matches` · `import` · `orgs/new` · auth tunnel
pages (headers/stage only).

**No changes:** routes, copy keys, aria names, `data-tour`/`data-chip` hooks,
buttons/inputs/tables, public `--ps-*` and marketing `--mk-*` behaviour, DB, API.

## 8. Testing

- Vitest (fail-without-change): `status-chip` live = floodlit classes, others
  untouched; `breadcrumbs` renders night classes + switcher panel classes;
  `night-stage` renders wordmark + children.
- e2e: existing `navigation`, `logout`, `passwordless-login`, `mobile` (axe
  serious/critical on the six key surfaces) must stay green — they are the
  behavioural and contrast contract for this pass.
- Playwright MCP screenshots (desktop + mobile) of login, org home, division,
  schedule board for the self-critique pass.

## 9. Non-goals

Public `--ps-*` pages, marketing pages, slideshow/print surfaces, emails, admin
tree styling beyond what the shared chrome gives it, any IA/behaviour change.
`scripts/smoke.ts` untouched — this pass adds no flow; smoke is API/flow-level.
