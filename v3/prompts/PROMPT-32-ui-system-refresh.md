# PROMPT-32 — UI System Refresh: Cards, ConfirmDialog, Tips, Logos, Plan Scrub, Visibility

**Read first:** `v3/03-ui-system-refresh.md` (normative); `v3/01` §2 (route builder for
card links). Preamble: PROMPT-00.

## Task
1. **Card system** (v3/03 §1–2): `<EntityCard>` (glyph, name, status chip, meta line,
   "next" line, progress, 3px division hue, `⋯` menu); status-chip vocabulary component;
   competitions + divisions lists → card grids (1/2/3 col), Live-first sort, list toggle
   (localStorage), invitation empty states.
2. **`<ConfirmDialog>`** (v3/03 §3): promise-based provider, `tone: danger`, `typedName`
   variant; bottom sheet under `sm`; replace all 8 `confirm()` call sites; ESLint ban on
   `window.confirm`/`alert`.
3. **Tips** (v3/03 §4): `<Tip id>` popover + dismissible callout variant;
   `config/tips.ts` registry with the 12 seed tips; "Learn more" links (dead until
   PROMPT-35 — render only when `helpSlug` resolves).
4. **Logos** (v3/03 §5): `teams.logo_url` migration + upload (club-logo pipeline reuse);
   fallback chain team→club→org-monogram→initials in one `<EntityLogo>`; apply placement
   matrix (standings/fixture rows, cards, slideshow matchup, exports row chips).
5. **Business scrub** (v3/03 §6): remove from `plan-badge.tsx`, `settings/page.tsx`,
   `api-keys.tsx` copy; CI grep gate; DB plan key untouched.
6. **Visibility picker** (v3/03 §7): radio-card component (Private / Link only / Public,
   consequence sentences, share-URL + copy on selection); swap into division +
   competition settings; keys/noindex behaviour unchanged.

## Acceptance
- Golden/unit: chip states; logo fallback chain; typedName mismatch blocks confirm.
- E2E: delete-ish action shows modal (no native dialog — assert via dialog handler that
  fires test failure); visibility change to "Link only" surfaces copyable URL and public
  page serves noindex; card click navigates via new routes.
- Regression: ESLint + grep gates fail on reintroduced `confirm(`/"Business" copy.
- `npm test` + `tsc` green; smoke.ts: card grid render + visibility flip on free & pro;
  update v3/README status.
