# v5 — Internationalization (en · fr · es · hi · ta · nl)

> **Status (2026-07-12):** not started. PROMPT-44 ⏳ · PROMPT-45 ⏳ · PROMPT-46 ⏳ ·
> PROMPT-47 ⏳. Branch (planned): `feat/v5-i18n`. Migrations: V-next (`users.locale`,
> `orgs.default_locale`).

## Theme

Take the product from hardcoded English (`lang="en"` in the root layout, ~1,000 inline UI
strings, English-only emails/OG/help) to six locales: **en (primary/fallback), fr, es, hi,
ta, nl**. Audit findings: zero i18n infra today; `Accept-Language` only used to guess
currency; fonts are Latin-only so Hindi/Tamil are hard-blocked in both the app shell and
the OG/poster image pipeline until fonts land.

Strategy in one line: **thin in-house dictionary layer (per the Next 16 guide), server-side
locale resolution without URL restructure, Claude-Batches translation pipeline with en.json
as source of truth, URL prefixes only where SEO pays (marketing).**

## Locale set

| Code | Language | Script | Notes |
|------|----------|--------|-------|
| en | English | Latin | primary, fallback, source of truth |
| fr | French | Latin | |
| es | Spanish | Latin | |
| hi | Hindi | Devanagari | needs Noto Sans Devanagari (app + OG/PDF) |
| ta | Tamil | Tamil | needs Noto Sans Tamil (app + OG/PDF) |
| nl | Dutch | Latin | |

No RTL locale in scope. User content (org/competition/division names, slugs, help-editor
bodies) is never machine-translated.

## Document index

| # | File | Contents | Prompt |
|---|------|----------|--------|
| 00 | `00-i18n-strategy.md` | Normative spec: locale resolution, dictionary system, routing decision, DB, fonts, formatting | 44–47 |
| 01 | `01-translation-pipeline.md` | en.json conventions, Claude Batches machine translation, glossary, review, CI parity + drift checks | 44–47 |

## Prompt index (prompts/)

| Prompt | Delivers | Depends on |
|--------|----------|------------|
| PROMPT-44 | Foundation: `lib/i18n` + dictionaries, proxy negotiation + cookie, `<html lang>`, switcher, locale DB columns, Noto fonts incl. OG/PDF embedding, translate script + CI checks | — |
| PROMPT-45 | Public surface extraction: marketing, public league/courtside/slideshow/embeds, metadata + manifest → 6 dictionaries | PROMPT-44 |
| PROMPT-46 | Console + emails + formatting: console UI extraction, per-locale email templates, zod/API error mapping, kill hardcoded `"en-GB"`/`"en"` Intl calls | PROMPT-44 |
| PROMPT-47 | SEO + content: `/[lang]` prefix for marketing, hreflang/sitemap, help-docs translation strategy, localized OG/poster taglines | PROMPT-44, 45 |

## Build order (canonical)

44 → 45 → 46 → 47. 45 and 46 touch disjoint surfaces and may run in parallel **after 44
lands**; 47 last (needs 45's marketing dictionaries).

## House rules

PROMPT-00 conventions apply. Every change ships a failing-without-it regression test;
`scripts/smoke.ts` extended per feature (pro + free paths); `tsc` + unit green before push.
New v1 routes (none expected this wave) must register in openapi ROUTES.
