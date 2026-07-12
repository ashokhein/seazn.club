# PROMPT-45 — Public Surface Strings: marketing + league pages + metadata → 6 locales

**Read first:** `v5/00-i18n-strategy.md` §1/§2, `v5/01-translation-pipeline.md` §1/§2;
surfaces: `app/page.tsx` (home, AUDIENCES array), `app/pricing/page.tsx` (FAQ + plan
tables — note hardcoded `$39`/`$20` inside description copy: split price out of the
sentence, price stays currency-system-driven), `app/scheduling/page.tsx`, `app/start/*`,
`components/marketing/*`, public league pages `app/o/[orgSlug]/**` + `app/(public)/shared/**`,
`app/slideshow/**`, `app/embed/**`, `public/site.webmanifest`. Preamble: PROMPT-00.
**Depends:** PROMPT-44. May run parallel to PROMPT-46 (disjoint files).

## Task

1. **Marketing extraction** → `marketing` namespace: home, pricing (FAQ arrays, plan
   cards, comparison table), /scheduling, /start funnel + claim, marketing shell/nav/
   footer, use-cases. Copy stays sentence-per-key; audience/FAQ arrays become keyed lists.
2. **Public league + courtside** → `public` namespace: org/comp/division/fixture pages,
   standings/scorebug labels, registration form (field labels/validation copy), shared
   pages, slideshow (TV) status strings, embed widgets. Competition-page rendering locale
   = org `default_locale` chain (44) — verify scorebug density unaffected by longer fr/ta
   strings at 390px (pseudo-locale run).
3. **Metadata + manifest** (v5/00 §2): per-page `generateMetadata` reads dictionary
   (title/description/OG text) via `resolveLocale()`; `site.webmanifest` → dynamic
   `manifest.ts` serving localized name/description (org-PWA idea stays parked).
4. **Generate translations**: run pipeline for fr/es/hi/ta/nl over `marketing`+`public`+
   `metadata`; commit generated files + review-checklist PR notes (v5/01 §3).
5. **Ratchet**: remove extracted files from the hardcoded-string allowlist.

## Acceptance

- E2E: home + pricing in all 6 locales render translated H1/CTA (snapshot per locale);
  fr pricing FAQ expands correctly; ta public competition page shows Tamil UI chrome with
  English org-content untouched; embed widget honors org locale; metadata: `og:title`
  localized on shared comp page (fetch head).
- Pseudo-locale 390px pass on home, pricing, register form, scorebug — no overflow/
  clipped CTAs.
- Unit: parity tests green for new namespaces; allowlist shrank (ratchet asserts count).
- smoke.ts: free path loads es home + registers on es public form; pro path checks ta
  courtside page.
- `npm test` + `tsc` green; update v5/README status.
