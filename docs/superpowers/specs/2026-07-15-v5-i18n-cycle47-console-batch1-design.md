# v5 i18n — cycle 47: console feature pages (batch 1) + per-registrant email locale

**Date:** 2026-07-15
**Branch:** `worktree-v5-i18n-cycle47` (off `origin/main` @ 8665560, which includes cycle 46 #102)
**Prior art:** [cycle 1 #100], [cycle 46 #102] — engine, marketing `[lang]`, per-org public locale, email dict-param pattern, console *chrome* (Nav + islands). Design: `2026-07-14-v5-i18n-modernized-design.md`.

## Goal

Extend localization (en/fr/es/nl) from the console *chrome* to the first batch of authed console *feature pages*, and localize registrant-facing emails per recipient. This is batch 1 of the ~71-page console follow-on; it establishes the scalable per-page pattern (client `DictProvider` + per-domain namespaces) that later cycles repeat for the remaining areas (admin, developers, o/, discover, people, players, import, …).

Out of scope this cycle: admin, developers, `o/[orgSlug]`, discover, people, players, import, onboarding, checkin, claim, join, directory, formats, scheduling, orgs, clubs, live, slideshow; public league pages (spec 45); legal (never machine-translated); help (English-canonical); logged-out auth pages; `/games/*` (chess-quest play hub — explicitly excluded). hi/ta locales remain deferred.

## Deliverable A — console feature pages (batch 1)

### Pages (14)

- **`dashboard`** ns → `dashboard/page.tsx`
- **`competitions`** ns (the competition→division→fixture→score management hierarchy) →
  `competitions/new`, `competitions/[id]`, `competitions/[id]/settings`, `competitions/[id]/schedule`, `competitions/[id]/divisions/new`, `divisions/[id]`, `divisions/[id]/schedule`, `divisions/[id]/registrations`, `fixtures/[id]`, `score/[token]`
- **`settings`** ns → `settings`, `settings/payments`, `settings/billing`

### Namespaces (per-domain)

Introduce 3 new namespaces: `dashboard`, `competitions`, `settings`.

- Add each to the `Namespace` union in `lib/i18n-constants.ts`.
- Add loaders (`() => import(...)`) for en/fr/es/nl in `lib/i18n.ts`.
- Author `en/*.json`; fr/es/nl produced by the translate pipeline.
- Truly shared strings (fixture/registration status enums, common nouns like Entrant/Round/Division) go to the existing **`common`** namespace, not duplicated per namespace.
- Rationale: per-domain namespaces keep each JSON reviewable and small enough for the translate chunker, and a page loads only the namespaces it renders. This is the template every later batch reuses (next cycle adds `admin.json`, `developers.json`, …).

**Drift guard (regression test):** a new unit test asserts, for every `Namespace` in the union: (1) a loader exists for every `Locale`, and (2) an `en/<ns>.json` file exists on disk. Prevents a future batch from adding a namespace to the type but forgetting a loader/file (mirrors the help slug↔registry test).

### Server pages

Same proven pattern as chrome:

```ts
const locale = await resolveLocale();
const dict = await getDictionary(locale, "<ns>");
// server-rendered strings: t(dict, "key", vars)
```

`resolveLocale()` order is unchanged (cookie → user.locale → header → en). These pages already opt into dynamic rendering (auth), so calling it is free.

### Client islands — `DictProvider` + `useT()`

The batch is form-heavy (competition/division wizards, entrant tables, registration console, score pad). Threading per-string props (the chrome pattern) does not scale here. Introduce a small client i18n context:

- **`components/i18n/dict-provider.tsx`** (`"use client"`): `<DictProvider dict={Dict} locale={Locale}>` stores the resolved **single-locale** dict in React context.
- **`useT()`** hook returns a `t(key, vars)` bound to the provided dict + a `useLocale()` for `plural`/format needs. Client-side `t`/`plural` reuse the pure lookup/interpolate logic — factor the pure parts of `lib/i18n.ts` (`lookup`, `interpolate`, and a pure `plural`) into a client-safe module (e.g. `lib/i18n-runtime.ts`) that both the server `t()` and the client hook import. The server-only `getDictionary`/loaders stay in `lib/i18n.ts`.
- Server pages wrap their island subtree once: `<DictProvider dict={dict} locale={locale}>…</DictProvider>`. Only the **active** locale's dict crosses the RSC boundary (a plain serializable object) — no multi-locale bundle bloat, no `server-only` import in client code.
- Islands with a single string can still take a plain prop; the provider is for the form-heavy majority.

### What "localize a page" means (per page)

1. Extract every user-visible hardcoded string (labels, headings, buttons, placeholders, empty states, aria-labels, toasts) into the page's namespace.
2. Server strings via `t(dict, …)`; client-island strings via `useT()` under a `DictProvider`.
3. Dynamic/enumerated values (statuses, sport names) map to `common` keys.
4. Leave user-authored data (org/competition/division names, entrant names) as-is.

## Deliverable B — per-registrant email locale

### Migration V282 (`db/migration/deltas/V282__registrations_locale.sql`)

Modeled on V281:

```sql
alter table registrations add column if not exists locale text;
alter table registrations drop constraint if exists registrations_locale_valid;
alter table registrations add constraint registrations_locale_valid
  check (locale is null or locale in ('en','fr','es','nl'));
```

Nullable — existing rows stay null and fall back (below).

### Capture

At the registration insert (`server/usecases/registrations.ts:818`), store the registrant's resolved locale (`await resolveLocale()` — their `seazn_locale` cookie / Accept-Language). API-only registrations without a cookie store null.

### Resolution + threading

Effective send locale = **`toLocale(reg.locale) ?? org.default_locale ?? 'en'`**. Since `toLocale(null)` already returns `'en'`, add a small helper that prefers the org default when the row locale is null, e.g.:

```ts
function registrantLocale(regLocale: string | null, orgDefault: string): Locale {
  return regLocale != null && hasLocale(regLocale) ? regLocale : toLocale(orgDefault);
}
```

Thread the effective locale into the registrant-facing senders (all already accept an optional `locale`, default `en` — no signature changes):

- `sendRegistrationEmail`
- `sendPaymentReminderEmail`
- `sendRegistrationPromotedEmail`
- `sendRefundIssuedEmail`
- `sendDisputeAlertEmail`
- `sendDisputeLostEmail`

Also fix the dispute-evidence receipt reconstruction (`registrations.ts:2076`) to reconstruct in the registrant's locale instead of the hardcoded `getDictionary("en", "emails")`, so replayed evidence matches what was sent.

Organiser-facing notifications (to the org owner) are out of scope — they follow the owner's `users.locale` and are a separate follow-on.

## Translations, tests, verification

- **Author en**, then run the Claude translate pipeline (`claude-opus-4-8`, `messages` + `json_schema` output, chunked ≤30 keys — the grammar-limit fix from cycle 46) for fr/es/nl on the 3 new namespaces + any new `common` keys. Run with the real key via `node --env-file=<main-repo>/apps/web/.env.local`.
- **Regression tests (one per change that fails without it):**
  - namespace drift guard (loaders + disk per `Namespace`);
  - key parity across en/fr/es/nl (`i18n:check`) includes the new namespaces;
  - `DictProvider`/`useT()` unit test (renders an island, asserts localized + pseudolocale `⟦⟧` wrap);
  - a couple of batch pages get a pseudolocale/localized render assertion;
  - DB test: registration insert captures `resolveLocale()`; `registrantLocale()` fallback unit test (null → org default → en);
  - email-builder locale test extended to the registrant senders + evidence reconstruction.
- **Smoke:** extend `scripts/smoke.ts` (pro + free paths) to touch a localized feature page and a registrant email in a non-en locale.
- **Help:** update `content/help/sharing/languages.md` (add a "Console" section; note registrant emails follow the registrant's language / org default). Keep `lib/help.ts` slug registry in sync (test enforces it).
- **Gates:** `tsc` 0, unit + smoke green, `i18n:check` parity green, then live-verify fr end-to-end on the dev server via node fetch (MCP browser may be locked; curl absent).

## Setup / ops notes

- This worktree has **no `.env.local`** — add one pointing at local `:5432` (`seazn` db) for DB-backed vitest + dev server (both `.env.local` files point local per project memory).
- Apply V282 to the local dev DB (`db:apply` = Flyway migrate) before running DB tests.
- Next free migration is **V282** (V281 = i18n locale columns).
- Turbopack in a worktree needs a real `npm install` (no symlinked node_modules) — this worktree already has deps from cycle 46.
- Killing the dev server mid-typegen corrupts `.next/dev/types` → phantom tsc errors; `rm -rf apps/web/.next` fixes.

## File-level change map

| Area | Files |
| --- | --- |
| Namespaces/type | `lib/i18n-constants.ts` (union), `lib/i18n.ts` (loaders) |
| Client runtime | `lib/i18n-runtime.ts` (new, pure lookup/interpolate/plural), `components/i18n/dict-provider.tsx` (new) |
| Dictionaries | `dictionaries/{en,fr,es,nl}/{dashboard,competitions,settings}.json` (new); `common.json` (additions) |
| Pages | the 14 listed pages + their client islands |
| Emails | `db/migration/deltas/V282__registrations_locale.sql` (new); `server/usecases/registrations.ts` (capture + thread + evidence); any other registrant send call sites |
| Tests | namespace-drift, dict-provider, page render, registration-locale DB, registrantLocale fallback, email-builder locale; `scripts/smoke.ts` |
| Docs | `content/help/sharing/languages.md`, `lib/help.ts` (if slug touched) |

## Success criteria

- The 14 batch pages render fully localized in fr/es/nl (fallback en for any gap), verified live in fr.
- `en-XA` pseudolocale audit shows no hardcoded strings on the batch pages' islands.
- A registrant who set fr receives registration/payment/refund/dispute emails in French; a null-locale registrant of a fr-default org gets French; otherwise en.
- All gates green (tsc, unit, smoke, parity). Migration V282 applies cleanly.
