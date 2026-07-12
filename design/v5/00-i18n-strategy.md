# v5/00 — i18n strategy (normative spec)

Scope: UI/emails/metadata/OG for en, fr, es, hi, ta, nl. Implemented by PROMPT-44..47.
Baseline facts (audit 2026-07-12): Next.js 16.2.9 App Router; no i18n lib; `lang="en"`
hardcoded (`app/layout.tsx:54`); `Accept-Language` only feeds currency guessing
(`lib/currency.ts:66`); ~900–1,000 React-tree strings; 10 email templates; 31 help docs;
37 metadata blocks; fonts Latin-only; OG/PDF renderers embed no font; no locale column
anywhere.

## §1 Library decision: thin in-house layer

No next-intl / i18next. Rationale: the Next 16 guide's own pattern (server-only
dictionaries + negotiation in `proxy.ts`) covers our needs; our `proxy.ts` already carries
CSP/CSRF logic and a second middleware framework risks conflicts; 6 locales × ~1.2K keys
doesn't justify a runtime ICU engine. Rejected alternative recorded: next-intl (heavier,
own middleware, message-format runtime).

`apps/web/src/lib/i18n.ts` (~100 lines):

- `type Locale = "en"|"fr"|"es"|"hi"|"ta"|"nl"`, `LOCALES`, `DEFAULT_LOCALE = "en"`.
- `getDictionary(locale)` — `import "server-only"`, lazy `import()` per locale namespace.
- `t(dict, key, vars?)` — dot-key lookup, `{name}` interpolation, **en fallback** on
  missing key + dev-mode console.warn (never throws in prod).
- `plural(dict, key, count, vars?)` — key convention `key.one` / `key.other` (+ locale
  extras where needed), selected via `Intl.PluralRules(locale)`.
- Client components receive strings via props from server components, or — for
  interactive-heavy trees (board, wizard) — a `<I18nProvider slice={...}>` carrying only
  that surface's namespace slice (bundle discipline: never ship whole dictionaries to the
  client).

Dictionaries: `apps/web/src/dictionaries/{locale}/{namespace}.json`, namespaces
`common`, `marketing`, `public`, `console`, `emails`, `errors`, `metadata`. Key style
`surface.area.slug` (e.g. `console.board.publish`); no dynamically-built keys (grep-able).
A generated `dictionary-keys.d.ts` from `en` gives typed `t()` keys (build step in 44).

## §2 Locale resolution (no URL restructure in phase 1)

Order, resolved once per request in a server helper `resolveLocale()`:

1. `seazn_locale` cookie (explicit user pick via switcher; 1y, SameSite=Lax)
2. `users.locale` (signed-in)
3. **Public league pages only** (`/o/*`, `/shared/*`, `/slideshow/*`, `/embed/*`): owning
   org's `orgs.default_locale` — a Chennai club's public pages read Tamil for every
   visitor unless the visitor picked otherwise
4. `Accept-Language` negotiation in `proxy.ts` per the Next 16 guide
   (`@formatjs/intl-localematcher` + `negotiator`, new deps) → sets a request header
   `x-seazn-locale` consumed by `resolveLocale()`
5. `en`

`<html lang>` becomes dynamic in the root layouts. Switcher UI: footer (public/marketing)
+ account settings (console); writes cookie (+ `users.locale` when signed in) and
`router.refresh()`.

**Phase 2 (PROMPT-47): URL prefixes for marketing only.** `/{lang}/pricing` etc. via a
`[lang]` segment over the marketing group + proxy rewrite so unprefixed = en (no redirect
churn for existing links); hreflang alternates + localized sitemap. Console and slug
routes (`/o/...`) stay unprefixed permanently — 87 slug-routed pages, low SEO value, high
risk; decision recorded, revisit only with SEO evidence.

## §3 DB + emails

Migration V-next: `users.locale text` (nullable, checked against locale set),
`orgs.default_locale text not null default 'en'`. Registrations: public registration form
captures the resolved locale into the registration row (recipients often have no user
account); email builders gain a required `locale` param — subject/preheader/title/body
strings move to the `emails` namespace; the 9 HTML chrome files get token-driven strings
(footer, "why you got this") via existing `compose.ts` token fill. Fallback en when a
recipient locale is unknown.

## §4 Fonts (hi/ta hard blocker)

- App shell: add `Noto_Sans_Devanagari` + `Noto_Sans_Tamil` via `next/font/google`,
  loaded per-locale in the root layout (locale → font-variable class on `<html>`; Latin
  locales keep Geist/Barlow only — no payload tax).
- Display face: Barlow Condensed has no hi/ta glyphs — scoreboard/marketing display styles
  fall back to the Noto face for hi/ta via CSS variable stack (accepting different
  personality there; recorded as a deliberate compromise).
- OG images (`server/og/card.tsx` — currently `fontFamily:"sans-serif"`, no embedded
  font): load Noto TTF subsets from `apps/web/assets/fonts/` and pass via
  `ImageResponse` `fonts` option, family picked by locale. Poster PDF (pdfkit):
  `registerFont` same files. Without this, hi/ta share cards render tofu — treated as a
  release blocker for those locales.

## §5 Formatting

- New `lib/format.ts`: `fmtDate(locale, tz, opts)`, `fmtTime`, `fmtRange`,
  `fmtNumber` — thin `Intl.*` wrappers taking the resolved locale. Replace the ~31 files
  hardcoding `"en-GB"`/`"en-CA"`/`"en-US"`/`"en"` (board, billing, api-keys, card-stats,
  device-links, division-builder, OG image, client-time).
- `formatMinor()` in `lib/currency.ts` gains a locale param (currency **selection** logic
  unchanged — set price points, cookie, subscription; only display formatting localizes).
- Timezones unchanged (competition tz remains authoritative for schedule display).
- zod/API errors: server keeps stable `code`s (already in the v1 envelope); client maps
  code → `errors.*` dictionary key, falling back to server `message`. Custom zod messages
  in `schemas.ts` become codes where user-facing. No server-side translated strings in v1
  API responses (API consumers get English + codes; documented).

## §6 Out of scope (binding)

User content translation (names, slugs, help-editor bodies), RTL, locale-specific
currency FX (multi-currency set-prices already shipped), translating the API reference,
per-locale PWA screenshots. `slugify()` stays ASCII (existing behavior, recorded).
