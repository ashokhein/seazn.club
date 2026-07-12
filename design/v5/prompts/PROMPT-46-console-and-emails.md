# PROMPT-46 — Console + Emails + Formatting: app extraction, per-locale email, Intl plumbing

**Read first:** `v5/00-i18n-strategy.md` §1/§3/§5, `v5/01-translation-pipeline.md`;
surfaces: `components/v2/**` (board, division-builder wizard, panels), console pages
`app/o/[orgSlug]/**` (settings/billing/admin), `lib/email-templates/*` + `html/*` +
`compose.ts` (9 builders + funnel), zod messages in `server/api-v1/schemas.ts`, hardcoded
`Intl` locales (~31 files: `"en-GB"` in billing/api-keys/card-stats, `"en-CA"`/`"en-US"`
in device-links, `"en"` in division-builder + `lib/currency.ts:54` `formatMinor`).
Preamble: PROMPT-00. **Depends:** PROMPT-44. May run parallel to PROMPT-45 (disjoint files).

## Task

1. **Console extraction** → `console` namespace: board + panels (conflicts, tray,
   settings, move, history), division wizard (steps, format recommender copy), entrants/
   registration admin, settings/billing/admin pages, api-keys/developers. Interactive
   trees use `<I18nProvider slice>` (bundle: only the surface's slice ships client-side —
   assert via bundle test ≤ +10KB gz per route).
2. **Emails** (v5/00 §3) → `emails` namespace: 9 builders + funnel gain required
   `locale` param; subjects/preheaders/bodies keyed; HTML chrome strings token-filled via
   `compose.ts`; plain-text variants localized. Locale source: recipient user's
   `users.locale` → registration-row locale (add column capture in public registration
   POST) → org default → en. Registration/payment-reminder flows pass it through
   (`server/usecases/registrations.ts`, `fixtures.ts`, `lib/billing.ts`, auth mails).
3. **Errors** (v5/00 §5): client error mapper `errors.*` keyed by envelope `code`
   (+`feature_key` for 402 copy via `feature-copy.ts` — localize that table); promote
   user-facing custom zod messages in `schemas.ts` to codes; server responses stay
   English+code (documented for API consumers).
4. **Formatting** (v5/00 §5): `lib/format.ts` (`fmtDate/fmtTime/fmtRange/fmtNumber`
   taking locale + tz); sweep all hardcoded-locale `Intl` call sites onto it;
   `formatMinor(minor, currency, locale)`; competition-tz semantics unchanged
   (regression: schedule page still renders competition tz, caption localized).
5. **Generate translations** for `console`+`emails`+`errors`; ratchet allowlist shrink.

## Acceptance

- Unit: email builder snapshot per locale (registration confirm in fr + ta — subject,
  body, plain-text; placeholders intact); locale-source chain for a no-account registrant;
  `formatMinor` renders `1 234,56 €` (fr) vs `€ 1.234,56` (nl) vs `₹1,234.56` (hi/inr);
  error mapper falls back to server message on unknown code.
- E2E: hi-locale organiser drives wizard → board → publish entirely in Hindi (Noto
  rendering, no layout break at 390px via pseudo-locale complement); billing page dates
  no longer `en-GB`-forced (assert locale-formatted); registration in es sends es email
  (mailbox capture assert).
- Bundle guard test green; ratchet count shrinks; `npm test` + `tsc` green; update
  v5/README status.
