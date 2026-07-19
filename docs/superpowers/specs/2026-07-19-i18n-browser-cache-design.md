# i18n browser caching — hashed per-locale JSON — design

**Date:** 2026-07-19 (corrected same day: original draft wrongly claimed all 8
namespaces — including `emails.json` — ship to the browser; loading is
per-namespace and always was. "Layer A" from the draft is void.)
**Status:** Corrected; awaiting user re-confirmation of value before planning.
**Goal:** Stop re-serializing the active namespace dictionary into every
server-rendered full page load; serve dictionaries as immutable,
browser-cached static assets instead.

## Context (verified in code)

- `getDictionary(locale, ns)` (`apps/web/src/lib/i18n.ts:77`) loads ONE
  namespace, merged over en. `DictProvider`
  (`apps/web/src/components/i18n/dict-provider.tsx`) receives that single
  namespace dict; only it crosses the RSC boundary (per the file's own header
  comment). `emails.json` is server-only and never ships.
- Client-shipped namespaces by mount count: `ui` ×30 (console `/o` layout and
  most feature pages — en `ui.json` is 121.7 KB raw, roughly 25–30 KB gzip),
  `marketing` ×18, `public` ×5, `console` ×1.
- Cost today: every FULL page load re-serializes the active namespace dict
  into the RSC payload. Client-side navigation does not re-send it; the spend
  is on full loads (first visit, hard refresh, external links).
- No dict endpoint and no exposed content hash exist.
- Locale resolution (`apps/web/src/lib/resolve-locale.ts:20`): `seazn_locale`
  cookie → `users.locale` → org default → `x-seazn-locale` header → `en`.

## Design — hashed static JSON per (locale, namespace)

1. **Build-time generator** (script wired into the web build): for each locale
   × client-shipped namespace (`ui`, `marketing`, `public`, `console`), write
   the merged dict to `apps/web/public/i18n/<ns>.<locale>.<sha8>.json`
   (sha8 = content hash) plus a generated manifest module mapping
   `(ns, locale) → URL`. Stale hashed files pruned on regeneration.
2. **Server side:** provider mounts pass `locale` + the manifest URL instead
   of the dict object.
3. **Client side:** provider fetches the JSON behind a Suspense boundary
   (module-level promise cache; one fetch per (ns, locale) per session).
   Served with `Cache-Control: public, max-age=31536000, immutable` — safe
   because the hash is in the filename. Repeat full loads hit the browser
   HTTP cache.
4. **SSR unchanged:** server components keep `getDictionary()` and render
   localized HTML; smoke/e2e keep targeting markup (v5 rule holds).

## Honest benefit estimate

Saves ~25–30 KB gzip per console full load (less on marketing/public pages),
plus the serializer/parse CPU for a ~122 KB object. It does NOT speed up
client-side navigation, which never re-sent the dict. Costs: a build step,
manifest plumbing, Suspense in 19+ mounts, and one blocking fetch per deploy
per namespace on first visit. Proceed only if this trade reads as worth it.

## Accepted trade-off

First visit after each deploy: island strings wait on one small fetch
(SSR-rendered text visible immediately). No dual inline-fallback path.

## Testing

- Unit: generator hash stability/change detection; manifest matches emitted
  files; pruning works.
- Regression guard: RSC payload of a console page no longer embeds a known
  `ui` key's translation blob (assert on the fetch URL instead).
- e2e/smoke: unchanged — they target SSR markup.

## Out of scope

- Service worker / offline; localStorage layer.
- Per-page key splitting below namespace granularity.
- Server-only namespaces (`emails`, `errors`, `metadata`, `common` unless
  found client-mounted during implementation).
