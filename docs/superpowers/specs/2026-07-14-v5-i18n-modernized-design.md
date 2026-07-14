# v5 i18n — Modernized (cycle 1) — Design Spec

> **Date:** 2026-07-14 · **Branch:** `feat/v5-i18n` · **Migration:** `V281`
> **Supersedes the routing/pipeline decisions in** `design/v5/00-i18n-strategy.md` **and**
> `design/v5/01-translation-pipeline.md` (July-12). Keeps their locale set, DB shape, and
> "thin in-house layer" call; modernizes typing, translation pipeline, QA, and formatting.

## 1. Goal & scope

Take the product from hardcoded English to **six live locales** — `en` (primary/fallback),
`fr`, `es`, `hi`, `ta`, `nl` — with a modernized engine, and prove it end-to-end on two
surface types in this cycle. Follow-on cycles (45/46/47) extend surface coverage using the
same engine unchanged.

**Two axes, kept separate:**

- **Language coverage — all 6, now.** Engine, resolution, DB, fonts (incl. hi/ta Noto),
  pipeline, and switcher support all six from day one. Every string extracted this cycle is
  translated into all six.
- **Surface coverage — a slice, now.** This cycle extracts strings for the **marketing
  group** and **one public league (courtside) surface** only. Console (87 pages), 9 of 10
  emails, and the rest of the public surface stay English until 45/46/47 — no engine change
  needed to extend them later.

### In scope (cycle 1)

1. `lib/i18n` engine — typed dictionaries, `t()`, `plural()`, `getDictionary()`.
2. `resolveLocale()` + `proxy.ts` `Accept-Language` negotiation → `x-seazn-locale`.
3. Marketing `[lang]` URL routing (rewrite-based, unprefixed = en), hreflang + sitemap.
4. `V281`: `users.locale`, `orgs.default_locale`; registration captures resolved locale.
5. Fonts: Noto Sans Devanagari + Tamil in app shell, OG image, and poster PDF.
6. Locale-aware formatting — extend existing `lib/format.ts`.
7. Translation pipeline — incremental Claude tool-use + per-sport glossary + drift check.
8. **Pseudolocale (`en-XA`) gate** — Playwright audit fails CI on hardcoded/overflowing text.
9. Locale switcher — footer (public/marketing) + account settings (console).
10. **Two proof surfaces:** a Tamil-default public league page; localized `/[lang]` marketing.
11. Registration-confirmation email localized (the one email tied to the league proof).

### Out of scope (deferred, binding)

- Console UI string extraction (→ cycle 46).
- 9 of 10 email templates (→ cycle 46).
- Rest of public surface: slideshow, embeds, all shared pages beyond the one proof page
  (→ cycle 45).
- Non-marketing SEO, help-doc translation (→ cycle 47).
- User content translation (org/competition/division names, slugs, help-editor bodies), RTL,
  locale-specific FX, translating the API reference. `slugify()` stays ASCII.
- Native-speaker review of hi/ta — flagged, not gated (see §9).

## 2. Baseline facts (audit 2026-07-14)

- Next.js 16 App Router (Middleware renamed **Proxy**; `proxy.ts` at `apps/web/src`).
- `proxy.ts` already exists (~7.3 KB) carrying CSP/CSRF — negotiation slots in, **no new
  middleware framework**.
- `lib/format.ts` + `lib/day-label.ts` already exist (from timezone PR #95 / `V280`) —
  locale-aware formatting is an **extension**, not net-new.
- `lang="en"` hardcoded at `app/layout.tsx:54`.
- 15 files hardcode `en-GB`/`en-US`/`en-CA`; 13 `Intl.*` call sites.
- 10 email templates in `lib/email-templates/`.
- Latest migration `V280`; next free is `V281`.

## 3. Engine — `lib/i18n`

`apps/web/src/lib/i18n.ts` (server-only core):

- `type Locale = "en"|"fr"|"es"|"hi"|"ta"|"nl"`; `LOCALES`; `DEFAULT_LOCALE = "en"`.
- `PSEUDO_LOCALE = "en-XA"` — dev/CI only. **Never** in `LOCALES`, never offered by the
  switcher, never negotiated in prod. Opt-in via `SEAZN_PSEUDO=1` (or the audit cookie).
- `getDictionary(locale, namespace)` — `import "server-only"`, lazy `import()` per
  `{locale}/{namespace}.json`. Namespaces: `common`, `marketing`, `public`, `console`,
  `emails`, `errors`, `metadata`.
- `t(dict, key, vars?)` — dot-key lookup, `{name}` interpolation, **en fallback** on missing
  key + dev-mode `console.warn`; **never throws in prod**.
- `plural(dict, key, count, vars?)` — key convention `key.one` / `key.other` (+ locale
  extras), selected via `Intl.PluralRules(locale)`.
- `hasLocale(x): x is Locale` — narrowing guard (per Next 16 guide); used to `notFound()` on
  unknown `[lang]` params rather than throw.

**Typing (modernization vs a plain `.d.ts`):** a build step reads the `en` dictionaries and
generates `dictionary-keys.d.ts` giving `t()` fully-typed keys (autocomplete). CI parity
check + the generated union make a **missing or extra key in any non-en locale a build
failure**, not a runtime surprise.

**Client bundle discipline:** server components pass resolved strings as props. Only
interactive-heavy islands (score board, division wizard, switcher) receive an
`<I18nProvider slice={…}>` carrying **only that surface's namespace slice** — whole
dictionaries never reach the client.

## 4. Locale resolution — `resolveLocale()`

Resolved once per request in a server helper. **A `[lang]` path segment (marketing) is
authoritative for that render.** Otherwise the chain:

1. `seazn_locale` cookie (explicit switcher pick; 1y, `SameSite=Lax`).
2. `users.locale` (signed-in).
3. **Public league pages only** (`/o/*`, `/shared/*`, `/slideshow/*`, `/embed/*`): owning
   org's `orgs.default_locale` — a Chennai club's public pages read Tamil for every visitor
   unless the visitor picked otherwise.
4. `Accept-Language` negotiation in `proxy.ts` (`@formatjs/intl-localematcher` +
   `negotiator`, new deps) → request header `x-seazn-locale` consumed by `resolveLocale()`.
5. `en`.

Edge: cookie=`fr` visiting `/es/pricing` → **URL wins** (`es`) for that page; explicit path
= explicit intent. `<html lang>` becomes dynamic in the root layouts.

## 5. Routing

- **Console + public league:** no URL change (cookie + header). 87 slug-routed pages stay
  unprefixed permanently — low SEO value, high migration risk (decision recorded; revisit
  only with SEO evidence).
- **Marketing only:** `app/(marketing)` → `app/[lang]/(marketing)`. `proxy.ts` **rewrites**
  unprefixed marketing paths to `en` (no visible redirect, existing English links unbroken).
  `generateStaticParams` emits all 6 locales (static, cached). hreflang alternates on every
  marketing page + localized sitemap.

## 6. DB — `V281`

```
users.locale        text        null   check (locale in ('en','fr','es','hi','ta','nl'))
orgs.default_locale text  not null default 'en'
                                       check (default_locale in ('en','fr','es','hi','ta','nl'))
```

Public registration form captures the resolved locale into the registration row (recipients
often have no user account). Email builders read that locale.

## 7. Fonts (hi/ta release blocker)

- **App shell:** add `Noto_Sans_Devanagari` + `Noto_Sans_Tamil` via `next/font/google`,
  loaded per-locale in the root layout (locale → font-variable class on `<html>`; Latin
  locales keep Geist/Barlow only — no payload tax).
- **Display face:** Barlow Condensed has no hi/ta glyphs — scoreboard/marketing display
  styles fall back to the Noto face for hi/ta via CSS variable stack (deliberate personality
  compromise, recorded).
- **OG images** (`server/og/card.tsx`): load Noto TTF subsets from `apps/web/assets/fonts/`,
  pass via `ImageResponse` `fonts`, family picked by locale.
- **Poster PDF** (pdfkit): `registerFont` with the same subsets. Without this, hi/ta share
  cards render tofu — release blocker for those locales.

## 8. Formatting

- Extend existing `lib/format.ts`: `fmtDate/fmtTime/fmtRange/fmtNumber` take the resolved
  locale. Add `fmtDuration` (`Intl.DurationFormat`) and `fmtRelative`
  (`Intl.RelativeTimeFormat`) — both 2026 baseline — for match durations and "2h ago".
- `formatMinor()` in `lib/currency.ts` gains a locale param (currency **selection** logic
  unchanged; only display formatting localizes).
- This cycle rewires the hardcoded-locale sites **on the two proof surfaces**; the locale-
  aware helpers land for the remaining ~15 files to adopt in 45/46.
- Timezones unchanged (competition tz stays authoritative for schedule display).
- zod/API errors: server keeps stable `code`s; client maps `code → errors.*` key, falling
  back to server `message`. No server-side translated strings in v1 API responses.

## 9. Translation pipeline — `scripts/i18n`

- `en/*.json` = **source of truth**. Key style `surface.area.slug`; no dynamically-built
  keys (grep-able).
- **Incremental** (modernization vs full batches): a manifest stores the last-translated
  hash per key. `npm run i18n:translate` diffs `en` → translates **only changed/new keys**,
  per locale, via **Claude tool-use** with:
  - a **per-sport glossary** (deuce / let / power-play / tie-break …) enforced for term
    consistency;
  - **do-not-translate spans**: `{var}` placeholders, brand terms, proper nouns.
- **Drift check:** back-translate each new value to en; flag semantic drift for the run log
  (does not block; en fallback is always safe).
- **Translation QA (this cycle):** all 6 ship AI-translated with machine QA only. **hi/ta
  strings are flagged in the manifest for later native-speaker review** — nothing blocks on
  a human; en fallback covers any gap.
- **CI checks:** key parity across all locales (also enforced by generated types), placeholder
  integrity (every `{var}` present in every locale), and the pseudolocale audit (§10).

## 10. Pseudolocale gate — `en-XA` (signature)

The one memorable engineering device: turn "did we miss a string?" from manual grep into an
automated gate.

- Build `en-XA` from `en` at build time: accent every Latin letter, expand length ~30%, wrap
  each value in `⟦…⟧` markers. Placeholders (`{var}`) preserved.
- A Playwright audit (`e2e/i18n-pseudo.spec.ts`) sets locale `en-XA`, walks the two proof
  surfaces, and **fails CI** when:
  - any visible text node lacks `⟦…⟧` markers → a **hardcoded string** (caught automatically,
    no grep);
  - any element overflows/truncates under +30% text → a **layout risk** for hi/ta before they
    ship.
- Runs in the e2e job and is wired into `scripts/smoke.ts`.

## 11. Switcher

- **Public/marketing:** footer control. Writes `seazn_locale` cookie and, on marketing,
  swaps the `[lang]` path; `router.refresh()`.
- **Console:** account settings control. Writes cookie **and** `users.locale` when signed in;
  `router.refresh()`.

## 12. Proof surfaces (acceptance)

**A. Public Tamil league page.** Seed a demo org with `default_locale='ta'`. Its public
league / courtside page — including the scorebug display face and the OG share card — renders
Tamil end-to-end for an anonymous visitor with no cookie. Proves: per-org default locale,
hi/ta fonts (app + OG), RSC zero-bundle dictionaries, formatting locale.

**B. Marketing `/[lang]`.** `/`, `/pricing` (and `/start` headline) localized ×6. `/fr/pricing`,
`/es/pricing`, `/hi/pricing`, `/ta/pricing`, `/nl/pricing`, and en all render real translated
copy with correct fonts; hreflang alternates + sitemap present; OG taglines localized. Proves:
`[lang]` rewrite routing, static params, SEO surface, pseudolocale gate.

## 13. Testing & house rules

- Every change ships a **failing-without-it** regression test (unit for engine/resolution/
  format; e2e for routing/switcher/pseudo; the pseudolocale audit doubles as coverage).
- Extend `scripts/smoke.ts` (pro + free paths) with a locale-switch + Tamil-render step.
- Update `content/help/*` with a locale-switching help page (mandatory closing pass).
- `tsc` + unit green before every push.
- No new v1 API routes expected; if any appear, register in openapi ROUTES.

## 14. Build order (checkpointed)

1. **Engine + types + DB (`V281`) + proxy negotiation + fonts** → *checkpoint: `en` renders
   unchanged, `<html lang>` dynamic, hi/ta fonts load, types compile.*
2. **Formatting extension + pseudolocale build + audit harness** → *checkpoint: `en-XA` gate
   runs (red until surfaces are extracted).*
3. **Marketing `[lang]` routing + extraction + hreflang/sitemap** → proof surface B.
4. **Public Tamil league extraction + per-org locale + OG/PDF fonts + reg-email locale** →
   proof surface A.
5. **Translation pipeline + glossary + CI parity/drift** → all 6 filled, gate green.
6. **Switcher (footer + settings) + smoke + help docs.**

## 15. Open decisions (resolved)

| Decision | Choice | Rationale |
|---|---|---|
| Library | Thin in-house `lib/i18n` | Next 16 guide's own pattern; no runtime ICU engine for 6×~1.2K keys; avoids a second middleware framework in `proxy.ts`. |
| App URL routing | Cookie/header, **no restructure** | 87 slug pages, low SEO value, high risk. |
| Marketing URL routing | `[lang]` rewrite | SEO pays here; unprefixed = en, no redirect churn. |
| Translate engine | Incremental Claude tool-use | Cheaper than full batches; self-healing on key diff; glossary-enforced. |
| Pseudolocale enforcement | Runtime Playwright audit | Catches dynamic + rendered strings a static AST grep misses. |
| hi/ta QA | Ship AI, flag for later native review | Autonomous execution; en fallback keeps risk bounded. |
