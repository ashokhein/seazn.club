# v5 i18n (Modernized) — Cycle 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the modernized i18n engine for all six locales (en·fr·es·hi·ta·nl), proven end-to-end on two surfaces: a Tamil-default public league page and localized `/[lang]` marketing.

**Architecture:** Thin in-house `lib/i18n` (Next 16's own server-only dictionary pattern) with build-time typed keys; locale resolved in `proxy.ts` + a `resolveLocale()` helper; marketing gets a `[lang]` URL segment via rewrite while console/public stay cookie/header-driven; hi/ta unlocked by Noto fonts across app + OG + PDF; translations produced by an incremental Claude `messages.parse()` pipeline; an `en-XA` pseudolocale + Playwright audit gates hardcoded strings in CI.

**Tech Stack:** Next.js 16 (App Router, Proxy), TypeScript, `@anthropic-ai/sdk` (`claude-opus-4-8`, structured outputs), `@formatjs/intl-localematcher` + `negotiator`, `next/font/google` (Noto Sans Devanagari/Tamil), Flyway (`V281`), Vitest, Playwright.

## Global Constraints

- **Read the Next 16 guide before touching a file** (`node_modules/next/dist/docs/`). Middleware is **Proxy** (`apps/web/src/proxy.ts`); i18n = `app/[lang]` + server-only `getDictionary` + `hasLocale`→`notFound()` + `generateStaticParams`.
- **Locale set (exact):** `en` (default/fallback), `fr`, `es`, `hi`, `ta`, `nl`. Plus dev/CI-only `en-XA` — never in `LOCALES`, never negotiated, never in the switcher.
- **Package manager is npm** (`package-lock.json`; scripts run via `npm run`). Tests: `npm run test --workspace apps/web` (Vitest), e2e via Playwright (`apps/web/e2e/*.spec.ts`).
- **Every task ships a failing-without-it regression test.** `tsc` + unit green before any push. Extend `scripts/smoke.ts` (pro + free). Update `content/help/*` in the same cycle.
- **AI translations, machine-QA only** this cycle; flag hi/ta for later native review; **en fallback** on any missing key.
- **Claude usage:** model `claude-opus-4-8`; use `client.messages.parse()` with `output_config.format`; **no `temperature`/`top_p`/`budget_tokens`** (400 on Opus 4.8). No new v1 API routes expected (else register in openapi ROUTES).
- **Do not overturn v5's correct calls:** in-house layer (not next-intl), no `[lang]` on console/slug routes, per-org public default locale.

## File Structure

**New**
- `apps/web/src/lib/i18n.ts` — core: `Locale`, `LOCALES`, `DEFAULT_LOCALE`, `PSEUDO_LOCALE`, `getDictionary`, `t`, `plural`, `hasLocale`.
- `apps/web/src/lib/resolve-locale.ts` — `resolveLocale()` (server) reading `x-seazn-locale` / cookie / user / org.
- `apps/web/src/lib/i18n-negotiate.ts` — pure `negotiateLocale(acceptLanguage)` (proxy-safe, no server-only imports).
- `apps/web/src/lib/pseudo.ts` — `toPseudo(value)` transform + `buildPseudoDictionary(dict)`.
- `apps/web/src/dictionaries/{en,fr,es,hi,ta,nl}/{common,marketing,public,emails,errors,metadata}.json` — dictionaries (`en` authored; others generated).
- `apps/web/src/dictionary-keys.d.ts` — generated typed keys (git-ignored; built in Task 3).
- `apps/web/src/components/i18n/locale-switcher.tsx` — footer + settings switcher.
- `apps/web/src/components/i18n/i18n-provider.tsx` — client slice provider for interactive islands.
- `apps/web/src/app/[lang]/(marketing)/…` — marketing pages moved under `[lang]`.
- `apps/web/assets/fonts/NotoSansDevanagari-Regular.ttf`, `NotoSansTamil-Regular.ttf` — OG/PDF subsets.
- `scripts/i18n/translate.ts`, `scripts/i18n/check-parity.ts`, `scripts/i18n/gen-keys.ts`, `scripts/i18n/glossary.json`, `scripts/i18n/manifest.json`.
- `apps/web/e2e/i18n-pseudo.spec.ts`, `apps/web/e2e/i18n-marketing.spec.ts`, `apps/web/e2e/i18n-tamil-league.spec.ts`.
- `db/migration/deltas/V281__i18n_locale_columns.sql`.

**Modified**
- `apps/web/src/proxy.ts` — locale negotiation + `x-seazn-locale` header + marketing rewrite.
- `apps/web/src/app/layout.tsx` — dynamic `<html lang>` + per-locale font class.
- `apps/web/src/lib/fonts.ts` — add Noto Devanagari/Tamil + `fontClassFor(locale)`.
- `apps/web/src/lib/format.ts` — thread `locale`; add `fmtDuration`, `fmtRelative`.
- `apps/web/src/lib/currency.ts` — `formatMinor(minor, currency, locale)`.
- `apps/web/src/server/og/card.tsx` + poster PDF route — per-locale Noto embed.
- `apps/web/src/lib/email-templates/registration.ts` — `locale` param.
- `scripts/smoke.ts` — locale-switch + Tamil-render step.
- `content/help/*` — locale-switching help page.
- `package.json` — `i18n:translate`, `i18n:check`, `i18n:gen-keys` scripts + new deps.

---

## Task 1: i18n engine core (`lib/i18n.ts`)

**Files:**
- Create: `apps/web/src/lib/i18n.ts`
- Create: `apps/web/src/dictionaries/en/common.json`
- Test: `apps/web/src/lib/__tests__/i18n.test.ts`

**Interfaces:**
- Produces: `type Locale = "en"|"fr"|"es"|"hi"|"ta"|"nl"`; `LOCALES: readonly Locale[]`; `DEFAULT_LOCALE: "en"`; `PSEUDO_LOCALE = "en-XA"`; `hasLocale(x: string): x is Locale`; `t(dict, key: string, vars?: Record<string,string|number>): string`; `plural(dict, key, count, vars?): string`; `getDictionary(locale: Locale, ns: Namespace): Promise<Dict>`. `type Dict = Record<string, unknown>`; `type Namespace = "common"|"marketing"|"public"|"emails"|"errors"|"metadata"`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/__tests__/i18n.test.ts
import { describe, it, expect } from "vitest";
import { t, plural, hasLocale, LOCALES, DEFAULT_LOCALE } from "@/lib/i18n";

const dict = {
  greeting: "Hi {name}",
  "items.one": "{count} item",
  "items.other": "{count} items",
  nested: { deep: "Deep value" },
};

describe("i18n core", () => {
  it("interpolates vars", () => {
    expect(t(dict, "greeting", { name: "Sam" })).toBe("Hi Sam");
  });
  it("resolves dot keys", () => {
    expect(t(dict, "nested.deep")).toBe("Deep value");
  });
  it("returns the key on a miss (never throws)", () => {
    expect(t(dict, "does.not.exist")).toBe("does.not.exist");
  });
  it("pluralizes via Intl.PluralRules", () => {
    expect(plural(dict, "items", 1, "en")).toBe("1 item");
    expect(plural(dict, "items", 3, "en")).toBe("3 items");
  });
  it("hasLocale narrows the set and rejects the pseudolocale", () => {
    expect(hasLocale("ta")).toBe(true);
    expect(hasLocale("en-XA")).toBe(false);
    expect(hasLocale("de")).toBe(false);
  });
  it("exports the six-locale set with en default", () => {
    expect(LOCALES).toEqual(["en", "fr", "es", "hi", "ta", "nl"]);
    expect(DEFAULT_LOCALE).toBe("en");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace apps/web -- i18n.test`
Expected: FAIL — `Cannot find module '@/lib/i18n'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/web/src/lib/i18n.ts
import "server-only";

export const LOCALES = ["en", "fr", "es", "hi", "ta", "nl"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const PSEUDO_LOCALE = "en-XA" as const;

export type Namespace =
  | "common" | "marketing" | "public" | "emails" | "errors" | "metadata";
export type Dict = Record<string, unknown>;

export function hasLocale(x: string): x is Locale {
  return (LOCALES as readonly string[]).includes(x);
}

function lookup(dict: Dict, key: string): unknown {
  return key.split(".").reduce<unknown>(
    (acc, part) => (acc && typeof acc === "object" ? (acc as Dict)[part] : undefined),
    dict,
  );
}

function interpolate(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

export function t(dict: Dict, key: string, vars?: Record<string, string | number>): string {
  const val = lookup(dict, key);
  if (typeof val === "string") return interpolate(val, vars);
  if (process.env.NODE_ENV !== "production") console.warn(`[i18n] missing key: ${key}`);
  return key; // never throws in prod; caller falls back to en dict at load time
}

export function plural(
  dict: Dict, key: string, count: number, locale: Locale,
  vars?: Record<string, string | number>,
): string {
  const cat = new Intl.PluralRules(locale).select(count);
  const chosen = lookup(dict, `${key}.${cat}`) ?? lookup(dict, `${key}.other`);
  const s = typeof chosen === "string" ? chosen : key;
  return interpolate(s, { count, ...vars });
}

// Namespaces are statically enumerated so the bundler can see every import().
const loaders: Record<Locale, Record<Namespace, () => Promise<{ default: Dict }>>> = {
  en: {
    common: () => import("@/dictionaries/en/common.json"),
    marketing: () => import("@/dictionaries/en/marketing.json"),
    public: () => import("@/dictionaries/en/public.json"),
    emails: () => import("@/dictionaries/en/emails.json"),
    errors: () => import("@/dictionaries/en/errors.json"),
    metadata: () => import("@/dictionaries/en/metadata.json"),
  },
  // fr/es/hi/ta/nl mirror en — generated by Task 4's gen-keys/translate.
} as never;

export async function getDictionary(locale: Locale, ns: Namespace): Promise<Dict> {
  const loc = loaders[locale] ? locale : DEFAULT_LOCALE;
  const en = (await loaders[DEFAULT_LOCALE][ns]()).default;
  if (loc === DEFAULT_LOCALE) return en;
  const other = (await loaders[loc][ns]()).default;
  return { ...en, ...other }; // en fallback for any key absent in the locale
}
```

Create `apps/web/src/dictionaries/en/common.json` with `{ "app.name": "Seazn Club" }` so the module resolves.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace apps/web -- i18n.test`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/i18n.ts apps/web/src/lib/__tests__/i18n.test.ts apps/web/src/dictionaries/en/common.json
git commit -m "feat(i18n): thin in-house engine — typed locales, t(), plural(), en-fallback getDictionary"
```

---

## Task 2: locale DB columns (`V281`)

**Files:**
- Create: `db/migration/deltas/V281__i18n_locale_columns.sql`
- Test: `apps/web/src/server/__tests__/locale-columns.test.ts` (DB-backed, uses the ephemeral `:54329` Postgres recipe)

**Interfaces:**
- Produces: `users.locale text NULL` (checked ∈ set), `orgs.default_locale text NOT NULL DEFAULT 'en'` (checked ∈ set).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/server/__tests__/locale-columns.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { getTestClient } from "@/server/__tests__/helpers/test-db"; // existing helper

describe("V281 locale columns", () => {
  let sql: Awaited<ReturnType<typeof getTestClient>>;
  beforeAll(async () => { sql = await getTestClient(); });

  it("orgs.default_locale defaults to en", async () => {
    const [row] = await sql`SELECT column_default FROM information_schema.columns
      WHERE table_schema='seazn_club' AND table_name='orgs' AND column_name='default_locale'`;
    expect(String(row.column_default)).toContain("en");
  });
  it("rejects an out-of-set locale", async () => {
    await expect(
      sql`UPDATE seazn_club.orgs SET default_locale='de' WHERE id=(SELECT id FROM seazn_club.orgs LIMIT 1)`
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace apps/web -- locale-columns`
Expected: FAIL — column `default_locale` does not exist.

- [ ] **Step 3: Write the migration**

```sql
-- db/migration/deltas/V281__i18n_locale_columns.sql
-- v5/00 §3: per-user + per-org locale. Values constrained to the shipped set.
ALTER TABLE seazn_club.users
  ADD COLUMN locale text NULL
  CHECK (locale IS NULL OR locale IN ('en','fr','es','hi','ta','nl'));

ALTER TABLE seazn_club.orgs
  ADD COLUMN default_locale text NOT NULL DEFAULT 'en'
  CHECK (default_locale IN ('en','fr','es','hi','ta','nl'));
```

- [ ] **Step 4: Apply + run test to verify it passes**

Run: `npm run db:apply` (Flyway migrate against the local dev DB), then `npm run test --workspace apps/web -- locale-columns`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add db/migration/deltas/V281__i18n_locale_columns.sql apps/web/src/server/__tests__/locale-columns.test.ts
git commit -m "feat(i18n): V281 users.locale + orgs.default_locale (checked, en default)"
```

---

## Task 3: typed keys codegen + parity check

**Files:**
- Create: `scripts/i18n/gen-keys.ts`
- Create: `scripts/i18n/check-parity.ts`
- Modify: `package.json` (scripts `i18n:gen-keys`, `i18n:check`)
- Modify: `.gitignore` (add `apps/web/src/dictionary-keys.d.ts`)
- Test: `scripts/i18n/__tests__/check-parity.test.ts`

**Interfaces:**
- Consumes: `en/*.json` from Task 1.
- Produces: `checkParity(dir): { locale: Locale; missing: string[]; extra: string[] }[]` (empty arrays = green); `gen-keys` writes `dictionary-keys.d.ts` narrowing `t()`'s `key` to the union of `en` keys.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/i18n/__tests__/check-parity.test.ts
import { describe, it, expect } from "vitest";
import { flattenKeys, diffKeys } from "../check-parity";

describe("parity", () => {
  it("flattens nested keys with dot paths", () => {
    expect(flattenKeys({ a: { b: "x" }, c: "y" }).sort()).toEqual(["a.b", "c"]);
  });
  it("reports missing and extra keys against en", () => {
    const { missing, extra } = diffKeys(["a", "b"], ["a", "z"]);
    expect(missing).toEqual(["b"]); // present in en, absent in locale
    expect(extra).toEqual(["z"]);   // present in locale, absent in en
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace apps/web -- check-parity` (or the root vitest that covers `scripts/`)
Expected: FAIL — `Cannot find module '../check-parity'`.

- [ ] **Step 3: Write `check-parity.ts` (+ `gen-keys.ts`)**

```ts
// scripts/i18n/check-parity.ts
export function flattenKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === "object" && !Array.isArray(v)
      ? flattenKeys(v as Record<string, unknown>, path)
      : [path];
  });
}
export function diffKeys(enKeys: string[], locKeys: string[]) {
  const enSet = new Set(enKeys), locSet = new Set(locKeys);
  return {
    missing: enKeys.filter((k) => !locSet.has(k)),
    extra: locKeys.filter((k) => !enSet.has(k)),
  };
}
// main(): read en/*.json + each locale, print a table, process.exit(1) on any diff.
```

`gen-keys.ts`: read all `en/*.json`, flatten, and emit `dictionary-keys.d.ts` declaring `type DictionaryKey = "app.name" | …;` then augment `t()`'s signature (accept `DictionaryKey | (string & {})` so authored keys autocomplete while dynamic paths still typecheck). Wire `package.json`:

```json
"i18n:gen-keys": "node --experimental-strip-types scripts/i18n/gen-keys.ts",
"i18n:check": "node --experimental-strip-types scripts/i18n/check-parity.ts"
```

- [ ] **Step 4: Run test + parity to verify**

Run: `npm run test --workspace apps/web -- check-parity` → PASS.
Run: `npm run i18n:gen-keys && npm run i18n:check` → exits 0 (only `en` present so far, trivially parity-green).

- [ ] **Step 5: Commit**

```bash
git add scripts/i18n/gen-keys.ts scripts/i18n/check-parity.ts scripts/i18n/__tests__ package.json .gitignore
git commit -m "feat(i18n): typed-key codegen + CI parity check (build fails on missing/extra keys)"
```

---

## Task 4: proxy negotiation + resolveLocale + dynamic `<html lang>`

**Files:**
- Create: `apps/web/src/lib/i18n-negotiate.ts`
- Create: `apps/web/src/lib/resolve-locale.ts`
- Modify: `apps/web/src/proxy.ts` (set `x-seazn-locale`)
- Modify: `apps/web/src/app/layout.tsx` (dynamic `lang`)
- Test: `apps/web/src/lib/__tests__/i18n-negotiate.test.ts`
- Deps: `npm i @formatjs/intl-localematcher negotiator && npm i -D @types/negotiator` (workspace `apps/web`)

**Interfaces:**
- Produces: `negotiateLocale(acceptLanguage: string | null): Locale` (pure, proxy-safe — no `server-only`); `resolveLocale(opts?: { orgDefault?: Locale }): Promise<Locale>` (reads `headers()`/`cookies()`; order: cookie → user → orgDefault → `x-seazn-locale` → en). Proxy sets request header `x-seazn-locale`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/__tests__/i18n-negotiate.test.ts
import { describe, it, expect } from "vitest";
import { negotiateLocale } from "@/lib/i18n-negotiate";

describe("negotiateLocale", () => {
  it("matches the best supported locale", () => {
    expect(negotiateLocale("fr-FR,fr;q=0.9,en;q=0.8")).toBe("fr");
    expect(negotiateLocale("ta-IN,ta;q=0.9")).toBe("ta");
  });
  it("falls back to en for unsupported / empty", () => {
    expect(negotiateLocale("de-DE,de;q=0.9")).toBe("en");
    expect(negotiateLocale(null)).toBe("en");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace apps/web -- i18n-negotiate`
Expected: FAIL — module not found.

- [ ] **Step 3: Write negotiation + resolver, wire proxy + layout**

```ts
// apps/web/src/lib/i18n-negotiate.ts  (pure — safe in proxy.ts)
import { match } from "@formatjs/intl-localematcher";
import Negotiator from "negotiator";
import { LOCALES, DEFAULT_LOCALE, type Locale } from "@/lib/i18n-constants";

export function negotiateLocale(acceptLanguage: string | null): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const langs = new Negotiator({ headers: { "accept-language": acceptLanguage } }).languages();
  try {
    return match(langs, LOCALES as readonly string[], DEFAULT_LOCALE) as Locale;
  } catch {
    return DEFAULT_LOCALE;
  }
}
```

> Extract `LOCALES`/`DEFAULT_LOCALE`/`Locale`/`hasLocale` into `lib/i18n-constants.ts` (no `server-only`) and re-export them from `lib/i18n.ts`, so `proxy.ts` (edge/runtime) can import them without pulling `server-only`.

In `proxy.ts`, inside the page-request branch (after the `requestHeaders` are built, mirroring the existing `gamesHostRewrite` seam), compute and stamp the locale:

```ts
import { negotiateLocale } from "@/lib/i18n-negotiate";
// ...
const cookieLocale = request.cookies.get("seazn_locale")?.value;
const negotiated = cookieLocale && hasLocale(cookieLocale)
  ? (cookieLocale as Locale)
  : negotiateLocale(request.headers.get("accept-language"));
requestHeaders.set("x-seazn-locale", negotiated);
```

`resolve-locale.ts`:

```ts
// apps/web/src/lib/resolve-locale.ts
import "server-only";
import { cookies, headers } from "next/headers";
import { DEFAULT_LOCALE, hasLocale, type Locale } from "@/lib/i18n";
import { getSessionUser } from "@/server/auth"; // existing

export async function resolveLocale(opts?: { orgDefault?: Locale }): Promise<Locale> {
  const c = (await cookies()).get("seazn_locale")?.value;
  if (c && hasLocale(c)) return c;
  const user = await getSessionUser().catch(() => null);
  if (user?.locale && hasLocale(user.locale)) return user.locale;
  if (opts?.orgDefault) return opts.orgDefault;
  const h = (await headers()).get("x-seazn-locale");
  return h && hasLocale(h) ? h : DEFAULT_LOCALE;
}
```

In `app/layout.tsx`, replace `lang="en"` with the resolved locale + font class (font class helper lands in Task 5; use `resolveLocale()` now):

```tsx
const locale = await resolveLocale();
return (
  <html lang={locale} className={`${geistSans.variable} ${geistMono.variable} ${barlowCondensed.variable} h-full antialiased`}>
```

(Make `RootLayout` `async`.)

- [ ] **Step 4: Run test + typecheck**

Run: `npm run test --workspace apps/web -- i18n-negotiate` → PASS.
Run: `npm run -w apps/web typecheck` (or `tsc --noEmit`) → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/i18n-negotiate.ts apps/web/src/lib/i18n-constants.ts apps/web/src/lib/resolve-locale.ts apps/web/src/proxy.ts apps/web/src/app/layout.tsx apps/web/src/lib/__tests__/i18n-negotiate.test.ts apps/web/package.json
git commit -m "feat(i18n): Accept-Language negotiation in proxy + resolveLocale() + dynamic <html lang>"
```

---

## Task 5: Noto fonts (app shell + font class helper)

**Files:**
- Modify: `apps/web/src/lib/fonts.ts` (add Noto Devanagari/Tamil + `fontClassFor`)
- Modify: `apps/web/src/app/layout.tsx` (apply `fontClassFor(locale)`)
- Modify: `apps/web/src/app/globals.css` (display-face fallback stack for hi/ta)
- Test: `apps/web/src/lib/__tests__/fonts.test.ts`

**Interfaces:**
- Produces: `fontClassFor(locale: Locale): string` — returns the Noto variable class for `hi`/`ta`, `""` for Latin locales (no payload tax).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/__tests__/fonts.test.ts
import { describe, it, expect, vi } from "vitest";
vi.mock("next/font/google", () => ({
  Barlow_Condensed: () => ({ variable: "--font-barlow" }),
  Noto_Sans_Devanagari: () => ({ variable: "--font-noto-deva" }),
  Noto_Sans_Tamil: () => ({ variable: "--font-noto-tamil" }),
}));
import { fontClassFor } from "@/lib/fonts";

describe("fontClassFor", () => {
  it("adds a Devanagari class for hi and Tamil for ta", () => {
    expect(fontClassFor("hi")).toContain("--font-noto-deva");
    expect(fontClassFor("ta")).toContain("--font-noto-tamil");
  });
  it("adds nothing for Latin locales", () => {
    expect(fontClassFor("fr")).toBe("");
    expect(fontClassFor("en")).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace apps/web -- fonts.test`
Expected: FAIL — `fontClassFor` is not exported.

- [ ] **Step 3: Extend `fonts.ts`**

```ts
// apps/web/src/lib/fonts.ts (additions)
import { Noto_Sans_Devanagari, Noto_Sans_Tamil } from "next/font/google";
import type { Locale } from "@/lib/i18n-constants";

export const notoDevanagari = Noto_Sans_Devanagari({
  weight: ["400", "600", "700"], subsets: ["devanagari"], variable: "--font-noto-deva",
});
export const notoTamil = Noto_Sans_Tamil({
  weight: ["400", "600", "700"], subsets: ["tamil"], variable: "--font-noto-tamil",
});

export function fontClassFor(locale: Locale): string {
  if (locale === "hi") return notoDevanagari.variable;
  if (locale === "ta") return notoTamil.variable;
  return "";
}
```

In `app/layout.tsx`, append `${fontClassFor(locale)}` to the `<html>` className. In `globals.css`, extend the display-face stack so hi/ta fall back off Barlow:

```css
:root { --display-stack: var(--font-barlow), var(--font-noto-deva), var(--font-noto-tamil), sans-serif; }
```

- [ ] **Step 4: Run test + typecheck**

Run: `npm run test --workspace apps/web -- fonts.test` → PASS. `tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/fonts.ts apps/web/src/app/layout.tsx apps/web/src/app/globals.css apps/web/src/lib/__tests__/fonts.test.ts
git commit -m "feat(i18n): Noto Devanagari/Tamil in the app shell via per-locale font class"
```

---

## Task 6: locale-aware formatting (`lib/format.ts` + `currency.ts`)

**Files:**
- Modify: `apps/web/src/lib/format.ts` (thread `locale`; add `fmtDuration`, `fmtRelative`)
- Modify: `apps/web/src/lib/currency.ts` (`formatMinor(minor, currency, locale?)`)
- Test: `apps/web/src/lib/__tests__/format-locale.test.ts`

**Interfaces:**
- Consumes: `Locale` from Task 1.
- Produces: `fmtNumber(locale, n, opts?)`, `fmtDuration(locale, seconds)`, `fmtRelative(locale, value, unit)`; `formatMinor(minor, currency, locale?)` (defaults `en-GB`, back-compatible with existing 2-arg calls).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/__tests__/format-locale.test.ts
import { describe, it, expect } from "vitest";
import { fmtNumber, fmtDuration } from "@/lib/format";
import { formatMinor } from "@/lib/currency";

describe("locale-aware formatting", () => {
  it("groups numbers per locale", () => {
    expect(fmtNumber("fr", 1234567)).toBe("1 234 567"); // fr narrow-nbsp grouping
    expect(fmtNumber("en", 1234567)).toBe("1,234,567");
  });
  it("formats a match duration", () => {
    expect(fmtDuration("en", 3900)).toMatch(/1\s?hr?.*5\s?min/i);
  });
  it("formatMinor stays back-compatible (2-arg) and localizes when given a locale", () => {
    expect(formatMinor(1500, "GBP")).toContain("15");
    expect(formatMinor(1500, "EUR", "fr")).toMatch(/15/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace apps/web -- format-locale`
Expected: FAIL — `fmtNumber`/`fmtDuration` not exported; `formatMinor` ignores a 3rd arg.

- [ ] **Step 3: Implement**

Thread an optional `locale` through the `fmt` helper (default the existing `"en-GB"` so current callers are untouched) and add:

```ts
// apps/web/src/lib/format.ts (additions)
export function fmtNumber(locale: string, n: number, opts: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(locale, opts).format(n);
}
export function fmtDuration(locale: string, seconds: number): string {
  const h = Math.floor(seconds / 3600), m = Math.round((seconds % 3600) / 60);
  // Intl.DurationFormat is 2026 baseline.
  return new Intl.DurationFormat(locale, { style: "narrow" }).format({ hours: h, minutes: m });
}
export function fmtRelative(locale: string, value: number, unit: Intl.RelativeTimeFormatUnit): string {
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(value, unit);
}
```

```ts
// apps/web/src/lib/currency.ts
export function formatMinor(amountMinor: number, currency: Currency, locale = "en-GB"): string {
  const amount = amountMinor / 100;
  const whole = Number.isInteger(amount);
  return new Intl.NumberFormat(locale, {
    style: "currency", currency: currency.toUpperCase(),
    minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2,
  }).format(amount);
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `npm run test --workspace apps/web -- format-locale` → PASS. `tsc --noEmit` clean (if `Intl.DurationFormat` isn't in the TS lib, add a minimal ambient decl in `apps/web/src/types/intl-duration.d.ts`).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/format.ts apps/web/src/lib/currency.ts apps/web/src/lib/__tests__/format-locale.test.ts apps/web/src/types/intl-duration.d.ts
git commit -m "feat(i18n): locale-aware fmtNumber/fmtDuration/fmtRelative + formatMinor(locale)"
```

---

## Task 7: pseudolocale build + Playwright audit harness

**Files:**
- Create: `apps/web/src/lib/pseudo.ts`
- Create: `apps/web/e2e/i18n-pseudo.spec.ts`
- Modify: `apps/web/src/lib/i18n.ts` (serve `en-XA` = pseudo-of-`en` when `SEAZN_PSEUDO=1`)
- Test: `apps/web/src/lib/__tests__/pseudo.test.ts`

**Interfaces:**
- Produces: `toPseudo(s: string): string` (accents + ~30% expansion + `⟦…⟧`, `{var}` preserved); `buildPseudoDictionary(dict: Dict): Dict`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/__tests__/pseudo.test.ts
import { describe, it, expect } from "vitest";
import { toPseudo } from "@/lib/pseudo";

describe("toPseudo", () => {
  it("wraps in markers and accents letters", () => {
    const out = toPseudo("Publish");
    expect(out.startsWith("⟦")).toBe(true);
    expect(out.endsWith("⟧")).toBe(true);
    expect(out).not.toContain("Publish"); // letters were accented
  });
  it("preserves {var} placeholders verbatim", () => {
    expect(toPseudo("Hi {name}")).toContain("{name}");
  });
  it("expands length by roughly 30%", () => {
    const out = toPseudo("A short label here");
    expect(out.length).toBeGreaterThan("A short label here".length * 1.25);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace apps/web -- pseudo.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `pseudo.ts` and wire `en-XA`**

```ts
// apps/web/src/lib/pseudo.ts
const MAP: Record<string, string> = { a:"á",e:"é",i:"í",o:"ó",u:"ú",A:"Á",E:"É",I:"Í",O:"Ó",U:"Ú",n:"ñ",c:"ç",s:"š" };
export function toPseudo(s: string): string {
  const parts = s.split(/(\{\w+\})/); // keep {var} spans intact
  const body = parts.map((p) => (/^\{\w+\}$/.test(p) ? p
    : p.replace(/[a-zA-Z]/g, (ch) => MAP[ch] ?? ch))).join("");
  const pad = "~".repeat(Math.ceil(s.replace(/\{\w+\}/g, "").length * 0.3));
  return `⟦${body}${pad}⟧`;
}
export function buildPseudoDictionary(dict: Record<string, unknown>): Record<string, unknown> {
  const walk = (v: unknown): unknown =>
    typeof v === "string" ? toPseudo(v)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    : v;
  return walk(dict) as Record<string, unknown>;
}
```

In `getDictionary`, when `process.env.SEAZN_PSEUDO === "1"` and the requested locale is the pseudo, load `en` then return `buildPseudoDictionary(en)`. (The pseudo is never in `LOCALES`, so it only reaches here via the audit's `x-seazn-locale=en-XA` override + this env flag.)

- [ ] **Step 4: Write the audit spec (red until surfaces exist)**

```ts
// apps/web/e2e/i18n-pseudo.spec.ts
import { test, expect } from "@playwright/test";
const SURFACES = ["/pricing", "/"]; // extended to the Tamil league page in Task 9
test.describe("pseudolocale audit", () => {
  for (const path of SURFACES) {
    test(`no hardcoded strings on ${path}`, async ({ page, context }) => {
      await context.addCookies([{ name: "seazn_locale", value: "en-XA", url: "http://localhost:3000" }]);
      await page.goto(path);
      const bad = await page.locator("main :visible").evaluateAll((els) =>
        els.flatMap((el) => Array.from(el.childNodes)
          .filter((n) => n.nodeType === 3 && n.textContent!.trim())
          .map((n) => n.textContent!.trim()))
          .filter((txt) => !/^[\d\s\p{P}]+$/u.test(txt) && !txt.includes("⟦")));
      expect(bad, `hardcoded (un-pseudo'd) text: ${JSON.stringify(bad.slice(0, 5))}`).toHaveLength(0);
    });
  }
});
```

The Playwright config must launch the app with `SEAZN_PSEUDO=1` for this project (add a dedicated project/env in `playwright.config.ts`).

- [ ] **Step 5: Run unit test + commit** (the e2e spec is expected-red until Tasks 8–9 extract strings; do not gate on it yet)

Run: `npm run test --workspace apps/web -- pseudo.test` → PASS.

```bash
git add apps/web/src/lib/pseudo.ts apps/web/src/lib/i18n.ts apps/web/e2e/i18n-pseudo.spec.ts apps/web/src/lib/__tests__/pseudo.test.ts apps/web/playwright.config.ts
git commit -m "feat(i18n): en-XA pseudolocale + Playwright hardcoded-string audit harness"
```

---

## Task 8: marketing `[lang]` routing + string extraction

**Files:**
- Create: `apps/web/src/app/[lang]/(marketing)/layout.tsx`, `page.tsx` (home), `pricing/page.tsx`, `start/page.tsx` — moved from `app/page.tsx`, `app/pricing/`, `app/start/`
- Create: `apps/web/src/app/[lang]/(marketing)/sitemap.ts` (or extend root sitemap) + hreflang in `generateMetadata`
- Create: `apps/web/src/dictionaries/en/marketing.json` (extracted copy)
- Modify: `apps/web/src/proxy.ts` (rewrite unprefixed marketing paths → `/en/…`)
- Test: `apps/web/e2e/i18n-marketing.spec.ts`

**Interfaces:**
- Consumes: `getDictionary(locale, "marketing")`, `hasLocale`, `generateStaticParams`.
- Produces: marketing pages rendering under `/[lang]/…`; proxy rewrite of unprefixed marketing paths.

> **Root-conflict note:** a root `[lang]` dynamic segment coexists with the static top-level routes (`o`, `api`, `admin`, `scheduling`, …) because **static segments win over dynamic** in Next 16 — and no locale code (`en/fr/es/hi/ta/nl`) collides with a top-level route name. Only marketing pages move under `[lang]`; everything else stays put.

- [ ] **Step 1: Write the failing e2e test**

```ts
// apps/web/e2e/i18n-marketing.spec.ts
import { test, expect } from "@playwright/test";
test("localized pricing renders per locale", async ({ page }) => {
  await page.goto("/fr/pricing");
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(/Pricing/i); // fr copy, not en
});
test("unprefixed pricing serves en without a redirect", async ({ page }) => {
  const resp = await page.goto("/pricing");
  expect(resp?.status()).toBe(200);
  await expect(page).toHaveURL(/\/pricing$/); // rewrite, not redirect
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});
test("hreflang alternates present for all six", async ({ page }) => {
  await page.goto("/en/pricing");
  for (const l of ["en", "fr", "es", "hi", "ta", "nl"])
    await expect(page.locator(`link[rel="alternate"][hreflang="${l}"]`)).toHaveCount(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test i18n-marketing` (from `apps/web`)
Expected: FAIL — `/fr/pricing` 404s (no `[lang]` route yet).

- [ ] **Step 3: Move marketing under `[lang]`, extract copy, add rewrite + hreflang**

- Create `app/[lang]/(marketing)/layout.tsx` that validates `hasLocale(params.lang) || notFound()`, resolves the dict, and passes strings down. Add `export async function generateStaticParams() { return LOCALES.map((lang) => ({ lang })); }`.
- Move `app/page.tsx` → `app/[lang]/(marketing)/page.tsx`, `app/pricing/page.tsx` → `app/[lang]/(marketing)/pricing/page.tsx`, `app/start/page.tsx` → `app/[lang]/(marketing)/start/page.tsx`. Replace inline English with `t(dict, "…")`; author every string into `en/marketing.json`.
- `generateMetadata` emits `alternates.languages` for all six (hreflang) + localized OG tagline (Task 9 wires the OG font).
- In `proxy.ts`, before returning, rewrite unprefixed marketing paths to the `en` prefix:

```ts
const MARKETING = /^\/(pricing|start)?$/; // "/", "/pricing", "/start"
if (MARKETING.test(request.nextUrl.pathname)) {
  const url = request.nextUrl.clone();
  url.pathname = `/en${request.nextUrl.pathname === "/" ? "" : request.nextUrl.pathname}`;
  return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test i18n-marketing` → PASS (fr copy differs, `/pricing` rewrites to en, 6 hreflang links). Re-run `npm run i18n:gen-keys` so the new `marketing.*` keys type-check.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/\[lang\] apps/web/src/dictionaries/en/marketing.json apps/web/src/proxy.ts apps/web/e2e/i18n-marketing.spec.ts
git commit -m "feat(i18n): marketing [lang] routing (rewrite unprefixed→en) + hreflang + copy extraction"
```

---

## Task 9: public Tamil league proof + OG/PDF fonts + reg-email locale

**Files:**
- Modify: the public league/courtside page under `app/(public)/shared/[orgSlug]/…/page.tsx` (extract to `public` namespace, read `resolveLocale({ orgDefault })`)
- Modify: `apps/web/src/server/og/card.tsx` + poster PDF route (`…/poster.pdf/route.ts`) — per-locale Noto embed
- Modify: `apps/web/src/lib/email-templates/registration.ts` (`locale` param)
- Modify: `scripts/seed-demo.ts` (a demo org with `default_locale='ta'`)
- Create: `apps/web/assets/fonts/NotoSansDevanagari-Regular.ttf`, `NotoSansTamil-Regular.ttf`
- Create: `apps/web/src/dictionaries/en/public.json`, add reg keys to `en/emails.json`
- Test: `apps/web/e2e/i18n-tamil-league.spec.ts`, extend `registration` unit test

**Interfaces:**
- Consumes: `resolveLocale`, `getDictionary(locale, "public"|"emails")`, `fmtDate/fmtNumber(locale)`, OG `ImageResponse` `fonts`, pdfkit `registerFont`.
- Produces: a Tamil-default public page + Tamil OG card; `registrationTemplate(opts, locale)`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/e2e/i18n-tamil-league.spec.ts
import { test, expect } from "@playwright/test";
test("a ta-default org's public page renders Tamil for an anon visitor", async ({ page }) => {
  await page.goto("/shared/tamil-demo-club"); // seeded org, default_locale='ta'
  await expect(page.locator("html")).toHaveAttribute("lang", "ta");
  // A known public label renders its Tamil string (not the English source).
  await expect(page.getByTestId("standings-heading")).not.toHaveText(/Standings/i);
});
```

```ts
// registration email — add to the existing template test
it("localizes the subject when given a locale", () => {
  const en = registrationTemplate(baseArgs, "en");
  const ta = registrationTemplate(baseArgs, "ta");
  expect(ta.subject).not.toBe(en.subject);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx playwright test i18n-tamil-league` (FAIL — page still English) and `npm run test --workspace apps/web -- registration` (FAIL — `locale` arg ignored).

- [ ] **Step 3: Implement**

- Seed a `tamil-demo-club` org with `default_locale='ta'` in `scripts/seed-demo.ts`.
- In the public league page, `const locale = await resolveLocale({ orgDefault: org.default_locale as Locale });` then `const dict = await getDictionary(locale, "public")`; replace inline strings with `t(dict, …)` (author into `en/public.json`) and route dates/numbers through `fmt*({locale})`. Give the standings heading `data-testid="standings-heading"`.
- OG card: load the Noto TTF subset for hi/ta from `assets/fonts/` and pass via `ImageResponse({ fonts: [...] })`, family chosen by locale (Barlow for Latin). Poster PDF: `doc.registerFont("body", notoPathFor(locale))`.
- `registrationTemplate(opts, locale)`: move subject/preheader/body strings into `emails` namespace; `formatDeadline` takes the locale; default `en`.

- [ ] **Step 4: Run tests to verify they pass**

Run both suites → PASS. Then run the pseudolocale audit against the now-extracted surfaces:
`SEAZN_PSEUDO=1 npx playwright test i18n-pseudo` (extend `SURFACES` to include `/shared/tamil-demo-club`) → PASS (no un-pseudo'd visible text). `npm run i18n:gen-keys` for the new keys.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/\(public\) apps/web/src/server/og apps/web/src/lib/email-templates/registration.ts scripts/seed-demo.ts apps/web/assets/fonts apps/web/src/dictionaries/en/public.json apps/web/src/dictionaries/en/emails.json apps/web/e2e/i18n-tamil-league.spec.ts
git commit -m "feat(i18n): Tamil-default public league proof + Noto OG/PDF embed + localized reg email"
```

---

## Task 10: translation pipeline (incremental Claude `messages.parse()`)

**Files:**
- Create: `scripts/i18n/translate.ts`, `scripts/i18n/glossary.json`, `scripts/i18n/manifest.json`
- Modify: `package.json` (`i18n:translate`)
- Test: `scripts/i18n/__tests__/translate.test.ts` (mock the Anthropic client)

**Interfaces:**
- Consumes: `en/*.json`, `glossary.json`, `manifest.json` (last-translated content hashes), `check-parity`.
- Produces: `changedKeys(enFlat, manifest): string[]`; `translateBatch(client, {locale, entries, glossary}): Promise<Record<string,string>>` (structured output); writes `{locale}/*.json` for all six + updates the manifest; marks `hi`/`ta` entries with `reviewNeeded: true`.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/i18n/__tests__/translate.test.ts
import { describe, it, expect, vi } from "vitest";
import { changedKeys, translateBatch } from "../translate";

describe("translation pipeline", () => {
  it("selects only keys whose hash changed", () => {
    const en = { "a.b": "New", "c": "Same" };
    const manifest = { "a.b": "oldhash", "c": "__hash_of_Same__" };
    expect(changedKeys(en, manifest, (s) => s === "Same" ? "__hash_of_Same__" : "x"))
      .toEqual(["a.b"]);
  });
  it("calls the model once per locale and returns the parsed map", async () => {
    const client = { messages: { parse: vi.fn().mockResolvedValue({ parsed_output: { "a.b": "Nouveau" } }) } };
    const out = await translateBatch(client as never, {
      locale: "fr", entries: { "a.b": "New" }, glossary: {},
    });
    expect(out["a.b"]).toBe("Nouveau");
    expect(client.messages.parse).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace apps/web -- translate.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pipeline**

```ts
// scripts/i18n/translate.ts (core)
import Anthropic from "@anthropic-ai/sdk";

export function changedKeys(enFlat: Record<string, string>, manifest: Record<string, string>,
  hash: (s: string) => string): string[] {
  return Object.keys(enFlat).filter((k) => manifest[k] !== hash(enFlat[k]));
}

export async function translateBatch(client: Anthropic, args: {
  locale: string; entries: Record<string, string>; glossary: Record<string, string>;
}): Promise<Record<string, string>> {
  const schema = {
    type: "object", additionalProperties: false,
    properties: Object.fromEntries(Object.keys(args.entries).map((k) => [k, { type: "string" }])),
    required: Object.keys(args.entries),
  };
  const res = await client.messages.parse({
    model: "claude-opus-4-8",
    max_tokens: 8000,
    output_config: { format: { type: "json_schema", schema }, effort: "low" },
    system:
      `Translate UI strings from English to ${args.locale}. Preserve every {placeholder} exactly. ` +
      `Do not translate brand terms. Apply this glossary verbatim: ${JSON.stringify(args.glossary)}. ` +
      `Return a JSON object mapping each key to its translation.`,
    messages: [{ role: "user", content: JSON.stringify(args.entries) }],
  });
  return res.parsed_output as Record<string, string>;
}
// main(): for each non-en locale → changedKeys → translateBatch → merge into {locale}/*.json;
//   write hi/ta entries with a sidecar reviewNeeded flag; update manifest; then run check-parity.
```

`glossary.json` seeds sport terms (deuce/let/power-play/tie-break). Wire `"i18n:translate": "node --experimental-strip-types scripts/i18n/translate.ts"`.

- [ ] **Step 4: Run test + fill all six + verify parity**

Run: `npm run test --workspace apps/web -- translate.test` → PASS.
Run: `ANTHROPIC_API_KEY=… npm run i18n:translate && npm run i18n:check` → all six dictionaries filled, parity exits 0. `npm run i18n:gen-keys && tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add scripts/i18n/translate.ts scripts/i18n/glossary.json scripts/i18n/manifest.json scripts/i18n/__tests__/translate.test.ts apps/web/src/dictionaries package.json
git commit -m "feat(i18n): incremental Claude translation pipeline (glossary + parity), all six locales filled"
```

---

## Task 11: switcher + smoke + help docs (closing pass)

**Files:**
- Create: `apps/web/src/components/i18n/locale-switcher.tsx`, `i18n-provider.tsx`
- Modify: the public/marketing footer + account settings page (mount the switcher)
- Modify: `scripts/smoke.ts` (locale-switch + Tamil-render step, pro + free)
- Create: `content/help/languages.md` (locale switching)
- Test: `apps/web/e2e/i18n-switcher.spec.ts`

**Interfaces:**
- Consumes: `LOCALES`, `resolveLocale`; writes `seazn_locale` cookie (+ `users.locale` when signed in via an existing account-update action) and calls `router.refresh()`; on marketing also swaps the `[lang]` path.

- [ ] **Step 1: Write the failing e2e test**

```ts
// apps/web/e2e/i18n-switcher.spec.ts
import { test, expect } from "@playwright/test";
test("switching to French persists via cookie", async ({ page, context }) => {
  await page.goto("/");
  await page.getByTestId("locale-switcher").selectOption("fr");
  await expect(page).toHaveURL(/\/fr(\/|$)/);
  const cookie = (await context.cookies()).find((c) => c.name === "seazn_locale");
  expect(cookie?.value).toBe("fr");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test i18n-switcher`
Expected: FAIL — no switcher control.

- [ ] **Step 3: Build the switcher + mount + smoke + help**

- `locale-switcher.tsx` (client): a `<select data-testid="locale-switcher">` over `LOCALES`; on change set `document.cookie = "seazn_locale=…; path=/; max-age=31536000; samesite=lax"`, `router.push` the `[lang]`-swapped path on marketing (else `router.refresh()`), and — when signed in — POST the existing account-settings action to persist `users.locale`.
- Mount in the footer (public/marketing) and account settings.
- `scripts/smoke.ts`: add a step that switches to `fr` and asserts localized copy, and visits the Tamil demo org's public page asserting `lang="ta"` — on both pro and free paths.
- `content/help/languages.md`: how to switch languages, per-org public default, hi/ta availability note.

- [ ] **Step 4: Run everything green**

Run: `npx playwright test i18n-switcher` → PASS.
Run the full gate: `npm run i18n:gen-keys && npm run i18n:check && tsc --noEmit && npm run test --workspace apps/web && npx playwright test i18n-pseudo i18n-marketing i18n-tamil-league i18n-switcher && npm run smoke` → all green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/i18n scripts/smoke.ts content/help/languages.md apps/web/e2e/i18n-switcher.spec.ts
git commit -m "feat(i18n): locale switcher (footer + settings) + smoke coverage + help docs"
```

---

## Self-Review

**Spec coverage** — §3 engine → T1; §3 typing → T3; §4 resolution/proxy → T4; §5 marketing routing → T8; §6 DB → T2; §7 fonts → T5 (app) + T9 (OG/PDF); §8 formatting → T6; §9 pipeline → T10; §10 pseudolocale gate → T7 (+ surfaces wired in T8/T9); §11 switcher → T11; §12 proof surfaces → T8 (marketing) + T9 (Tamil league); §13 house rules → T11 (smoke + help) and per-task tests. All spec sections map to a task.

**Placeholder scan** — no TBD/TODO; every code step shows real code and exact commands.

**Type consistency** — `Locale`/`LOCALES`/`DEFAULT_LOCALE`/`hasLocale` defined in T1, split into `lib/i18n-constants.ts` in T4 for proxy-safe import, and reused unchanged in T4–T11. `getDictionary(locale, ns)`, `t(dict, key, vars?)`, `plural(dict, key, count, locale, vars?)`, `resolveLocale({orgDefault})`, `formatMinor(minor, currency, locale?)`, `fontClassFor(locale)`, `toPseudo`/`buildPseudoDictionary`, `changedKeys`/`translateBatch` are named identically wherever referenced.

**Known follow-ups (out of cycle 1, per spec §1):** console string extraction (46), 9 remaining emails (46), rest of public surface (45), non-marketing SEO/help translation (47), native hi/ta review, adopting the locale-aware `format` helpers across the other ~15 hardcoded-locale files.
