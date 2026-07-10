# v3/11 — Gaps & Decisions (self-review of the v3 corpus)

Critical review of docs 01–10 before implementation. Sixteen gaps; each states the gap,
the decision needed, a **recommended default** (implementers follow the default unless the
founder overrides here), and the owning prompt. Gaps 1–3 are design-breaking; 4–7 are
missing foundations; 8–12 real-world blind spots; 13–16 smaller. Where a default changes
an existing doc/prompt, that file carries a matching patch (grep `v3/11` to find them).

---

## A. Design-breaking ambiguities

### 1. Event Pass × Free-org quota semantics (owns: PROMPT-36, doc 07 §3)

Free = 1 active competition. Free org buys a pass for a *second* comp — allowed or not?
Doc 07 never said. Also silent on chargebacks and duplication.

**Decision (default):**
- A passed competition is **exempt from org-level `competitions.active` quota** — the
  pass is a self-contained upgrade; without exemption a free org (the entire target
  market for passes) could never use one. Entitlement resolution: comp-pass context
  satisfies both comp-scoped features *and* excludes that comp from the org active count.
- **Refund/chargeback revokes the pass**: webhook `charge.refunded` / `charge.dispute.created`
  → `competition_passes.revoked_at` → comp re-enters normal quota (freeze machinery
  handles over-quota, same as downgrade).
- **Passes never carry** to duplicated/next-edition comps (that's the annual re-purchase —
  the business model).

### 2. Tax (owns: PROMPT-36, doc 07 §4)

Multi-currency sales (EU/UK/IN/AU) create VAT/GST obligations from sale one; corpus never
mentioned tax. INR recurring is additionally constrained by RBI e-mandate rules.

**Decision (default):** Stripe Tax on all checkouts (`automatic_tax: enabled`, org
billing address = tax location); display **tax-inclusive** in EU/UK/AU/IN, exclusive in
US. **INR launches Event-Pass-only** (one-time payment — no e-mandate problem);
INR subscriptions deferred. Registration entry fees (Stripe Connect) stay the organiser's
tax problem — state that in `/help/billing`.

### 3. Build-order contradiction & migration collisions (owns: README, PROMPT-30/31)

README ordered 32→31→30 while PROMPT-31 declared "Depends: PROMPT-30 (route names)" —
circular. And PROMPT-30 codemods every `<Link>` while 31/32/33 rewrite the same files.

**Decision (default):** PROMPT-31 depends on **32 only** (patterns apply to components;
they survive the later route move untouched). Canonical order: **38 → 32 → 31 → 30 →
33/34 → 36 → 35/37/39**. **Prompts 30–33 must not run in parallel** (same-file churn;
another session works this repo). PROMPT-30 lands as one short-lived branch, merged
same-day; rollback = revert (routes are moves + redirects, no schema beyond slugs).
No feature flags for UI swaps — docs-scale team, revert is the flag.

---

## B. Missing foundations

### 4. i18n layer (owns: PROMPT-32/35/36; new copy everywhere)

v3 adds the product's largest copy surface (tips registry, /help, visibility picker,
marketing, funnel) hardcoded in English — while pt-BR was the highest-frequency intake
ask (Jul3/00). Retrofitting later = full rewrite of every surface v3 just built.

**Decision (default):** all **new** v3 UI copy goes through `lib/messages.ts` — flat
key→string map, English only, no library, no locale routing yet. Tips registry and
visibility picker already centralise; extend the pattern. `/help` MDX stays
English-only (content, not strings). Actual translation = v4 with the i18n cluster.

### 5. Analytics is a hand-wave (owns: PROMPT-36 §5; consumed by doc 10)

Doc 07 says "conversion events into audit path"; doc 10 says "re-rank quarterly against
funnel data". Nothing defines events or produces the data.

**Decision (default):** `product_events` table (id, org_id nullable, anon_id, name,
props jsonb, created_at; 90-day retention) + `track(name, props)` server helper. Seed
event list: `funnel.draft_created`, `funnel.link_clicked`, `funnel.comp_created`,
`gate.hit` (feature_key), `pass.purchased`, `sub.started`, `sub.cancelled`,
`registration.submitted`, `share.clicked` (channel), `embed.loaded`. One
`/admin/metrics` page: weekly counts + funnel conversion. No external vendor.

### 6. No job scheduler (owns: PROMPT-36 funnel; wave-2 lifecycle)

Funnel +24h reminder, draft expiry, pass purge cool-off, lifecycle emails — all delayed
jobs. engine/16 comms was "Inngest-blocked"; v3 reintroduced the need without deciding.

**Decision (default):** **pg-boss** on the existing Postgres (no new vendor), worker in
the same Fly app (separate process group in fly.toml). Wrap in `server/jobs.ts`
(enqueue/schedule + handler registry) so a later Inngest swap is one file. v3 ships only:
funnel reminder, draft expiry. Wave-2 emails build on it.

### 7. Org branding × design system, dark mode (owns: doc 03, PROMPT-39)

Public surfaces (dashboard, OG images, registration, embeds) carry *org* brand; doc 03
never said how org accent coexists with the violet system or chip hues, and dark mode is
unmentioned.

**Decision (default):** console = violet always (org accent never themes the console).
Public surfaces: org accent drives masthead/hero + link accents only; status chips and
division hues stay system-owned (they encode state, not brand). Contrast guard: computed
WCAG check on the org accent; failing accents fall back to violet with a settings-page
notice. **Dark mode = explicit v3 non-goal** (public pages are light-only; slideshow
already dark by design).

---

## C. Real-world blind spots

### 8. Minors' privacy (owns: PROMPT-34, PROMPT-39, doc 03 §7)

Core usage includes U16 divisions. Public dashboards, OG share images (platform-cached),
and `/r/[ref]` expose children's names. Unaddressed — the biggest reputational/legal risk
in the corpus.

**Decision (default):**
- `divisions.youth` flag, auto-set when eligibility declares an under-age bound
  (U-anything), organiser-overridable.
- Youth divisions default **Private**; switching to Link-only/Public shows a
  consent-responsibility interstitial (organiser confirms they hold guardian consent).
- Per-division display option `player_name_display: full | first_initial` (youth default
  `first_initial`) applied on all public surfaces, exports excluded (organiser-side).
- OG/share images for youth divisions render **team/division names only, never player
  names**.
- Registration v2 ships a guardian-consent field preset (checkbox + guardian name)
  auto-added to youth-division forms.

### 9. Reserved org slugs (owns: PROMPT-30)

`/o/[orgSlug]` had no reserved-word list.

**Decision (default):** reserve `admin, api, app, billing, dashboard, developers, discover,
docs, embed, help, join, legal, login, new, o, onboarding, pricing, settings, shared,
slideshow, start, static, support, www` + all existing top-level route segments; enforced
at org create/rename (validator + DB check constraint); migration audits existing slugs.

### 10. Schedule-board concurrent editing (owns: PROMPT-33)

Scoring has seq-conflict 409s; the board didn't. Two admins drag the same slot →
last-write-wins silently.

**Decision (default):** schedule writes carry the division `edit_watermark` (exists —
Jul3/03); stale watermark → 409 → client refetches board and toasts "Schedule changed by
someone else — board refreshed". No realtime presence in v3.

### 11. Accessibility bar (owns: every UI prompt; test in 31/33)

Scattered mentions (44px, aria-label), no standard, no keyboard path for board DnD, no
live-region announcements.

**Decision (default):** acceptance bar = **WCAG 2.1 AA** on all new/rebuilt surfaces.
Specifics: tap-to-assign is keyboard-operable (fixture and slot focusable, Enter to pick/
place — one mechanism serves touch + keyboard); score updates announce via `aria-live=
"polite"` on the summary; ConfirmDialog focus-trap already specced; axe-core smoke in the
Playwright mobile project (fail on serious/critical).

### 12. Public pages missing from mobile gate (owns: PROMPT-31 §6)

Doc 02 audited console only.

**Decision (default):** add `/shared/*` (dashboard, standings, schedule), registration,
`/r/[ref]`, `/help`, pricing, home to the viewport suite (no-horizontal-scroll + render
smoke). Slideshow exempt (fixed-viewport by design).

---

## D. Smaller gaps

### 13. `/start` funnel vs `/onboarding` — two creation paths (owns: PROMPT-36 §5)
**Default:** funnel wizard is a skin over the same use-cases `/onboarding` calls
(`createOrgForUser`, comp/division create); `/onboarding` detects a pending draft and
short-circuits into it. One creation path in code, two entrances.

### 14. Help-content ownership (owns: PROMPT-35)
**Default:** founder owns prose; every feature PR touching UX must update its `/help`
article (PR checklist line, like the smoke.ts rule); screenshots regenerate via
`help-shots.ts` in CI weekly. Stale-doc gate: registry-vs-content test already specced
for formats — extend to feature areas.

### 15. Performance budgets (owns: PROMPT-31/33/39 acceptance)
**Default:** public dashboard + registration LCP < 2.5s on Fast-3G emulation; OG render
< 500ms warm; board initial payload < 250KB JSON for 5 divisions × 60 fixtures (paginate
by day if over); card-grid logos lazy + sized. Asserted in the Playwright suite where
cheap (LCP via CDP metric), spot-checked otherwise.

### 16. Console-wide search (deferred)
Cards improve browsing, not finding (>20 comps). **Default: defer to v4** — command
palette (⌘K: comps, divisions, entrants, help) as its own small design; not in v3 scope.

---

## Decision log

All 16 defaults stand unless overridden by editing this file. Patched to match:
`README.md` (order, doc 11 row), `PROMPT-30` (reserved slugs, isolation note),
`PROMPT-31` (deps fix, public routes, axe), `PROMPT-33` (watermark 409, keyboard,
payload), `PROMPT-34` (youth consent + name display), `PROMPT-36` (quota exemption, tax,
INR, analytics, jobs, funnel-reuse), `PROMPT-39` (youth OG rule, contrast guard, OG perf),
docs `03 §7`, `05 §4`, `07 §3–4` (inline notes).
