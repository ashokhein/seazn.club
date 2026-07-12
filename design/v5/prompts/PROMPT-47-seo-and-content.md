# PROMPT-47 — SEO + Content: /[lang] marketing prefix, hreflang, help translation, localized share assets

**Read first:** `v5/00-i18n-strategy.md` §2 phase-2 (routing decision + rationale),
`v5/01-translation-pipeline.md` §6 (help docs); `lib/routes.ts` (central route builder),
`app/sitemap.ts` / robots if present, `content/help/` + `server/help-content.ts` +
`lib/help.ts`, OG consumers (`opengraph-image.tsx` ×3, `ticket.png`, `poster.pdf` —
fonts already embedded by PROMPT-44). Preamble: PROMPT-00. **Depends:** PROMPT-44, 45.

## Task

1. **Marketing `[lang]` prefix** (v5/00 §2 phase 2): `[lang]` segment over the marketing
   group only (home, pricing, scheduling, use-cases, start); `generateStaticParams` for
   the 6 locales; proxy rewrite: unprefixed = en canonical (no redirect), `/fr/pricing`
   etc. serve prefixed; `lib/routes.ts` gains locale-aware marketing builders (console +
   slug routes untouched — assert). Locale switcher on marketing navigates to prefixed
   URL (cookie still set for the rest of the product).
2. **hreflang + sitemap**: `alternates.languages` in marketing `generateMetadata`
   (self-referencing + x-default=en); sitemap emits all locale variants; robots
   unchanged. Canonicals: en = unprefixed.
3. **Help content** (v5/01 §6): `content/help/{locale}/` structure + loader fallback
   chain (locale file → en file + localized "in English" notice); translate top-8 docs
   per locale via markdown-aware pipeline (headings/anchors/frontmatter/code preserved);
   help index + search: per-locale titles, en body index.
4. **Localized share assets**: OG card static strings (tagline
   "Live scores · fixtures · standings", labels) from `metadata` namespace by locale of
   the org; ticket + poster strings likewise; QR/urls unchanged.
5. **Generate translations** for help top-8 + remaining `metadata` keys; ratchet final
   shrink — allowlist empty for public+marketing surfaces.

## Acceptance

- E2E: `/fr/pricing` 200 with fr copy + `<html lang="fr">`; `/pricing` stays en with
  hreflang set listing all 6 (parse head); sitemap contains `/ta/scheduling`; console
  and `/o/...` URLs unaffected (route-builder unit test); switcher on `/es/` home →
  `/hi/` home keeps path.
- Help: ta visitor opens translated doc (Tamil body); untranslated doc shows en body +
  ta notice; anchors intact post-translation (link-check test).
- OG snapshot: shared comp page for a ta-default org renders Tamil tagline, no tofu;
  poster PDF idem.
- Lighthouse SEO pass on `/fr/` home ≥ current en score; `npm test` + `tsc` green;
  update v5/README status — wave complete.
