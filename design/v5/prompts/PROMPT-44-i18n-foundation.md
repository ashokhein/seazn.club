# PROMPT-44 — i18n Foundation: dictionary layer, locale resolution, fonts, pipeline + CI

**Read first:** `v5/00-i18n-strategy.md` (normative — §1 library, §2 resolution, §3 DB,
§4 fonts), `v5/01-translation-pipeline.md` (§2 script, §4 CI guards);
`node_modules/next/dist/docs/01-app/02-guides/internationalization.md` (this repo's Next
version — proxy negotiation + dictionaries pattern), `apps/web/src/proxy.ts` (existing
CSP/CSRF — extend, don't replace), `app/layout.tsx` (hardcoded `lang="en"`, fonts),
`server/og/card.tsx` (no embedded font). Preamble: PROMPT-00. **Depends:** none.

## Task

1. **`lib/i18n.ts`** (v5/00 §1): `Locale`/`LOCALES`/`DEFAULT_LOCALE`, server-only
   `getDictionary(locale, namespace)`, `t()` with `{var}` interpolation + en fallback +
   dev warn, `plural()` via `Intl.PluralRules`, client `<I18nProvider slice>` +
   `useT()`. Dictionaries scaffold `src/dictionaries/{locale}/{common,…}.json` — seed
   `common` (nav, actions, empty/error states) + move root-layout metadata strings.
   Typed keys: build step generating `dictionary-keys.d.ts` from en.
2. **Resolution** (v5/00 §2): `resolveLocale()` server helper implementing the 5-step
   chain; `proxy.ts` gains `Accept-Language` negotiation (`@formatjs/intl-localematcher`
   + `negotiator`) setting `x-seazn-locale` — CSP/CSRF behavior byte-identical (regression
   test); `seazn_locale` cookie; dynamic `<html lang>` in root + public layouts; locale
   switcher component (footer variant + account-settings variant) writing cookie +
   `users.locale`.
3. **Migration V-next** (v5/00 §3): `users.locale text` (check in locale set),
   `orgs.default_locale text not null default 'en'`; org settings UI field; expose on
   settings API route schemas.
4. **Fonts** (v5/00 §4): `Noto_Sans_Devanagari` + `Noto_Sans_Tamil` via `next/font`
   per-locale in root layout (CSS variable stack so Latin locales pay zero bytes); Barlow
   display stack falls back to Noto for hi/ta; vendor TTF subsets into
   `apps/web/assets/fonts/`; `ImageResponse` OG renderer (`server/og/card.tsx`) +
   pdfkit poster get locale-selected embedded fonts (tofu = blocker).
5. **Pipeline + CI** (v5/01): `scripts/translate-dictionaries.ts` (Batches API, glossary
   file, hash-incremental), `scripts/i18n-glossary.json`, vitest guards — key parity,
   placeholder parity, drift, hardcoded-string ratchet with allowlist; pseudo-locale
   `en-XA` dev switch.
6. **Env/docs**: `ANTHROPIC_API_KEY` already added by PROMPT-41 — reference it; document
   the pipeline commands in `design/v5/README` status + repo docs.

## Acceptance

- Unit: resolution chain (cookie > user > org-default-on-public-routes > header > en) —
  table-driven; `t()` fallback + interpolation + plural; parity/drift/placeholder CI
  tests fail on seeded bad fixture and pass on real dictionaries; proxy CSP/CSRF
  regression test green.
- E2E: `Accept-Language: fr` visitor sees `<html lang="fr">` + fr common strings on home;
  switcher to ta persists cookie across reload and swaps to Noto Tamil font (assert
  computed font-family); signed-in switch writes `users.locale`; org with
  `default_locale='ta'` serves ta on its public page to a fresh visitor.
- OG: snapshot test renders card with Tamil org name — no tofu (compare glyph bounding
  boxes or golden image); poster PDF contains embedded Noto font (parse font table).
- smoke.ts: pro + free paths assert locale switcher present and fr round-trip.
- `npm test` + `tsc` green; update v5/README status.
