# PROMPT-40 — Marketing Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the home page and marketing surface to the approved "stadium night / matchday arc" design (`design/v3/12-marketing-redesign.md`), including the interactive format configurator and the new `/scheduling` page.

**Architecture:** The home page stays one server component assembling small marketing components from `src/components/marketing/`. Interactivity is limited to three client islands (hero vignette, The Draw configurator, scheduling board). The configurator's default draw is computed server-side with `previewDivisionFixtures` (SSR = the no-JS fallback); control changes call a new unauthenticated `POST /api/public/format-preview` that reuses the canned stage graphs already in `src/config/format-gallery.tsx`. All motion is CSS keyframes gated by one IntersectionObserver utility and `prefers-reduced-motion`.

**Tech Stack:** Next.js App Router (see `node_modules/next/dist/docs/` before writing code — this version has breaking changes), Tailwind v4 (`globals.css` `@theme`/`@apply` idiom), zod, vitest, Playwright.

## Global Constraints

- **No new dependencies.** CSS keyframes only — no animation library.
- Motion: transform/opacity only; every animation plays **once**; everything static under `prefers-reduced-motion: reduce`.
- Marketing CSS vars are namespaced `--mk-*` (never touch the public `--ps-*` layer).
- Palette (from the spec, verbatim): night `#150b36`, night-2 `#1d1145`, cream `#f5f0e8`, lime `#a3e635`, purple `#7c3aed`, light-violet `#f6f3ff`, light-warm `#fffdf7`, orange `#fb923c`, live red `#ef4444`.
- Display face: Barlow Condensed via `next/font` (copy the `src/app/slideshow/layout.tsx` pattern), body stays Geist.
- **No humans in any SVG.** Chunky-outline equipment only (~3px outline, flat fills).
- Funnel logic untouched — `StartFunnelForm` gets a style variant only.
- House rules: every change ships a regression test that fails without it; `scripts/smoke.ts` extended; `npm run tsc` (or `npx tsc -p .`) + unit tests before every push.
- Playwright MUST run from `apps/web` (repo-root runs break `storageState` paths).
- All work on branch `feat/marketing-matchday`. Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- WCAG 2.1 AA (v3/11 gap 11): axe serious/critical = 0 on `/` and `/scheduling`.
- If a killed dev server produces phantom 404s on `/api/*`: `rm -rf apps/web/.next` and restart.
- All paths below are relative to `apps/web/` unless they start with `design/` or `scripts/`.

**Plan-level refinements of the spec (already justified, don't re-litigate):**
- Ticket-stub content comes from a new shared `src/lib/pricing-cards.ts` extracted from `/pricing`'s hardcoded bullet arrays, plus `passPrice`/`proPrice` from `src/lib/currency.ts` — single source shared by `/pricing` and the stubs, which is what the spec's "renders from pricing data, drift test" intends. `/pricing` page behavior unchanged (its e2e `pricing-v3.spec.ts` guards that).
- The public API wraps the same canned stage graphs the `/formats` gallery uses (`FORMAT_FAMILIES[..].cannedStages`) instead of inventing new ones.

---

### Task 1: Marketing tokens + Reveal utility

**Files:**
- Modify: `src/app/globals.css` (append a marketing section at the end)
- Create: `src/components/marketing/reveal.tsx`
- Test: `src/components/marketing/__tests__/reveal.test.tsx`

**Interfaces:**
- Produces: CSS vars `--mk-night|night-2|cream|lime|purple|light-violet|light-warm|orange|live`; classes `.mk-reveal`/`.mk-in`; `<Reveal as?="div"|"section" className children delay?>` client component that adds `mk-in` once on viewport entry.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/marketing/__tests__/reveal.test.tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Reveal } from "../reveal";

type IOCallback = (entries: Array<{ isIntersecting: boolean }>) => void;
let ioCallback: IOCallback;
const observe = vi.fn();
const disconnect = vi.fn();

beforeEach(() => {
  observe.mockClear();
  disconnect.mockClear();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: IOCallback) {
        ioCallback = cb;
      }
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
    },
  );
});

describe("Reveal", () => {
  it("adds mk-in once on first intersection, then disconnects", () => {
    render(<Reveal data-testid="r">hi</Reveal>);
    const el = screen.getByTestId("r");
    expect(el.className).toContain("mk-reveal");
    expect(el.className).not.toContain("mk-in");
    ioCallback([{ isIntersecting: true }]);
    expect(el.className).toContain("mk-in");
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("ignores non-intersecting entries", () => {
    render(<Reveal data-testid="r">hi</Reveal>);
    ioCallback([{ isIntersecting: false }]);
    expect(screen.getByTestId("r").className).not.toContain("mk-in");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/web`): `npx vitest run src/components/marketing/__tests__/reveal.test.tsx`
Expected: FAIL — cannot resolve `../reveal`.

- [ ] **Step 3: Write the implementation**

```tsx
// src/components/marketing/reveal.tsx
"use client";

import { useEffect, useRef, useState } from "react";

/** Once-on-view reveal (design/v3/12 §2 motion rules). Adds `mk-in` the first
 *  time the element enters the viewport, then stops observing. The CSS end
 *  state is shown immediately under prefers-reduced-motion, so the class is
 *  inert there. */
export function Reveal({
  as: Tag = "div",
  className = "",
  children,
  ...rest
}: {
  as?: "div" | "section" | "li";
  className?: string;
  children: React.ReactNode;
} & Record<string, unknown>) {
  const ref = useRef<HTMLElement | null>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);

  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <Tag ref={ref as any} className={`mk-reveal ${seen ? "mk-in" : ""} ${className}`} {...rest}>
      {children}
    </Tag>
  );
}
```

Append to `src/app/globals.css`:

```css
/* ── Marketing "stadium night" system (design/v3/12) ─────────────────────── */
:root {
  --mk-night: #150b36;
  --mk-night-2: #1d1145;
  --mk-cream: #f5f0e8;
  --mk-lime: #a3e635;
  --mk-purple: #7c3aed;
  --mk-light-violet: #f6f3ff;
  --mk-light-warm: #fffdf7;
  --mk-orange: #fb923c;
  --mk-live: #ef4444;
}

.mk-display {
  font-family: var(--mk-font-display, var(--font-geist-sans));
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.mk-reveal { opacity: 0; transform: translateY(18px); }
.mk-reveal.mk-in { animation: mk-rise 0.6s cubic-bezier(0.22, 1.2, 0.36, 1) forwards; }
@keyframes mk-rise { to { opacity: 1; transform: none; } }

@media (prefers-reduced-motion: reduce) {
  .mk-reveal { opacity: 1; transform: none; }
  .mk-reveal.mk-in { animation: none; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/marketing/__tests__/reveal.test.tsx`
Expected: 2 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/globals.css src/components/marketing/reveal.tsx src/components/marketing/__tests__/reveal.test.tsx
git commit -m "feat(marketing): stadium-night tokens + once-on-view Reveal"
```

---

### Task 2: Club-name generator

**Files:**
- Create: `src/lib/marketing/club-names.ts`
- Test: `src/lib/marketing/__tests__/club-names.test.ts`

**Interfaces:**
- Produces: `clubNames(count: number, seed: number): string[]` — deterministic per seed, all names distinct, `count` clamped to 4–16.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/marketing/__tests__/club-names.test.ts
import { describe, expect, it } from "vitest";
import { clubNames } from "../club-names";

describe("clubNames", () => {
  it("is deterministic per seed", () => {
    expect(clubNames(8, 42)).toEqual(clubNames(8, 42));
  });
  it("differs across seeds", () => {
    expect(clubNames(8, 1)).not.toEqual(clubNames(8, 2));
  });
  it("returns distinct names, clamped 4..16", () => {
    const names = clubNames(16, 7);
    expect(new Set(names).size).toBe(16);
    expect(clubNames(2, 7)).toHaveLength(4);
    expect(clubNames(99, 7)).toHaveLength(16);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/marketing/__tests__/club-names.test.ts`
Expected: FAIL — cannot resolve `../club-names`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/marketing/club-names.ts

/** Club-flavored placeholder names for the home configurator (design/v3/12
 *  §4.4). Deterministic per seed so tests and SSR/CSR agree; the Shuffle
 *  button just passes a new seed. */
const PLACES = [
  "Riverside", "Northside", "Harbour", "Oakwood", "Milltown", "Westgate",
  "Southbank", "Kingsway", "Fernhill", "Redbrick", "Lakeside", "Hillcrest",
  "Eastfield", "Stonebridge", "Maplegrove", "Brookvale",
];
const MASCOTS = [
  "Falcons", "Comets", "Tigers", "Rovers", "Aces", "Smash", "Kings",
  "Arrows", "Titans", "Foxes", "Strikers", "Rockets", "Wolves", "Giants",
  "Chargers", "Rangers",
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clubNames(count: number, seed: number): string[] {
  const n = Math.min(Math.max(Math.trunc(count) || 4, 4), 16);
  const rand = mulberry32(seed);
  const places = [...PLACES].sort(() => rand() - 0.5);
  const mascots = [...MASCOTS].sort(() => rand() - 0.5);
  return Array.from({ length: n }, (_, i) => `${places[i]} ${mascots[i]}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/marketing/__tests__/club-names.test.ts`
Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/marketing/club-names.ts src/lib/marketing/__tests__/club-names.test.ts
git commit -m "feat(marketing): seeded club-name generator for the configurator"
```

---

### Task 3: Marketing format mapping + public format-preview API

**Files:**
- Create: `src/lib/marketing/format-preview.ts`
- Create: `src/app/api/public/format-preview/route.ts`
- Test: `src/lib/marketing/__tests__/format-preview.test.ts`
- Test: `src/app/api/public/format-preview/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `formatFamily(slug)` from `@/config/format-gallery`; `previewDivisionFixtures`, `type PreviewPhase` from `@/server/usecases/stages`; `handler` from `@/lib/http`; `rateLimit`, `type RateLimitConfig` from `@/lib/rate-limit`.
- Produces: `MARKETING_FORMATS = ["league","groups-knockout","knockout","double_elim"] as const`, `type MarketingFormat`, `marketingPreview(format, entrants): PreviewPhase[]` (entrants clamped 4–16); `POST /api/public/format-preview` accepting `{ format: MarketingFormat, entrants: number }` returning `{ phases: PreviewPhase[] }`.

- [ ] **Step 1: Write the failing lib test**

```ts
// src/lib/marketing/__tests__/format-preview.test.ts
import { describe, expect, it } from "vitest";
import { MARKETING_FORMATS, marketingPreview } from "../format-preview";

describe("marketingPreview", () => {
  it("returns drawable phases for all four marketing formats", () => {
    for (const f of MARKETING_FORMATS) {
      const phases = marketingPreview(f, 8);
      expect(phases.length).toBeGreaterThan(0);
      // The whole point of the home demo: never a note-only tab (that is why
      // swiss is excluded — see design/v3/12 §4.4).
      expect(phases.some((p) => p.sections.length > 0)).toBe(true);
    }
  });
  it("groups-knockout yields two phases (groups feed a bracket)", () => {
    expect(marketingPreview("groups-knockout", 8)).toHaveLength(2);
  });
  it("is deterministic and clamps entrants to 4..16", () => {
    expect(marketingPreview("league", 8)).toEqual(marketingPreview("league", 8));
    expect(marketingPreview("league", 2)).toEqual(marketingPreview("league", 4));
    expect(marketingPreview("league", 64)).toEqual(marketingPreview("league", 16));
  });
});
```

- [ ] **Step 2: Run it — expect module-not-found FAIL**

Run: `npx vitest run src/lib/marketing/__tests__/format-preview.test.ts`

- [ ] **Step 3: Implement the mapping**

```ts
// src/lib/marketing/format-preview.ts
import { formatFamily } from "@/config/format-gallery";
import { previewDivisionFixtures, type PreviewPhase } from "@/server/usecases/stages";

/** Formats offered by the home-page configurator (design/v3/12 §4.4).
 *  Swiss is deliberately absent: previewDivisionFixtures returns a note-only
 *  phase for score-dependent formats, and a note is a dead tab in a
 *  play-first demo. Slugs match src/config/format-gallery.tsx. */
export const MARKETING_FORMATS = [
  "league",
  "groups-knockout",
  "knockout",
  "double_elim",
] as const;
export type MarketingFormat = (typeof MARKETING_FORMATS)[number];

export const MARKETING_FORMAT_LABELS: Record<MarketingFormat, string> = {
  league: "League",
  "groups-knockout": "Groups + KO",
  knockout: "Knockout",
  double_elim: "Double elim",
};

export function marketingPreview(format: MarketingFormat, entrants: number): PreviewPhase[] {
  const family = formatFamily(format);
  if (!family) throw new Error(`unknown marketing format '${format}'`);
  const n = Math.min(Math.max(Math.trunc(entrants) || 8, 4), 16);
  return previewDivisionFixtures(family.cannedStages, n);
}
```

- [ ] **Step 4: Run lib test — expect 3 PASS**

Run: `npx vitest run src/lib/marketing/__tests__/format-preview.test.ts`
If `groups-knockout` fails on phase count, inspect `formatFamily("groups-knockout")!.cannedStages` — it must stay the two-stage graph (group + knockout) defined in `src/config/format-gallery.tsx`.

- [ ] **Step 5: Write the failing route test**

```ts
// src/app/api/public/format-preview/__tests__/route.test.ts
import { describe, expect, it } from "vitest";
import { POST } from "../route";

function req(body: unknown, ip = "203.0.113.7") {
  return new Request("http://localhost/api/public/format-preview", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

describe("POST /api/public/format-preview", () => {
  it("returns phases for a valid request, no auth required", async () => {
    const res = await POST(req({ format: "groups-knockout", entrants: 8 }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { phases: Array<{ sections: unknown[] }> };
    expect(json.phases).toHaveLength(2);
    expect(json.phases[0]!.sections.length).toBeGreaterThan(0);
  });

  it("rejects unknown formats and out-of-range entrants", async () => {
    expect((await POST(req({ format: "swiss", entrants: 8 }))).status).toBe(400);
    expect((await POST(req({ format: "league", entrants: 3 }))).status).toBe(400);
    expect((await POST(req({ format: "league", entrants: 17 }))).status).toBe(400);
  });
});
```

- [ ] **Step 6: Run it — expect module-not-found FAIL**

Run: `npx vitest run src/app/api/public/format-preview/__tests__/route.test.ts`

- [ ] **Step 7: Implement the route**

Follow the shape of `src/app/api/funnel/start/route.ts` (handler + rateLimit) but read the IP from `req.headers` directly — no `next/headers`, so the route stays unit-testable. If `handler`'s zod-error → 400 mapping differs in `src/lib/http`, match whatever `funnel/start` does and keep the test's status expectations aligned with it.

```ts
// src/app/api/public/format-preview/route.ts
import { z } from "zod";
import { handler } from "@/lib/http";
import { rateLimit, type RateLimitConfig } from "@/lib/rate-limit";
import {
  MARKETING_FORMATS,
  marketingPreview,
  type MarketingFormat,
} from "@/lib/marketing/format-preview";

/** Public engine demo for the home configurator (design/v3/12 §4.4).
 *  Pure computation over placeholder entrants — no DB, no session. */
const PREVIEW_LIMIT: RateLimitConfig = { max: 30, windowSeconds: 60 };

const schema = z
  .object({
    format: z.enum(MARKETING_FORMATS),
    entrants: z.number().int().min(4).max(16),
  })
  .strict();

// Deterministic per (format, entrants) — cache for the process lifetime.
const cache = new Map<string, { phases: ReturnType<typeof marketingPreview> }>();

export async function POST(req: Request) {
  return handler(async () => {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    await rateLimit(`format-preview:${ip}`, PREVIEW_LIMIT);

    const { format, entrants } = schema.parse(await req.json());
    const key = `${format}:${entrants}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = { phases: marketingPreview(format as MarketingFormat, entrants) };
      cache.set(key, hit);
    }
    return hit;
  });
}
```

- [ ] **Step 8: Run route test — expect 2 PASS**

Run: `npx vitest run src/app/api/public/format-preview/__tests__/route.test.ts`

- [ ] **Step 9: Commit**

```bash
git add src/lib/marketing/format-preview.ts src/lib/marketing/__tests__/format-preview.test.ts src/app/api/public/format-preview
git commit -m "feat(marketing): public format-preview API over gallery stage graphs"
```

---

### Task 4: Shared pricing cards + ticket stubs

**Files:**
- Create: `src/lib/pricing-cards.ts`
- Modify: `src/app/pricing/page.tsx` (replace its local `FREE_FEATURES`/`PASS_FEATURES`/`PRO_FEATURES` constants with imports — zero visual change)
- Create: `src/components/marketing/ticket-stubs.tsx`
- Test: `src/lib/__tests__/pricing-cards.test.ts`

**Interfaces:**
- Consumes: `passPrice`, `proPrice`, `formatMinor`, `type Currency` from `@/lib/currency`.
- Produces: `FREE_FEATURES`, `PASS_FEATURES`, `PRO_FEATURES` (string[] — the exact arrays currently in `src/app/pricing/page.tsx`); `ticketTiers(currency: Currency): TicketTier[]` where `TicketTier = { tier: string; price: string; period?: string; bullets: string[]; glow?: boolean }`; `<TicketStubs currency={Currency} />` server component (renders the three stubs + fan-in CSS classes `mk-stub`).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/pricing-cards.test.ts
import { describe, expect, it } from "vitest";
import {
  FREE_FEATURES,
  PASS_FEATURES,
  PRO_FEATURES,
  ticketTiers,
} from "../pricing-cards";

describe("pricing cards", () => {
  it("stub bullets are drawn from the shared /pricing arrays (drift guard)", () => {
    const [community, pass, pro] = ticketTiers("USD");
    expect(community!.bullets.every((b) => FREE_FEATURES.includes(b))).toBe(true);
    expect(pass!.bullets.every((b) => PASS_FEATURES.includes(b))).toBe(true);
    expect(pro!.bullets.every((b) => PRO_FEATURES.includes(b))).toBe(true);
    expect(community!.bullets.length).toBeGreaterThanOrEqual(3);
  });
  it("prices come from lib/currency (multi-currency stays correct)", () => {
    const [, passUsd, proUsd] = ticketTiers("USD");
    expect(passUsd!.price).toBe("$39");
    expect(proUsd!.price).toBe("$20");
    expect(proUsd!.period).toBe("/mo");
    const [, passInr] = ticketTiers("INR");
    expect(passInr!.price).not.toBe("$39");
  });
  it("only the Event Pass glows", () => {
    expect(ticketTiers("USD").map((t) => Boolean(t.glow))).toEqual([false, true, false]);
  });
});
```

- [ ] **Step 2: Run it — expect module-not-found FAIL**

Run: `npx vitest run src/lib/__tests__/pricing-cards.test.ts`

- [ ] **Step 3: Implement `pricing-cards.ts`**

Move the three feature arrays **verbatim** out of `src/app/pricing/page.tsx` (cut, don't copy — the page then imports them). Check the exact `formatMinor` signature in `src/lib/currency.ts` before writing `price()`; if it renders `"$39.00"`, strip trailing `.00`/`,00` as below.

```ts
// src/lib/pricing-cards.ts
import { formatMinor, passPrice, proPrice, type Currency } from "@/lib/currency";

// Single source for plan-card bullets — shared by /pricing and the home
// ticket stubs so the two can never drift (design/v3/12 §4.8).
export const FREE_FEATURES = [
  "1 active competition, 2 divisions",
  "16 entrants per division",
  "League, groups + knockout & swiss formats",
  "Free-event online registration",
  "Live standings & public dashboard",
  "Listed on the seazn.club showcase",
];

export const PASS_FEATURES = [
  "Upgrades ONE competition, forever",
  "10 divisions, 32 entrants each",
  "Advanced formats — double elim, ladders",
  "Entry fees via Stripe (5% platform fee)",
  "Custom branding & PDF/XLSX exports",
  "Realtime scoreboard & slideshow",
];

export const PRO_FEATURES = [
  "Unlimited competitions & divisions",
  "256 entrants per division",
  "Entry fees at a 2% platform fee",
  "Ball-by-ball & rally scoring, player stats",
  "Officials, exports, API keys, device links",
  "Remove the “Powered by Seazn” badge",
];

export interface TicketTier {
  tier: string;
  price: string;
  period?: string;
  bullets: string[];
  glow?: boolean;
}

const trimZeros = (s: string) => s.replace(/[.,]00$/, "");

/** The three home-page ticket stubs (design/v3/12 §4.8): headline bullets
 *  only — the full matrix lives on /pricing. */
export function ticketTiers(currency: Currency): TicketTier[] {
  return [
    { tier: "Community", price: "Free", bullets: FREE_FEATURES.slice(0, 4) },
    {
      tier: "Event Pass",
      price: trimZeros(formatMinor(passPrice(currency), currency)),
      period: " once",
      bullets: PASS_FEATURES.slice(0, 4),
      glow: true,
    },
    {
      tier: "Pro",
      price: trimZeros(formatMinor(proPrice("monthly", currency), currency)),
      period: "/mo",
      bullets: PRO_FEATURES.slice(0, 4),
    },
  ];
}
```

In `src/app/pricing/page.tsx`: delete the local `FREE_FEATURES`, `PASS_FEATURES`, `PRO_FEATURES` constants and add
`import { FREE_FEATURES, PASS_FEATURES, PRO_FEATURES } from "@/lib/pricing-cards";`.

- [ ] **Step 4: Run tests — expect 3 PASS, then typecheck**

Run: `npx vitest run src/lib/__tests__/pricing-cards.test.ts && npx tsc -p . --noEmit`
Fix `passPrice`/`proPrice`/`formatMinor` call shapes against `src/lib/currency.ts` if tsc complains (adjust the test's expected strings to the real formatter output — the invariant is "same helper as /pricing", not a specific string).

- [ ] **Step 5: Implement `<TicketStubs>`**

```tsx
// src/components/marketing/ticket-stubs.tsx
import Link from "next/link";
import { ticketTiers } from "@/lib/pricing-cards";
import type { Currency } from "@/lib/currency";
import { Reveal } from "./reveal";

/** Floodlit finale pricing (design/v3/12 §4.8): three ticket stubs, Event
 *  Pass glowing. Content comes from the shared pricing-cards source. */
export function TicketStubs({ currency }: { currency: Currency }) {
  return (
    <div className="flex flex-wrap justify-center gap-5">
      {ticketTiers(currency).map((t, i) => (
        <Reveal
          key={t.tier}
          className={`mk-stub relative w-60 rounded-xl border p-5 text-left ${
            t.glow
              ? "border-[var(--mk-lime)] shadow-[0_0_34px_rgba(163,230,53,0.22)]"
              : "border-[#3b2a6e]"
          }`}
          style={{ animationDelay: `${i * 120}ms`, background: "linear-gradient(160deg,#241650,#1a0f3e)" }}
        >
          <span className="mk-stub-tear" aria-hidden />
          <span className="mk-stub-admit mk-display" aria-hidden>
            ADMIT ONE
          </span>
          <p className={`mk-display text-xs font-semibold tracking-[0.18em] ${t.glow ? "text-[var(--mk-lime)]" : "text-[#b7aede]"}`}>
            {t.tier}
          </p>
          <p className="mk-display my-1 text-4xl font-bold tabular-nums text-[var(--mk-cream)]">
            {t.price}
            {t.period ? <span className="text-base font-medium text-[#b7aede]">{t.period}</span> : null}
          </p>
          <ul className="w-44 space-y-1 text-xs leading-relaxed text-[#cfc6ec]">
            {t.bullets.map((b) => (
              <li key={b}>
                <span className="text-[var(--mk-lime)]">✓</span> {b}
              </li>
            ))}
          </ul>
        </Reveal>
      ))}
      <p className="w-full">
        <Link href="/pricing" className="text-xs text-[#8d7fc0] underline hover:text-[var(--mk-lime)]">
          Compare plans in detail →
        </Link>
      </p>
    </div>
  );
}
```

Append the stub chrome to the marketing section of `src/app/globals.css`:

```css
.mk-stub::before,
.mk-stub::after {
  content: "";
  position: absolute;
  right: 3.25rem;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--mk-night);
}
.mk-stub::before { top: -8px; }
.mk-stub::after { bottom: -8px; }
.mk-stub-tear {
  position: absolute;
  top: 8px;
  bottom: 8px;
  right: 3.625rem;
  border-right: 2px dashed #4a3885;
}
.mk-stub-admit {
  position: absolute;
  top: 50%;
  right: 0.875rem;
  transform: translateY(-50%) rotate(90deg);
  font-size: 10px;
  letter-spacing: 0.3em;
  color: #8d7fc0;
}
```

(`Reveal` doesn't accept `style` yet — it spreads `...rest` onto the tag, so `style` passes through; keep the spread.)

- [ ] **Step 6: Typecheck + full unit run**

Run: `npx tsc -p . --noEmit && npx vitest run src/lib`
Expected: clean; the pricing page renders the same bullets from the new import.

- [ ] **Step 7: Commit**

```bash
git add src/lib/pricing-cards.ts src/lib/__tests__/pricing-cards.test.ts src/app/pricing/page.tsx src/components/marketing/ticket-stubs.tsx src/app/globals.css
git commit -m "feat(marketing): ticket-stub pricing from shared pricing-cards source"
```

---

### Task 5: Hero vignette (object relay)

**Files:**
- Create: `src/components/marketing/hero-vignette.tsx`
- Modify: `src/app/globals.css` (vignette keyframes)
- Test: `src/components/marketing/__tests__/hero-vignette.test.tsx`

**Interfaces:**
- Produces: `<HeroVignette />` client component — fixed-height (`h-64 sm:h-72`) night vignette, plays once on mount, replay button (`aria-label="Replay animation"`) restarts it by remounting the SVG (React `key` bump). Ends as a scorebug chip with pulsing LIVE dot (`data-testid="scorebug"`).

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/marketing/__tests__/hero-vignette.test.tsx
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { HeroVignette } from "../hero-vignette";

describe("HeroVignette", () => {
  it("renders the scorebug end-state and a replay control", () => {
    render(<HeroVignette />);
    expect(screen.getByTestId("scorebug")).toBeTruthy();
    expect(screen.getByRole("button", { name: /replay animation/i })).toBeTruthy();
  });
  it("replay remounts the animation layer", () => {
    render(<HeroVignette />);
    const first = screen.getByTestId("vignette-run");
    fireEvent.click(screen.getByRole("button", { name: /replay animation/i }));
    expect(screen.getByTestId("vignette-run")).not.toBe(first);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (module not found)**

Run: `npx vitest run src/components/marketing/__tests__/hero-vignette.test.tsx`

- [ ] **Step 3: Implement**

The SVG is the approved chunky-outline style (compare against the brainstorm mock `.superpowers/brainstorm/29719-1783809837/content/hero-a-refined.html` when styling): ball tosses up, bat swings through it, star burst, ball flies left and lands as the LIVE dot on the scorebug. Every moving part is a `<g>` with a CSS animation; total sequence ≈ 2.6s; after it, only the LIVE dot pulses and the bat sways on an 8s loop.

```tsx
// src/components/marketing/hero-vignette.tsx
"use client";

import { useState } from "react";

/** Object-relay hero animation (design/v3/12 §4.2). No humans — ball is the
 *  protagonist. Fixed-height container so CLS stays 0; under
 *  prefers-reduced-motion the CSS shows the end state (ball on scorebug). */
export function HeroVignette() {
  const [run, setRun] = useState(0);

  return (
    <div className="relative h-64 w-full max-w-md sm:h-72" aria-hidden={false}>
      <div key={run} data-testid="vignette-run" className="mk-vignette absolute inset-0">
        <svg viewBox="0 0 420 280" className="h-full w-full" role="img" aria-label="A cricket bat strikes a ball that lands as a live score">
          {/* pitch line */}
          <line x1="24" y1="236" x2="396" y2="236" stroke="var(--mk-lime)" strokeWidth="3" strokeLinecap="round" opacity="0.55" />
          {/* bat: chunky outline, swings once */}
          <g className="mk-bat">
            <rect x="288" y="130" width="26" height="96" rx="12" fill="#d9b98a" stroke="#1e1b2e" strokeWidth="3" />
            <rect x="294" y="98" width="14" height="40" rx="7" fill="#8a6a3f" stroke="#1e1b2e" strokeWidth="3" />
          </g>
          {/* impact star — pops at strike time */}
          <g className="mk-star">
            <path d="M300 150 l10 -22 6 20 20 -8 -14 18 22 6 -24 6 10 20 -20 -12 -6 22 -8 -22z" fill="var(--mk-orange)" stroke="#1e1b2e" strokeWidth="3" strokeLinejoin="round" />
          </g>
          {/* the ball: toss → hang → struck left → lands on scorebug */}
          <g className="mk-ball">
            <circle r="13" fill="#f43f5e" stroke="#1e1b2e" strokeWidth="3" />
            <path d="M -9 -6 q 9 6 18 0" fill="none" stroke="#1e1b2e" strokeWidth="2" />
          </g>
        </svg>
        {/* scorebug chip: the product end-state */}
        <div
          data-testid="scorebug"
          className="absolute bottom-2 left-2 flex items-center gap-2 rounded-lg border border-[#3b2a6e] bg-[#1a0f3e] px-3 py-2"
        >
          <span className="mk-live-dot h-2.5 w-2.5 rounded-full bg-[var(--mk-live)]" />
          <span className="mk-display text-xs font-semibold tracking-widest text-[var(--mk-lime)]">LIVE</span>
          <span className="mk-display text-sm font-bold tabular-nums text-[var(--mk-cream)]">
            Falcons 21 · Comets 18
          </span>
        </div>
      </div>
      <button
        type="button"
        aria-label="Replay animation"
        onClick={() => setRun((n) => n + 1)}
        className="absolute right-1 top-1 rounded-md border border-[#3b2a6e] px-2 py-1 text-[10px] text-[#8d7fc0] hover:text-[var(--mk-cream)]"
      >
        ↺ replay
      </button>
    </div>
  );
}
```

Append to the marketing section of `src/app/globals.css`:

```css
/* Hero vignette choreography (~2.6s once, then idle). Transform/opacity only. */
.mk-vignette .mk-ball {
  animation:
    mk-ball-toss 1.1s cubic-bezier(0.3, 0, 0.4, 1) forwards,
    mk-ball-fly 0.9s 1.5s cubic-bezier(0.2, 0.8, 0.3, 1) forwards;
  transform: translate(302px, 250px);
}
@keyframes mk-ball-toss {
  40% { transform: translate(302px, 96px); }
  100% { transform: translate(302px, 148px); }
}
@keyframes mk-ball-fly {
  60% { transform: translate(120px, 90px); }
  100% { transform: translate(58px, 246px); opacity: 0; }
}
.mk-vignette .mk-bat {
  transform-origin: 301px 226px;
  animation:
    mk-bat-swing 0.5s 1.25s cubic-bezier(0.3, 0, 0.2, 1.4) forwards,
    mk-bat-sway 8s 3s ease-in-out infinite;
}
@keyframes mk-bat-swing {
  0% { transform: rotate(8deg); }
  60% { transform: rotate(-52deg); }
  100% { transform: rotate(-38deg); }
}
@keyframes mk-bat-sway {
  50% { transform: rotate(-34deg); }
}
.mk-vignette .mk-star {
  opacity: 0;
  transform-origin: 308px 148px;
  animation: mk-star-pop 0.5s 1.5s cubic-bezier(0.2, 1.6, 0.4, 1) forwards;
}
@keyframes mk-star-pop {
  0% { opacity: 0; transform: scale(0.2); }
  60% { opacity: 1; transform: scale(1.15); }
  100% { opacity: 0; transform: scale(0.9); }
}
.mk-live-dot { animation: mk-pulse 1.6s 2.4s ease-in-out infinite; }
@keyframes mk-pulse { 50% { opacity: 0.35; } }

@media (prefers-reduced-motion: reduce) {
  .mk-vignette .mk-ball { animation: none; opacity: 0; }
  .mk-vignette .mk-bat { animation: none; transform: rotate(-38deg); }
  .mk-vignette .mk-star { animation: none; opacity: 0; }
  .mk-live-dot { animation: none; }
}
```

- [ ] **Step 4: Run test — expect 2 PASS**

Run: `npx vitest run src/components/marketing/__tests__/hero-vignette.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add src/components/marketing/hero-vignette.tsx src/components/marketing/__tests__/hero-vignette.test.tsx src/app/globals.css
git commit -m "feat(marketing): object-relay hero vignette, once-on-load + replay"
```

---

### Task 6: LIVE ticker

**Files:**
- Create: `src/components/marketing/live-ticker.tsx`
- Modify: `src/app/globals.css` (marquee keyframes)
- Test: `src/components/marketing/__tests__/live-ticker.test.tsx`

**Interfaces:**
- Consumes: `type DiscoveryLiveFixture` from `@/server/public-site/discovery` (`{ id, sport_key, headline, competition_name, org_slug, comp_slug, division_slug }`).
- Produces: `<LiveTicker fixtures={DiscoveryLiveFixture[]} />` — lime strip; renders `null` when empty; each item links to `/shared/{org_slug}/{comp_slug}` (same target `LiveNowStrip` used — confirm in `src/components/discovery-cards.tsx` and match it exactly, including any query/fragment).

- [ ] **Step 1: Check the existing link target**

Run: `grep -n "href" src/components/discovery-cards.tsx | head`
Copy the exact fixture href pattern into the component and test below (adjust both if it differs from `/shared/{org}/{comp}`).

- [ ] **Step 2: Write the failing test**

```tsx
// src/components/marketing/__tests__/live-ticker.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LiveTicker } from "../live-ticker";
import type { DiscoveryLiveFixture } from "@/server/public-site/discovery";

const fx = (n: number): DiscoveryLiveFixture => ({
  id: `f${n}`,
  sport_key: "badminton",
  headline: `Falcons 2${n} — Comets 1${n}`,
  competition_name: `Summer Open ${n}`,
  org_slug: "riverside",
  comp_slug: `summer-${n}`,
  division_slug: "a",
});

describe("LiveTicker", () => {
  it("collapses to nothing when no live fixtures", () => {
    const { container } = render(<LiveTicker fixtures={[]} />);
    expect(container.firstChild).toBeNull();
  });
  it("renders one link per fixture with the headline", () => {
    render(<LiveTicker fixtures={[fx(1), fx(2)]} />);
    const links = screen.getAllByRole("link");
    expect(links.length).toBeGreaterThanOrEqual(2);
    expect(links[0]!.getAttribute("href")).toContain("/shared/riverside/summer-1");
    expect(screen.getAllByText(/Falcons 21 — Comets 11/).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run it — expect FAIL, then implement**

```tsx
// src/components/marketing/live-ticker.tsx
import Link from "next/link";
import type { DiscoveryLiveFixture } from "@/server/public-site/discovery";

/** LIVE ticker under the hero (design/v3/12 §4.3). Real fixtures only —
 *  collapses when nothing is live. Marquee duplicates the row for a seamless
 *  loop; it pauses on hover/focus and is static under reduced motion. */
export function LiveTicker({ fixtures }: { fixtures: DiscoveryLiveFixture[] }) {
  if (fixtures.length === 0) return null;

  const row = (dup: boolean) => (
    <div className="mk-ticker-row flex shrink-0 items-center gap-8 pr-8" aria-hidden={dup}>
      {fixtures.map((f) => (
        <Link
          key={`${dup ? "d-" : ""}${f.id}`}
          href={`/shared/${f.org_slug}/${f.comp_slug}`}
          tabIndex={dup ? -1 : 0}
          className="mk-display flex items-center gap-2 whitespace-nowrap text-sm font-semibold text-[var(--mk-night)]"
        >
          <span className="h-2 w-2 rounded-full bg-[var(--mk-live)]" aria-hidden />
          {f.headline ?? f.competition_name}
          <span className="font-normal opacity-70">· {f.competition_name}</span>
        </Link>
      ))}
    </div>
  );

  return (
    <section aria-label="Live right now" className="overflow-hidden bg-[var(--mk-lime)] py-2.5">
      <div className="mk-ticker flex w-max">
        {row(false)}
        {row(true)}
      </div>
    </section>
  );
}
```

```css
/* LIVE ticker marquee — duplicated row scrolls 50%; pause on hover/focus. */
.mk-ticker { animation: mk-ticker-scroll 28s linear infinite; }
.mk-ticker:hover,
.mk-ticker:focus-within { animation-play-state: paused; }
@keyframes mk-ticker-scroll { to { transform: translateX(-50%); } }
@media (prefers-reduced-motion: reduce) {
  .mk-ticker { animation: none; }
}
```

- [ ] **Step 4: Run test — expect 2 PASS**

Run: `npx vitest run src/components/marketing/__tests__/live-ticker.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add src/components/marketing/live-ticker.tsx src/components/marketing/__tests__/live-ticker.test.tsx src/app/globals.css
git commit -m "feat(marketing): lime LIVE ticker over real discovery fixtures"
```

---

### Task 7: The Draw — configurator + animated renderer

**Files:**
- Create: `src/components/marketing/draw-renderer.tsx`
- Create: `src/components/marketing/the-draw.tsx`
- Test: `src/components/marketing/__tests__/the-draw.test.tsx`

**Interfaces:**
- Consumes: `type PreviewPhase` from `@/server/usecases/stages`; `MARKETING_FORMATS`, `MARKETING_FORMAT_LABELS`, `type MarketingFormat` from `@/lib/marketing/format-preview`; `clubNames` from `@/lib/marketing/club-names`; `Reveal` from `./reveal`.
- Produces: `<TheDraw initialPhases={PreviewPhase[]} />` client component (initial = SSR groups-knockout/8 — the no-JS fallback); `<DrawRenderer phases names />` presentational. CTA link `data-testid="make-it-real"` → `/start?sport=Badminton&entrants={n}&format={format}`.
- Engine phases label entrants `A`, `B`, `C`… (`alphaLabel`) and later stages `Seed 1…`; `DrawRenderer` maps single-letter labels to generated club names and leaves every other token (`Seed 1`, `Winner of R1 #2`) untouched.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/marketing/__tests__/the-draw.test.tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TheDraw } from "../the-draw";
import type { PreviewPhase } from "@/server/usecases/stages";

const groupsPhases: PreviewPhase[] = [
  { title: "Group stage", sections: [{ title: "Pool A", matches: [{ home: "A", away: "B" }] }] },
  { title: "Knockout", sections: [{ title: "Semi-finals", matches: [{ home: "Seed 1", away: "Seed 4" }] }] },
];
const leaguePhases: PreviewPhase[] = [
  { title: "League", sections: [{ title: "Round 1", matches: [{ home: "A", away: "B" }] }] },
];

afterEach(() => vi.unstubAllGlobals());

describe("TheDraw", () => {
  it("renders the SSR draw immediately with club names substituted for A/B", () => {
    render(<TheDraw initialPhases={groupsPhases} />);
    expect(screen.getByText("Pool A")).toBeTruthy();
    // Single-letter engine labels are replaced by club names:
    expect(screen.queryByText(/^A$/)).toBeNull();
    // Non-letter tokens pass through:
    expect(screen.getByText(/Seed 1/)).toBeTruthy();
  });

  it("fetches and re-renders when the format changes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ phases: leaguePhases }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TheDraw initialPhases={groupsPhases} />);
    fireEvent.click(screen.getByRole("radio", { name: "League" }));
    await waitFor(() => expect(screen.getByText("Round 1")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/public/format-preview",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ format: "league", entrants: 8 });
  });

  it("CTA carries format and entrants into /start", () => {
    render(<TheDraw initialPhases={groupsPhases} />);
    expect(screen.getByTestId("make-it-real").getAttribute("href")).toBe(
      "/start?sport=Badminton&entrants=8&format=groups-knockout",
    );
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (module not found)**

Run: `npx vitest run src/components/marketing/__tests__/the-draw.test.tsx`

- [ ] **Step 3: Implement the renderer**

```tsx
// src/components/marketing/draw-renderer.tsx
import type { PreviewPhase } from "@/server/usecases/stages";
import { Reveal } from "./reveal";

/** Animated PreviewPhase renderer for marketing surfaces (design/v3/12 §4.4).
 *  The existing FormatPreviewView stays untouched for /help + the wizard.
 *  Single-letter engine labels (A…P) become generated club names; every other
 *  token (Seed 1, Winner of R1 #2) is engine truth and passes through. */
export function DrawRenderer({ phases, names }: { phases: PreviewPhase[]; names: string[] }) {
  const nameFor = (token: string) => {
    if (/^[A-Z]$/.test(token)) {
      const idx = token.charCodeAt(0) - 65;
      return names[idx] ?? token;
    }
    return token;
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {phases.map((phase, pi) => (
        <div key={phase.title + pi}>
          <h3 className="mk-display mb-2 text-lg font-semibold text-purple-950">{phase.title}</h3>
          {phase.note ? <p className="text-sm text-slate-500">{phase.note}</p> : null}
          <div className="space-y-4">
            {phase.sections.map((s) => (
              <Reveal key={s.title} className="rounded-xl border border-purple-100 bg-white p-4">
                <p className="label mb-2 text-xs">{s.title}</p>
                <ul className="space-y-1.5">
                  {s.matches.map((m, i) => (
                    <li
                      key={i}
                      className="mk-draw-row flex items-center justify-between rounded-lg bg-[var(--mk-light-violet)] px-3 py-1.5 text-sm text-slate-800"
                      style={{ animationDelay: `${i * 60}ms` }}
                    >
                      <span className="truncate">{nameFor(m.home)}</span>
                      <span className="mx-2 text-xs text-purple-400">vs</span>
                      <span className="truncate text-right">{nameFor(m.away)}</span>
                    </li>
                  ))}
                </ul>
              </Reveal>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

```css
/* Draw rows cascade in when their section reveals. */
.mk-in .mk-draw-row { animation: mk-rise 0.4s cubic-bezier(0.22, 1.2, 0.36, 1) both; }
@media (prefers-reduced-motion: reduce) {
  .mk-in .mk-draw-row { animation: none; }
}
```

- [ ] **Step 4: Implement the configurator**

```tsx
// src/components/marketing/the-draw.tsx
"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import type { PreviewPhase } from "@/server/usecases/stages";
import {
  MARKETING_FORMATS,
  MARKETING_FORMAT_LABELS,
  type MarketingFormat,
} from "@/lib/marketing/format-preview";
import { clubNames } from "@/lib/marketing/club-names";
import { DrawRenderer } from "./draw-renderer";

/** The Draw (design/v3/12 §4.4): the visitor's first real interaction. SSR
 *  passes the default groups-knockout/8 draw so the section works without JS;
 *  control changes hit the public preview API. */
export function TheDraw({ initialPhases }: { initialPhases: PreviewPhase[] }) {
  const [format, setFormat] = useState<MarketingFormat>("groups-knockout");
  const [entrants, setEntrants] = useState(8);
  const [seed, setSeed] = useState(1);
  const [phases, setPhases] = useState(initialPhases);
  const [busy, setBusy] = useState(false);
  const reqId = useRef(0);

  const names = useMemo(() => clubNames(entrants, seed), [entrants, seed]);

  async function load(nextFormat: MarketingFormat, nextEntrants: number) {
    const id = ++reqId.current;
    setBusy(true);
    try {
      const res = await fetch("/api/public/format-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ format: nextFormat, entrants: nextEntrants }),
      });
      if (!res.ok) return; // keep the last good draw
      const json = (await res.json()) as { phases: PreviewPhase[] };
      if (id === reqId.current) setPhases(json.phases);
    } catch {
      // network hiccough: last good draw stays on screen
    } finally {
      if (id === reqId.current) setBusy(false);
    }
  }

  const pick = (f: MarketingFormat) => {
    setFormat(f);
    void load(f, entrants);
  };
  const step = (delta: number) => {
    const n = Math.min(Math.max(entrants + delta, 4), 16);
    if (n === entrants) return;
    setEntrants(n);
    void load(format, n);
  };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div role="radiogroup" aria-label="Format" className="flex rounded-xl border border-purple-200 bg-white p-1">
          {MARKETING_FORMATS.map((f) => (
            <button
              key={f}
              role="radio"
              aria-checked={format === f}
              onClick={() => pick(f)}
              className={`mk-display rounded-lg px-3 py-1.5 text-sm font-semibold ${
                format === f ? "bg-[var(--mk-purple)] text-white" : "text-slate-600 hover:bg-purple-50"
              }`}
            >
              {MARKETING_FORMAT_LABELS[f]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-xl border border-purple-200 bg-white">
            <button aria-label="Fewer entrants" onClick={() => step(-1)} className="px-3 py-1.5 text-lg text-purple-600">
              −
            </button>
            <span aria-live="polite" className="mk-display w-16 text-center text-sm font-semibold text-slate-800">
              {entrants} teams
            </span>
            <button aria-label="More entrants" onClick={() => step(1)} className="px-3 py-1.5 text-lg text-purple-600">
              +
            </button>
          </div>
          <button onClick={() => setSeed((s) => s + 1)} className="btn btn-ghost text-sm">
            ⟳ Shuffle names
          </button>
        </div>
      </div>

      <div aria-busy={busy}>
        <DrawRenderer phases={phases} names={names} />
      </div>

      <p className="mt-8 text-center">
        <Link
          data-testid="make-it-real"
          href={`/start?sport=Badminton&entrants=${entrants}&format=${format}`}
          className="btn btn-primary px-6 py-2.5 text-base"
        >
          Make it real →
        </Link>
      </p>
    </div>
  );
}
```

Note: `/start` reads `sport`/`entrants` today (see `StartFunnelForm.go()`); the extra `format` param is forward-compatible and harmless — verify `/start` ignores unknown params (it does: it reads specific keys).

- [ ] **Step 5: Run test — expect 3 PASS**

Run: `npx vitest run src/components/marketing/__tests__/the-draw.test.tsx`

- [ ] **Step 6: Commit**

```bash
git add src/components/marketing/the-draw.tsx src/components/marketing/draw-renderer.tsx src/components/marketing/__tests__/the-draw.test.tsx src/app/globals.css
git commit -m "feat(marketing): The Draw configurator over the real fixture engine"
```

---

### Task 8: Matchday tools, Also-in-the-kit, motif dividers

**Files:**
- Create: `src/components/marketing/matchday-tools.tsx`
- Create: `src/components/marketing/motif-divider.tsx`
- Test: `src/components/marketing/__tests__/matchday-tools.test.tsx`

**Interfaces:**
- Produces: `<MatchdayTools />` (three animated cards; the scheduling card is a `<Link href="/scheduling">`), `<AlsoInTheKit />` (same file — icon row), `<MotifDivider kind="shuttle" | "knight" />`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/marketing/__tests__/matchday-tools.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MatchdayTools, AlsoInTheKit } from "../matchday-tools";

describe("MatchdayTools", () => {
  it("renders the three product cards, scheduling links to /scheduling", () => {
    render(<MatchdayTools />);
    expect(screen.getByText("Live scoring")).toBeTruthy();
    expect(screen.getByText("Standings")).toBeTruthy();
    const sched = screen.getByRole("link", { name: /scheduling board/i });
    expect(sched.getAttribute("href")).toBe("/scheduling");
  });
  it("kit row covers the remaining features", () => {
    render(<AlsoInTheKit />);
    for (const label of ["Registration & entry fees", "Print & slideshow", "Roles & scorer seats", "Secure by default"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run it — expect FAIL, then implement**

```tsx
// src/components/marketing/matchday-tools.tsx
import Link from "next/link";
import { Reveal } from "./reveal";

/** Matchday tools (design/v3/12 §4.5): three product-real cards, each with a
 *  tiny once-on-view animation. Replaces the emoji feature grid. */
export function MatchdayTools() {
  return (
    <div className="grid gap-6 sm:grid-cols-3">
      <Reveal className="card p-5">
        <div className="mb-3 rounded-lg bg-[var(--mk-night)] p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="mk-display font-semibold text-[var(--mk-cream)]">Falcons</span>
            <span className="mk-odometer mk-display inline-block overflow-hidden font-bold tabular-nums text-[var(--mk-lime)]">
              <span className="mk-odometer-reel inline-flex flex-col leading-none">
                <span>19</span><span>20</span><span>21</span>
              </span>
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between text-xs">
            <span className="mk-display font-semibold text-[var(--mk-cream)]">Comets</span>
            <span className="mk-display font-bold tabular-nums text-[var(--mk-cream)]">18</span>
          </div>
        </div>
        <h3 className="mb-1 font-semibold text-slate-800">Live scoring</h3>
        <p className="text-sm text-slate-500">
          Point-by-point from any phone. The public scoreboard updates the moment a rally ends.
        </p>
      </Reveal>

      <Reveal>
        <Link href="/scheduling" aria-label="Scheduling board" className="card block h-full p-5 transition hover:border-purple-300 hover:shadow-md">
          <div className="mb-3 space-y-1.5 rounded-lg bg-[var(--mk-night)] p-3">
            {[0, 1, 2].map((lane) => (
              <div key={lane} className="relative h-3.5 overflow-hidden rounded bg-[#241650]">
                <span
                  className="mk-lane-block absolute inset-y-0.5 rounded-sm bg-[var(--mk-purple)]"
                  style={{ left: `${8 + lane * 14}%`, width: "26%", animationDelay: `${lane * 150}ms` }}
                />
              </div>
            ))}
          </div>
          <h3 className="mb-1 font-semibold text-slate-800">Scheduling board</h3>
          <p className="text-sm text-slate-500">
            Courts × time slots on one board. Clashes flagged before you publish. →
          </p>
        </Link>
      </Reveal>

      <Reveal className="card p-5">
        <div className="mb-3 rounded-lg bg-[var(--mk-night)] p-3 text-xs">
          <div className="mk-swap-a flex justify-between text-[var(--mk-cream)]"><span>Riverside Aces</span><span className="tabular-nums">7 pts</span></div>
          <div className="mk-swap-b flex justify-between text-[var(--mk-cream)] opacity-80"><span>Oakwood Foxes</span><span className="tabular-nums">7 pts</span></div>
        </div>
        <h3 className="mb-1 font-semibold text-slate-800">Standings</h3>
        <p className="text-sm text-slate-500">
          Tables recompute the second a result lands — tie-breaks included.
        </p>
      </Reveal>
    </div>
  );
}

const KIT = [
  { label: "Registration & entry fees", body: "Public sign-up with capacity, waitlists and Stripe fees to your club." },
  { label: "Print & slideshow", body: "Brackets and standings for the noticeboard or the TV." },
  { label: "Roles & scorer seats", body: "Owners, admins, viewers, courtside scorer hand-off links." },
  { label: "Secure by default", body: "Per-tenant isolation, HSTS, CSRF protection out of the box." },
];

export function AlsoInTheKit() {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {KIT.map((k) => (
        <li key={k.label} className="text-sm">
          <p className="font-semibold text-slate-800">{k.label}</p>
          <p className="text-slate-500">{k.body}</p>
        </li>
      ))}
    </ul>
  );
}
```

```tsx
// src/components/marketing/motif-divider.tsx
import { Reveal } from "./reveal";

/** The page's only two decorative motions (design/v3/12 §4.6): a shuttle arc
 *  and a chess-knight L-hop, each < 1.2s, once, on scroll. */
export function MotifDivider({ kind }: { kind: "shuttle" | "knight" }) {
  return (
    <Reveal aria-hidden className="pointer-events-none mx-auto h-12 max-w-5xl overflow-hidden px-4">
      {kind === "shuttle" ? (
        <svg viewBox="0 0 800 48" className="h-full w-full">
          <g className="mk-shuttle">
            <path d="M0 6 l14 10 -14 10 5 -10z" fill="var(--mk-purple)" stroke="#1e1b2e" strokeWidth="2" />
          </g>
        </svg>
      ) : (
        <svg viewBox="0 0 800 48" className="h-full w-full">
          <g className="mk-knight">
            <path d="M8 34 q2 -14 12 -18 q-2 -6 4 -8 q8 -2 10 6 q8 4 6 14 l-4 6z" fill="var(--mk-purple)" stroke="#1e1b2e" strokeWidth="2" />
          </g>
        </svg>
      )}
    </Reveal>
  );
}
```

```css
/* Motif dividers: play only after their Reveal adds .mk-in. */
.mk-in .mk-shuttle { animation: mk-shuttle-arc 1.1s cubic-bezier(0.3, 0, 0.3, 1) both; }
@keyframes mk-shuttle-arc {
  0% { transform: translate(0, 34px) rotate(-8deg); }
  50% { transform: translate(390px, 0px) rotate(0deg); }
  100% { transform: translate(780px, 30px) rotate(8deg); }
}
.mk-in .mk-knight { animation: mk-knight-hop 1s cubic-bezier(0.3, 0, 0.2, 1.2) both; }
@keyframes mk-knight-hop {
  0% { transform: translate(330px, 6px); }
  45% { transform: translate(330px, 6px) translateY(-10px); }
  55% { transform: translate(410px, -4px); }
  100% { transform: translate(410px, 26px); }
}
@media (prefers-reduced-motion: reduce) {
  .mk-in .mk-shuttle, .mk-in .mk-knight { animation: none; }
}
/* Matchday tools micro-animations */
.mk-in .mk-lane-block { animation: mk-lane-in 0.5s cubic-bezier(0.22, 1.2, 0.36, 1) both; }
@keyframes mk-lane-in { from { opacity: 0; transform: translateX(-24px); } }
.mk-odometer { height: 1em; }
.mk-in .mk-odometer-reel { animation: mk-odometer-roll 0.9s 0.3s cubic-bezier(0.3, 0, 0.2, 1) both; }
@keyframes mk-odometer-roll { to { transform: translateY(-2em); } }
.mk-in .mk-swap-a { animation: mk-swap-down 0.7s 0.4s ease both; }
.mk-in .mk-swap-b { animation: mk-swap-up 0.7s 0.4s ease both; }
@keyframes mk-swap-down { to { transform: translateY(1.1em); } }
@keyframes mk-swap-up { to { transform: translateY(-1.1em); } }
@media (prefers-reduced-motion: reduce) {
  .mk-in .mk-lane-block, .mk-in .mk-odometer-reel, .mk-in .mk-swap-a, .mk-in .mk-swap-b { animation: none; }
}
```

- [ ] **Step 3: Run test — expect 2 PASS**

Run: `npx vitest run src/components/marketing/__tests__/matchday-tools.test.tsx`

- [ ] **Step 4: Commit**

```bash
git add src/components/marketing/matchday-tools.tsx src/components/marketing/motif-divider.tsx src/components/marketing/__tests__/matchday-tools.test.tsx src/app/globals.css
git commit -m "feat(marketing): matchday tool cards, kit row, two motif dividers"
```

---

### Task 9: Marketing shell — Barlow mount, nav variant, night footer, dark funnel form

**Files:**
- Create: `src/components/marketing/marketing-shell.tsx`
- Modify: `src/components/marketing-nav.tsx` (add `variant` prop + scroll behavior)
- Create: `src/components/marketing/nav-scroll.tsx` (tiny client observer for the transparent→solid flip)
- Modify: `src/components/marketing-footer.tsx` (night restyle + new links)
- Modify: `src/components/start-funnel-form.tsx` (add `variant?: "light" | "night"`)
- Test: `src/components/marketing/__tests__/marketing-shell.test.tsx`

**Interfaces:**
- Produces: `<MarketingShell variant="night-scroll" | "light">{children}</MarketingShell>` — mounts Barlow Condensed as `--mk-font-display`, renders `<MarketingNav variant>` + children + `<MarketingFooter>`; `MarketingNav({ variant = "light" })`; `StartFunnelForm({ compact?, variant? })` — night variant restyles only (same fields, same `go()`, same `data-start-funnel`).
- Nav flip contract: the nav element carries `data-mk-nav`; while an element with `id="mk-hero-sentinel"` is on screen the nav has class `mk-nav-night`, after it leaves it has `mk-nav-solid` (used by e2e).

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/marketing/__tests__/marketing-shell.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarketingFooter } from "@/components/marketing-footer";
import { StartFunnelForm } from "@/components/start-funnel-form";

describe("marketing shell pieces", () => {
  it("footer links the new product pages", () => {
    render(<MarketingFooter />);
    expect(screen.getByRole("link", { name: "Formats" }).getAttribute("href")).toBe("/formats");
    expect(screen.getByRole("link", { name: "Scheduling" }).getAttribute("href")).toBe("/scheduling");
    expect(screen.getByRole("link", { name: "Live now" }).getAttribute("href")).toBe("/discover");
  });
  it("funnel night variant keeps the funnel contract", () => {
    const { container } = render(<StartFunnelForm variant="night" />);
    const form = container.querySelector("form[data-start-funnel]");
    expect(form).toBeTruthy();
    expect(form!.className).toContain("mk-funnel-night");
  });
});
```

Note: `MarketingNav` is an async server component (it calls `getCurrentUser`) — don't render it in vitest; its variant behavior is covered by e2e in Task 10.

- [ ] **Step 2: Run it — expect FAIL, then implement**

`MarketingShell`:

```tsx
// src/components/marketing/marketing-shell.tsx
// Marketing display face: same Barlow Condensed config as the public tree
// (see src/app/slideshow/layout.tsx) but on its own --mk-font-display var so
// the --ps-* public theme layer stays untouched.
import { Barlow_Condensed } from "next/font/google";
import { MarketingNav } from "@/components/marketing-nav";
import { MarketingFooter } from "@/components/marketing-footer";

const displayFont = Barlow_Condensed({
  weight: ["500", "600", "700"],
  subsets: ["latin"],
  variable: "--mk-font-display",
});

export function MarketingShell({
  variant = "light",
  children,
}: {
  variant?: "night-scroll" | "light";
  children: React.ReactNode;
}) {
  return (
    <div className={displayFont.variable}>
      <MarketingNav variant={variant} />
      {children}
      <MarketingFooter />
    </div>
  );
}
```

`nav-scroll.tsx` (client helper the nav renders when `variant="night-scroll"`):

```tsx
// src/components/marketing/nav-scroll.tsx
"use client";

import { useEffect } from "react";

/** Flips the nav from night (over the hero) to solid once #mk-hero-sentinel
 *  leaves the viewport. The nav itself stays a server component. */
export function NavScrollFlip() {
  useEffect(() => {
    const nav = document.querySelector("[data-mk-nav]");
    const sentinel = document.getElementById("mk-hero-sentinel");
    if (!nav || !sentinel) return;
    const io = new IntersectionObserver(([entry]) => {
      const overHero = Boolean(entry?.isIntersecting);
      nav.classList.toggle("mk-nav-night", overHero);
      nav.classList.toggle("mk-nav-solid", !overHero);
    });
    io.observe(sentinel);
    return () => io.disconnect();
  }, []);
  return null;
}
```

`marketing-nav.tsx` — keep the current auth logic and links block, change the wrapper and add links. Full replacement:

```tsx
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { NavScrollFlip } from "@/components/marketing/nav-scroll";

const LINKS = [
  { label: "Formats", href: "/formats" },
  { label: "Scheduling", href: "/scheduling" },
  { label: "Pricing", href: "/pricing" },
  { label: "Use cases", href: "/use-cases/clubs" },
];

/** Marketing nav (design/v3/12 §4.1). `night-scroll` starts transparent over
 *  the night hero and flips solid when the hero scrolls out; `light` is the
 *  solid style permanently (all non-home marketing pages). */
export async function MarketingNav({ variant = "light" }: { variant?: "night-scroll" | "light" }) {
  const user = await getCurrentUser().catch(() => null);
  const night = variant === "night-scroll";
  return (
    <header
      data-mk-nav
      className={`sticky top-0 z-40 ${night ? "mk-nav mk-nav-night" : "mk-nav mk-nav-solid"}`}
    >
      {night ? <NavScrollFlip /> : null}
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link href="/" className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-wide.png" alt="Seazn Club" className="mk-nav-logo h-9 w-auto" />
        </Link>
        <nav className="flex items-center gap-1 sm:gap-2">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="mk-nav-link hidden rounded-lg px-3 py-1.5 text-sm md:inline-flex">
              {l.label}
            </Link>
          ))}
          {user ? (
            <Link href="/dashboard" className="btn btn-primary text-sm">
              Dashboard →
            </Link>
          ) : (
            <>
              <Link href="/login" className="mk-nav-link btn btn-ghost text-sm">
                Log in
              </Link>
              <Link href="/login?tab=signup" className="mk-nav-cta btn text-sm font-semibold">
                Start free
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
```

```css
/* Nav variants — one component, class-flipped by NavScrollFlip. */
.mk-nav { transition: background-color 0.25s ease, border-color 0.25s ease; }
.mk-nav-solid { background: rgb(255 255 255 / 0.9); border-bottom: 1px solid #f3e8ff; backdrop-filter: blur(8px); }
.mk-nav-solid .mk-nav-link { color: #475069; }
.mk-nav-solid .mk-nav-link:hover { background: #faf5ff; color: #7e22ce; }
.mk-nav-solid .mk-nav-cta { background: var(--mk-purple); color: #fff; }
.mk-nav-night { background: transparent; border-bottom: 1px solid transparent; }
.mk-nav-night .mk-nav-link { color: var(--mk-cream); opacity: 0.85; }
.mk-nav-night .mk-nav-link:hover { opacity: 1; background: rgb(245 240 232 / 0.08); }
.mk-nav-night .mk-nav-cta { background: var(--mk-lime); color: var(--mk-night); }
.mk-nav-night .mk-nav-logo { filter: brightness(0) invert(1); }
/* Dark funnel form variant */
.mk-funnel-night { border-color: #3b2a6e; background: rgb(26 15 62 / 0.75); }
.mk-funnel-night .label { color: #b7aede; }
.mk-funnel-night .input { background: #241650; border-color: #3b2a6e; color: var(--mk-cream); }
.mk-funnel-night .btn-primary,
.mk-funnel-night button[type="submit"] { background: var(--mk-lime); color: var(--mk-night); }
```

`start-funnel-form.tsx` — signature + className only (logic untouched):

```tsx
export function StartFunnelForm({
  compact = false,
  variant = "light",
}: {
  compact?: boolean;
  variant?: "light" | "night";
}) {
```

…and the form className becomes:

```tsx
className={`mx-auto flex w-full max-w-2xl flex-col gap-2 sm:flex-row sm:items-end ${
  compact ? "" : "rounded-2xl border p-3 shadow-sm backdrop-blur"
} ${variant === "night" ? "mk-funnel-night" : compact ? "" : "border-purple-200 bg-white/80"}`}
```

`marketing-footer.tsx` — full replacement (keep `CookieSettingsButton`):

```tsx
import Link from "next/link";
import { CookieSettingsButton } from "@/components/cookie-settings-button";

const COLS: Array<{ head: string; links: Array<{ label: string; href: string }> }> = [
  {
    head: "Product",
    links: [
      { label: "Formats", href: "/formats" },
      { label: "Scheduling", href: "/scheduling" },
      { label: "Pricing", href: "/pricing" },
      { label: "Live now", href: "/discover" },
    ],
  },
  {
    head: "Who it's for",
    links: [
      { label: "Sports clubs", href: "/use-cases/clubs" },
      { label: "Tournaments & events", href: "/use-cases/events" },
      { label: "Schools & youth", href: "/use-cases/schools" },
    ],
  },
  {
    head: "Developers",
    links: [
      { label: "API reference", href: "/developers/reference" },
      { label: "Guides", href: "/developers/guides" },
      { label: "Changelog", href: "/developers/changelog" },
      { label: "Help centre", href: "/help" },
    ],
  },
  {
    head: "Legal",
    links: [
      { label: "Privacy", href: "/legal/privacy" },
      { label: "Terms", href: "/legal/terms" },
      { label: "Cookie policy", href: "/legal/cookie-policy" },
      { label: "DPA", href: "/legal/dpa" },
      { label: "Sub-processors", href: "/legal/sub-processors" },
    ],
  },
];

/** Night footer (design/v3/12 §4.9) — closes the matchday arc. */
export function MarketingFooter() {
  return (
    <footer className="bg-[var(--mk-night)]">
      <div className="mx-auto max-w-6xl px-4 py-12">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {COLS.map((col) => (
            <div key={col.head}>
              <p className="mk-display mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--mk-cream)]">
                {col.head}
              </p>
              <ul className="space-y-2 text-sm">
                {col.links.map((l) => (
                  <li key={l.href}>
                    <Link href={l.href} className="text-[#8d7fc0] hover:text-[var(--mk-lime)]">
                      {l.label}
                    </Link>
                  </li>
                ))}
                {col.head === "Legal" ? (
                  <li>
                    <CookieSettingsButton className="text-[#8d7fc0] hover:text-[var(--mk-lime)]" />
                  </li>
                ) : null}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-10 flex flex-col items-center justify-between gap-2 border-t border-[#2b1d5c] pt-6 text-xs text-[#6a5da0] sm:flex-row">
          <span>© {new Date().getFullYear()} Seazn Club. All rights reserved.</span>
          <span className="mk-display tracking-[0.2em]">ANY SPORT · LIVE IN MINUTES</span>
        </div>
      </div>
    </footer>
  );
}
```

- [ ] **Step 3: Run tests + typecheck**

Run: `npx vitest run src/components/marketing/__tests__/marketing-shell.test.tsx && npx tsc -p . --noEmit`
Expected: PASS + clean. (Other pages render `MarketingNav` with no props — the default keeps them compiling.)

- [ ] **Step 4: Commit**

```bash
git add src/components/marketing/marketing-shell.tsx src/components/marketing/nav-scroll.tsx src/components/marketing-nav.tsx src/components/marketing-footer.tsx src/components/start-funnel-form.tsx src/components/marketing/__tests__/marketing-shell.test.tsx src/app/globals.css
git commit -m "feat(marketing): shell with Barlow mount, night nav variant, night footer"
```

---

### Task 10: Home page assembly + retirements + home e2e

**Files:**
- Modify: `src/app/page.tsx` (full rewrite of the JSX; keep metadata, auth redirect, fail-soft fetches)
- Delete: `src/components/hero-fixture-demo.tsx`
- Test: `e2e/marketing-home.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–9; `getDiscoveryLive`, `getDiscoveryThisWeek` from `@/server/public-site/discovery`; `ThisWeekSection` from `@/components/discovery-cards`; `marketingPreview` (server-side default draw); `preferredCurrency` from `@/lib/currency-server`.
- Produces: the shipped home page. Section ids used by e2e: `#the-draw`, `#mk-hero-sentinel`.

- [ ] **Step 1: Rewrite `src/app/page.tsx`**

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getDiscoveryLive, getDiscoveryThisWeek } from "@/server/public-site/discovery";
import { ThisWeekSection } from "@/components/discovery-cards";
import { StartFunnelForm } from "@/components/start-funnel-form";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { HeroVignette } from "@/components/marketing/hero-vignette";
import { LiveTicker } from "@/components/marketing/live-ticker";
import { TheDraw } from "@/components/marketing/the-draw";
import { MatchdayTools, AlsoInTheKit } from "@/components/marketing/matchday-tools";
import { MotifDivider } from "@/components/marketing/motif-divider";
import { TicketStubs } from "@/components/marketing/ticket-stubs";
import { marketingPreview } from "@/lib/marketing/format-preview";
import { preferredCurrency } from "@/lib/currency-server";

export const metadata: Metadata = {
  title: "Seazn Club — Run multi-sport community tournaments",
  description:
    "Leagues, groups, knockouts — run any format for any sport in minutes, with online registration and entry fees built in. Free for community clubs.",
  openGraph: {
    title: "Seazn Club",
    description: "Run multi-sport community tournaments from setup to trophy in minutes.",
    url: "https://seazn.club",
    siteName: "Seazn Club",
    type: "website",
  },
};

const AUDIENCES = [
  {
    title: "Sports clubs & academies",
    body: "Weekly round-robins, internal ladders, seasonal championships. One org, all your sports.",
    href: "/use-cases/clubs",
  },
  {
    title: "One-day events",
    body: "Open tournaments, charity cups, local derbies. Set up in 5 minutes, run all day smoothly.",
    href: "/use-cases/events",
  },
  {
    title: "Schools & youth programs",
    body: "Inter-house competitions, lunchtime leagues, end-of-term championships. Kids love the live scoreboard.",
    href: "/use-cases/schools",
  },
];

export default async function HomePage() {
  const user = await getCurrentUser().catch(() => null);
  if (user) redirect("/dashboard");

  // Fail-soft: DB may be unreachable at build (same contract as before).
  const [liveNow, thisWeek, currency] = await Promise.all([
    getDiscoveryLive().catch(() => []),
    getDiscoveryThisWeek().catch(() => []),
    preferredCurrency().catch(() => "USD" as const),
  ]);
  // SSR default draw = the configurator's no-JS fallback (design/v3/12 §4.4).
  const defaultDraw = marketingPreview("groups-knockout", 8);

  return (
    <MarketingShell variant="night-scroll">
      <main>
        {/* Hero — stadium night */}
        <section className="relative -mt-16 overflow-hidden bg-[linear-gradient(180deg,var(--mk-night-2),var(--mk-night))] pb-16 pt-28 text-[var(--mk-cream)]">
          <div aria-hidden className="pointer-events-none absolute -top-1/3 left-[-8%] h-[130%] w-[45%] rotate-12 bg-[radial-gradient(ellipse_at_top,rgba(163,230,53,0.10),transparent_65%)]" />
          <div aria-hidden className="pointer-events-none absolute -top-1/3 right-[-8%] h-[130%] w-[45%] -rotate-12 bg-[radial-gradient(ellipse_at_top,rgba(163,230,53,0.10),transparent_65%)]" />
          <div id="mk-hero-sentinel" aria-hidden className="absolute inset-x-0 top-0 h-[70%]" />
          <div className="relative mx-auto grid max-w-6xl items-center gap-10 px-4 lg:grid-cols-[1.1fr_0.9fr]">
            <div>
              <p className="mk-display text-xs font-semibold tracking-[0.22em] text-[var(--mk-lime)]">
                FREE FOR COMMUNITY CLUBS
              </p>
              <h1 className="mk-display mt-3 max-w-xl text-5xl font-bold leading-[0.95] sm:text-7xl">
                Any sport. Live in minutes.
              </h1>
              <p className="mt-4 max-w-md text-base text-[#b7aede]">
                Cricket, football, badminton, chess — name the sport and the field, Seazn Club
                draws the fixtures and puts your scoreboard live.
              </p>
              <div className="mt-8">
                <StartFunnelForm variant="night" />
              </div>
              <p className="mt-4 text-xs text-[#8d7fc0]">
                Free forever for small clubs ·{" "}
                <Link href="/pricing" className="underline hover:text-[var(--mk-lime)]">
                  Upgrade a single event or go Pro
                </Link>
              </p>
            </div>
            <div className="justify-self-center">
              <HeroVignette />
            </div>
          </div>
        </section>

        <LiveTicker fixtures={liveNow} />

        {/* The Draw */}
        <section id="the-draw" className="bg-[var(--mk-light-violet)] py-20">
          <div className="mx-auto max-w-5xl px-4">
            <h2 className="mk-display mb-2 text-center text-4xl font-bold text-purple-950">The Draw</h2>
            <p className="mb-10 text-center text-slate-500">
              Pick a format, set the field — the real fixture engine draws it. No account needed.
            </p>
            <TheDraw initialPhases={defaultDraw} />
          </div>
        </section>

        <MotifDivider kind="shuttle" />

        {/* Matchday tools */}
        <section className="mx-auto max-w-5xl px-4 pb-20 pt-4">
          <h2 className="mk-display mb-2 text-center text-4xl font-bold text-purple-950">Matchday tools</h2>
          <p className="mb-10 text-center text-slate-500">The three jobs every organiser runs on the day.</p>
          <MatchdayTools />
          <div className="mt-12 border-t border-purple-100 pt-8">
            <AlsoInTheKit />
          </div>
        </section>

        <MotifDivider kind="knight" />

        {/* Who plays here */}
        <section className="bg-[var(--mk-light-warm)] py-16">
          <div className="mx-auto max-w-5xl px-4">
            <h2 className="mk-display mb-8 text-center text-4xl font-bold text-purple-950">Who plays here</h2>
            <div className="grid gap-6 sm:grid-cols-3">
              {AUDIENCES.map((c) => (
                <Link key={c.href} href={c.href} className="card block p-6 transition hover:border-purple-300 hover:shadow-md">
                  <h3 className="mk-display mb-1 text-lg font-semibold text-slate-800">{c.title}</h3>
                  <p className="text-sm text-slate-500">{c.body}</p>
                  <p className="mt-3 text-xs font-semibold text-purple-600">Learn more →</p>
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* Playing this week (collapses when empty) */}
        <ThisWeekSection entries={thisWeek} />

        {/* Floodlit finale — pricing + CTA in one night block */}
        <section className="relative overflow-hidden bg-[linear-gradient(180deg,var(--mk-night-2),var(--mk-night))] py-20 text-center">
          <div aria-hidden className="pointer-events-none absolute -top-1/3 left-[-8%] h-[130%] w-[45%] rotate-12 bg-[radial-gradient(ellipse_at_top,rgba(163,230,53,0.08),transparent_65%)]" />
          <div className="relative mx-auto max-w-5xl px-4">
            <p className="mk-display text-xs font-semibold tracking-[0.22em] text-[var(--mk-lime)]">
              FULL TIME · PICK YOUR SEASON
            </p>
            <h2 className="mk-display mb-2 mt-3 text-5xl font-bold text-[var(--mk-cream)]">Pick your season</h2>
            <p className="mb-10 text-sm text-[#b7aede]">
              Free for community clubs. One pass for the big day. Pro for the whole year.
            </p>
            <TicketStubs currency={currency} />
            <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
              <Link
                href="/start"
                className="mk-display rounded-xl bg-[var(--mk-lime)] px-8 py-3 text-base font-bold text-[var(--mk-night)]"
              >
                Start your tournament →
              </Link>
              <Link
                href="/login?tab=signup"
                className="rounded-xl border border-[#4a3885] px-6 py-3 text-sm text-[var(--mk-cream)]"
              >
                Create free account
              </Link>
            </div>
          </div>
        </section>
      </main>
    </MarketingShell>
  );
}
```

Then delete the retired component:

```bash
git rm src/components/hero-fixture-demo.tsx
```

If anything else imports it (`grep -rn "hero-fixture-demo\|HeroFixtureDemo" src/`), remove those imports too — only the old home page should match.

Check `preferredCurrency`'s exact signature in `src/lib/currency-server.ts` before wiring (it may need no `.catch`, or may take a cookies arg) and adjust the call — the invariant is "same currency the /pricing page would show".

- [ ] **Step 2: Write the home e2e**

```ts
// e2e/marketing-home.spec.ts
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// The home page redirects signed-in users to /dashboard — run signed out.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("marketing home (design/v3/12)", () => {
  test("default draw renders without any interaction", async ({ page }) => {
    await page.goto("/");
    const draw = page.locator("#the-draw");
    await expect(draw.getByText("Group stage")).toBeVisible();
    await expect(draw.getByText("Knockout")).toBeVisible();
    await expect(draw.getByText("vs").first()).toBeVisible();
  });

  test("format switch redraws via the public API", async ({ page }) => {
    await page.goto("/");
    const api = page.waitForResponse("**/api/public/format-preview");
    await page.getByRole("radio", { name: "League" }).click();
    expect((await api).status()).toBe(200);
    await expect(page.locator("#the-draw").getByText(/Round 1/).first()).toBeVisible();
  });

  test("Make it real carries choices into /start", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("make-it-real").click();
    await expect(page).toHaveURL(/\/start\?sport=Badminton&entrants=8&format=groups-knockout/);
  });

  test("hero funnel still routes to /start with sport + entrants", async ({ page }) => {
    await page.goto("/");
    await page.locator("form[data-start-funnel] button[type=submit]").click();
    await expect(page).toHaveURL(/\/start\?sport=/);
  });

  test("nav flips from night to solid after the hero", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("[data-mk-nav]")).toHaveClass(/mk-nav-night/);
    await page.locator("#the-draw").scrollIntoViewIfNeeded();
    await expect(page.locator("[data-mk-nav]")).toHaveClass(/mk-nav-solid/);
  });

  test("reduced motion renders end states", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(page.getByTestId("scorebug")).toBeVisible();
    await expect(page.locator("#the-draw").getByText("Group stage")).toBeVisible();
    await ctx.close();
  });

  test("axe: no serious/critical violations on / (v3/11 gap 11)", async ({ page }) => {
    await page.goto("/", { waitUntil: "load" });
    await page.waitForTimeout(400);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(blocking.map((v) => `${v.id} — ${v.nodes[0]?.html}`)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the gates**

```bash
npx tsc -p . --noEmit
npx vitest run
npx playwright test e2e/marketing-home.spec.ts   # from apps/web; dev server per playwright.config.ts
```
Expected: all green. If `/api/public/format-preview` 404s under the dev server after a restart, `rm -rf .next` first (known corrupt-cache gotcha).

- [ ] **Step 4: Visual check against the approved mocks**

Load `http://localhost:3000/` in the Playwright MCP browser, screenshot hero + finale, compare against `.superpowers/brainstorm/29719-1783809837/content/hero-a-refined.html` (night mood) and `batch3-finale.html`. Fix spacing/color drift now — this is the design gate, not a formality.

- [ ] **Step 5: Commit**

```bash
git add src/app/page.tsx e2e/marketing-home.spec.ts
git rm src/components/hero-fixture-demo.tsx
git commit -m "feat(marketing): matchday-arc home page

Night hero with object-relay vignette + dark funnel, lime LIVE
ticker, The Draw configurator (SSR default draw), matchday tool
cards, floodlit ticket-stub finale. Retires HeroFixtureDemo, the
emoji feature grid and the sports-chip strip (design/v3/12 §6)."
```

---

### Task 11: Scheduling board logic + component

**Files:**
- Create: `src/lib/marketing/board-logic.ts`
- Create: `src/components/marketing/scheduling-board.tsx`
- Test: `src/lib/marketing/__tests__/board-logic.test.ts`

**Interfaces:**
- Produces: pure `BoardState` machine — `createBoard(fixtures: string[], courts: number)`, `place(state, fixtureIdx, court): BoardState` (marks `clash: true` on a court holding 2+), `isFull(state)`, plus `type BoardState = { tray: string[]; courts: Array<{ placed: string[]; clash: boolean }> }`; `<SchedulingBoard />` client component — replay (attract mode) → interactive → publish, per design/v3/12 §5. Test ids: `data-testid="board-chip"` (tray chips), `data-testid="board-court-N"`, `data-testid="board-publish"`, `data-testid="board-player-view"`, `data-testid="board-status"`.
- Interaction: chips are buttons (keyboard: focus chip, Enter arms it, then court buttons place it — the tap fallback and the keyboard path are the same mechanism); pointer drag uses pointerdown/move/up with the same `place()` call at drop.

- [ ] **Step 1: Write the failing logic test**

```ts
// src/lib/marketing/__tests__/board-logic.test.ts
import { describe, expect, it } from "vitest";
import { createBoard, place, isFull } from "../board-logic";

const fixtures = ["Falcons v Comets", "Tigers v Rovers", "Aces v Smash"];

describe("board logic", () => {
  it("placing moves a fixture from tray to court", () => {
    const s1 = place(createBoard(fixtures, 3), 0, 1);
    expect(s1.tray).toEqual(["Tigers v Rovers", "Aces v Smash"]);
    expect(s1.courts[1]!.placed).toEqual(["Falcons v Comets"]);
    expect(s1.courts[1]!.clash).toBe(false);
  });
  it("two fixtures on one court is a clash", () => {
    const s = place(place(createBoard(fixtures, 3), 0, 0), 0, 0);
    expect(s.courts[0]!.placed).toHaveLength(2);
    expect(s.courts[0]!.clash).toBe(true);
  });
  it("board is full when the tray is empty and no clash", () => {
    let s = createBoard(fixtures, 3);
    s = place(s, 0, 0);
    s = place(s, 0, 1);
    expect(isFull(s)).toBe(false);
    s = place(s, 0, 2);
    expect(isFull(s)).toBe(true);
    const clashed = place(place(createBoard(fixtures.slice(0, 2), 2), 0, 0), 0, 0);
    expect(isFull(clashed)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL, then implement the logic**

```ts
// src/lib/marketing/board-logic.ts

/** Pure state for the /scheduling demo board (design/v3/12 §5). The clash
 *  rule is the concept the real board enforces (one court, one fixture at a
 *  time), kept client-side — no backend. */
export interface BoardState {
  tray: string[];
  courts: Array<{ placed: string[]; clash: boolean }>;
}

export function createBoard(fixtures: string[], courts: number): BoardState {
  return {
    tray: [...fixtures],
    courts: Array.from({ length: courts }, () => ({ placed: [], clash: false })),
  };
}

export function place(state: BoardState, fixtureIdx: number, court: number): BoardState {
  const fixture = state.tray[fixtureIdx];
  const target = state.courts[court];
  if (fixture === undefined || target === undefined) return state;
  const courts = state.courts.map((c, i) =>
    i === court
      ? { placed: [...c.placed, fixture], clash: c.placed.length + 1 > 1 }
      : c,
  );
  return { tray: state.tray.filter((_, i) => i !== fixtureIdx), courts };
}

export function isFull(state: BoardState): boolean {
  return state.tray.length === 0 && state.courts.every((c) => !c.clash);
}
```

- [ ] **Step 3: Run logic test — expect 3 PASS**

Run: `npx vitest run src/lib/marketing/__tests__/board-logic.test.ts`

- [ ] **Step 4: Implement the component**

```tsx
// src/components/marketing/scheduling-board.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createBoard, isFull, place, type BoardState } from "@/lib/marketing/board-logic";

const FIXTURES = ["Falcons v Comets", "Tigers v Rovers", "Aces v Smash"];
const COURTS = 3;

/** Attract-mode board (design/v3/12 §5): plays the matchday replay once,
 *  hands over to the visitor on first touch (or when the replay ends), and
 *  lights Publish when every fixture is placed clash-free. */
export function SchedulingBoard() {
  const [mode, setMode] = useState<"replay" | "play" | "published">("replay");
  const [board, setBoard] = useState<BoardState>(() => createBoard(FIXTURES, COURTS));
  const [armed, setArmed] = useState<number | null>(null); // tray index (keyboard/tap)
  const [status, setStatus] = useState("Drag a fixture onto a court — or tap a fixture, then a court.");
  const replayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Attract mode: skip straight to play under reduced motion; otherwise hand
  // over when the CSS replay (~3s) finishes or on first pointer/key contact.
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setMode("play");
      return;
    }
    replayTimer.current = setTimeout(() => setMode("play"), 3400);
    return () => {
      if (replayTimer.current) clearTimeout(replayTimer.current);
    };
  }, []);
  const takeover = () => {
    if (mode === "replay") {
      if (replayTimer.current) clearTimeout(replayTimer.current);
      setMode("play");
    }
  };

  function placeChip(fixtureIdx: number, court: number) {
    const next = place(board, fixtureIdx, court);
    setBoard(next);
    setArmed(null);
    if (next.courts[court]!.clash) {
      setStatus(`Clash! Two fixtures on Court ${court + 1} — the real board blocks publish until you fix it.`);
    } else if (next.tray.length === 0 && isFull(next)) {
      setStatus("Board full and clash-free — publish it.");
    } else {
      setStatus("Placed. Drop two on one court to see clash detection.");
    }
  }

  if (mode === "published") {
    return (
      <div data-testid="board-player-view" className="rounded-xl bg-[var(--mk-night)] p-6 text-center">
        <p className="mk-display text-xs tracking-[0.2em] text-[var(--mk-lime)]">PUBLISHED — WHAT PLAYERS SEE</p>
        <ul className="mx-auto mt-4 max-w-sm space-y-2 text-left">
          {board.courts.map((c, i) =>
            c.placed.map((f) => (
              <li key={f} className="flex justify-between rounded-lg bg-[#241650] px-3 py-2 text-sm text-[var(--mk-cream)]">
                <span>{f}</span>
                <span className="mk-display text-[var(--mk-lime)]">Court {i + 1}</span>
              </li>
            )),
          )}
        </ul>
        <Link href="/start" className="mk-display mt-6 inline-block rounded-xl bg-[var(--mk-lime)] px-6 py-2.5 font-bold text-[var(--mk-night)]">
          Run your matchday →
        </Link>
      </div>
    );
  }

  return (
    <div onPointerDown={takeover} onKeyDown={takeover}>
      {mode === "replay" ? (
        <div className="mk-board-replay rounded-xl bg-[var(--mk-night)] p-4" aria-hidden>
          <div className="space-y-2">
            {[0, 1, 2].map((lane) => (
              <div key={lane} className="relative h-8 overflow-hidden rounded-lg bg-[#241650]">
                <span className={`mk-replay-chip mk-replay-chip-${lane} absolute inset-y-1 rounded bg-[var(--mk-purple)]`} />
                {lane === 1 ? <span className="mk-replay-fix absolute inset-y-1 rounded bg-[var(--mk-lime)]" /> : null}
              </div>
            ))}
          </div>
          <p className="mk-display mt-3 text-[11px] tracking-[0.18em] text-[#8d7fc0]">
            08:55 — FIXTURES ARRIVE · CLASH CAUGHT · RESOLVED · PUBLISHED — TOUCH TO TAKE OVER
          </p>
        </div>
      ) : (
        <div>
          <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Fixtures to place">
            {board.tray.map((f, i) => (
              <button
                key={f}
                data-testid="board-chip"
                aria-pressed={armed === i}
                onClick={() => setArmed(armed === i ? null : i)}
                className={`cursor-grab rounded-lg px-3 py-1.5 text-xs font-semibold text-white ${
                  armed === i ? "bg-[var(--mk-lime)] !text-[var(--mk-night)]" : "bg-[var(--mk-purple)]"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
          <div className="space-y-2 rounded-xl bg-[var(--mk-night)] p-4">
            {board.courts.map((c, court) => (
              <button
                key={court}
                data-testid={`board-court-${court}`}
                onClick={() => armed !== null && placeChip(armed, court)}
                className={`flex min-h-11 w-full items-center gap-2 rounded-lg p-1.5 text-left ${
                  c.clash ? "bg-[#3f1d2e] outline outline-2 outline-[var(--mk-live)]" : "bg-[#241650]"
                } ${armed !== null ? "outline-dashed outline-2 outline-[var(--mk-lime)]" : ""}`}
              >
                <span className="mk-display w-16 shrink-0 text-[11px] tracking-[0.12em] text-[#8d7fc0]">
                  COURT {court + 1}
                </span>
                {c.placed.map((f) => (
                  <span key={f} className={`rounded px-2 py-1 text-xs font-semibold ${c.clash ? "bg-[var(--mk-live)] text-white" : "bg-[var(--mk-purple)] text-white"}`}>
                    {f}
                  </span>
                ))}
              </button>
            ))}
          </div>
          <p data-testid="board-status" aria-live="polite" className="mt-3 min-h-5 text-sm text-slate-600">
            {status}
          </p>
          {isFull(board) ? (
            <button
              data-testid="board-publish"
              onClick={() => setMode("published")}
              className="mk-display mt-3 rounded-xl bg-[var(--mk-lime)] px-6 py-2.5 font-bold text-[var(--mk-night)]"
            >
              Publish to players →
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
```

(Design note: pointer *drag* is progressive enhancement over the tap/keyboard arm-then-place mechanism above, which is the accessible baseline and what e2e drives. If adding the drag ghost from the mock, reuse `placeChip` at drop and keep the buttons.)

```css
/* /scheduling attract-mode replay (~3.2s once) */
.mk-replay-chip { width: 26%; left: 108%; }
.mk-replay-chip-0 { animation: mk-replay-in 0.6s 0.3s cubic-bezier(0.22, 1.2, 0.36, 1) forwards; }
.mk-replay-chip-1 { animation: mk-replay-in 0.6s 0.9s cubic-bezier(0.22, 1.2, 0.36, 1) forwards, mk-replay-clash 0.35s 1.7s ease 2; }
.mk-replay-chip-2 { animation: mk-replay-in 0.6s 1.3s cubic-bezier(0.22, 1.2, 0.36, 1) forwards; }
@keyframes mk-replay-in { to { left: 6%; } }
@keyframes mk-replay-clash { 50% { box-shadow: 0 0 0 3px var(--mk-live); } }
.mk-replay-fix { width: 22%; left: 108%; opacity: 0; animation: mk-replay-resolve 0.7s 2.5s cubic-bezier(0.22, 1.2, 0.36, 1) forwards; }
@keyframes mk-replay-resolve { to { left: 40%; opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .mk-replay-chip, .mk-replay-fix { animation: none; }
}
```

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc -p . --noEmit
git add src/lib/marketing/board-logic.ts src/lib/marketing/__tests__/board-logic.test.ts src/components/marketing/scheduling-board.tsx src/app/globals.css
git commit -m "feat(marketing): attract-mode scheduling demo board"
```

---

### Task 12: `/scheduling` page + e2e

**Files:**
- Create: `src/app/scheduling/page.tsx`
- Test: `e2e/marketing-scheduling.spec.ts`

**Interfaces:**
- Consumes: `MarketingShell` (light variant), `SchedulingBoard`, `Reveal`.

- [ ] **Step 1: Implement the page**

```tsx
// src/app/scheduling/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { SchedulingBoard } from "@/components/marketing/scheduling-board";
import { Reveal } from "@/components/marketing/reveal";

export const metadata: Metadata = {
  title: "Scheduling — Seazn Club",
  description:
    "Courts and time slots on one board. Drag fixtures in, catch clashes before they happen, publish to players in one click.",
};

const RUNDOWN = [
  { time: "08:40", what: "Build the board", how: "courts × slots — fixtures auto-fill, drag to taste" },
  { time: "08:55", what: "Clash caught", how: "one player in two places at 9:15 — flagged before you publish" },
  { time: "09:00", what: "Publish", how: "schedule goes live on your public page; players see their courts" },
  { time: "12:30", what: "Rain-delay reshuffle", how: "drag the afternoon 40 minutes right, republish" },
];

const KIT = [
  { label: "Print & noticeboard", body: "The same board exports to print and full-screen slideshow." },
  { label: "Scorer hand-off", body: "Courtside volunteers score from a device link — no accounts." },
  { label: "Live to players", body: "Every change republished to the public schedule instantly." },
];

export default function SchedulingPage() {
  return (
    <MarketingShell>
      <main className="bg-[var(--mk-light-warm)]">
        <section className="mx-auto max-w-4xl px-4 pb-14 pt-16">
          <h1 className="mk-display text-5xl font-bold text-purple-950">The board runs matchday</h1>
          <p className="mt-3 max-w-xl text-slate-600">
            Courts and time slots on one board — drag fixtures in, clashes flagged before they
            happen. Try it: the replay below hands over to you.
          </p>
          <div className="mt-8">
            <SchedulingBoard />
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-4 pb-14">
          <h2 className="mk-display mb-6 text-3xl font-bold text-purple-950">Order of play</h2>
          <div className="border-l-2 border-purple-950 pl-5">
            {RUNDOWN.map((r) => (
              <Reveal key={r.time} className="flex items-baseline gap-4 border-b border-dashed border-[#e5decd] py-2.5">
                <span className="mk-display min-w-14 text-lg font-bold tabular-nums text-[var(--mk-purple)]">{r.time}</span>
                <span>
                  <span className="text-sm font-semibold text-slate-800">{r.what}</span>{" "}
                  <span className="text-sm text-slate-500">— {r.how}</span>
                </span>
              </Reveal>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-4 pb-20">
          <div className="grid gap-4 sm:grid-cols-3">
            {KIT.map((k) => (
              <div key={k.label} className="card p-4 text-sm">
                <p className="mb-1 font-semibold text-slate-800">{k.label}</p>
                <p className="text-slate-500">{k.body}</p>
              </div>
            ))}
          </div>
          <p className="mt-10 text-center">
            <Link href="/start" className="btn btn-primary px-6 py-2.5 text-base">
              Run your matchday →
            </Link>
          </p>
        </section>
      </main>
    </MarketingShell>
  );
}
```

- [ ] **Step 2: Write the e2e**

```ts
// e2e/marketing-scheduling.spec.ts
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("/scheduling attract-mode board (design/v3/12 §5)", () => {
  test("replay hands over; tap-place works; clash fires; publish flips to player view", async ({ browser }) => {
    // Reduced motion skips the replay — deterministic start state for e2e.
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto("/scheduling");

    const chips = page.getByTestId("board-chip");
    await expect(chips).toHaveCount(3);

    // Clash: two fixtures on court 1
    await chips.first().click();
    await page.getByTestId("board-court-0").click();
    await chips.first().click();
    await page.getByTestId("board-court-0").click();
    await expect(page.getByTestId("board-status")).toContainText("Clash!");

    // No publish while clashed; reload and place clean
    await expect(page.getByTestId("board-publish")).toHaveCount(0);
    await page.reload();
    for (const court of [0, 1, 2]) {
      await page.getByTestId("board-chip").first().click();
      await page.getByTestId(`board-court-${court}`).click();
    }
    await page.getByTestId("board-publish").click();
    await expect(page.getByTestId("board-player-view")).toBeVisible();
    await expect(page.getByTestId("board-player-view").getByText("Court 1")).toBeVisible();
    await ctx.close();
  });

  test("replay renders in attract mode with animations enabled", async ({ page }) => {
    await page.goto("/scheduling");
    await expect(page.getByText(/TOUCH TO TAKE OVER/)).toBeVisible();
    // Hands over automatically ≤ ~3.4s
    await expect(page.getByTestId("board-chip").first()).toBeVisible({ timeout: 6000 });
  });

  test("axe: no serious/critical violations on /scheduling", async ({ page }) => {
    await page.goto("/scheduling", { waitUntil: "load" });
    await page.waitForTimeout(400);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(blocking.map((v) => `${v.id} — ${v.nodes[0]?.html}`)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the gates**

```bash
npx tsc -p . --noEmit
npx playwright test e2e/marketing-scheduling.spec.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/app/scheduling/page.tsx e2e/marketing-scheduling.spec.ts
git commit -m "feat(marketing): /scheduling page — replay board, order-of-play rail"
```

---

### Task 13: Smoke, corpus index, full verification

**Files:**
- Modify: `scripts/smoke.ts` (add a marketing suite; follow the `check(label, cond)` helper convention already in the file)
- Modify: `design/v3/README.md` (prompt-index row for PROMPT-40)
- Modify: `design/v3/prompts/PROMPT-40-marketing-redesign.md` (tick remaining checkboxes)

- [ ] **Step 1: Extend smoke**

Add near the other suites in `scripts/smoke.ts` (adapt `BASE`/url variable to whatever the file already uses — grep `fetch(` there first) and call it from `main()`:

```ts
async function marketingSuite(base: string) {
  // Home renders the matchday-arc page (no auth).
  const home = await fetch(`${base}/`, { redirect: "manual" });
  const html = await home.text();
  check("marketing: home 200", home.status === 200);
  check("marketing: home has The Draw", html.includes("The Draw"));
  check("marketing: home has funnel form", html.includes("data-start-funnel"));
  check("marketing: home SSR default draw", html.includes("Group stage"));

  // Public engine preview API (design/v3/12 §4.4) — free path, no session.
  const preview = await fetch(`${base}/api/public/format-preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ format: "groups-knockout", entrants: 8 }),
  });
  const body = (await preview.json()) as { phases?: Array<{ sections: unknown[] }> };
  check("marketing: format-preview 200", preview.status === 200);
  check("marketing: format-preview two phases", body.phases?.length === 2);

  // /scheduling ships and carries the board.
  const sched = await fetch(`${base}/scheduling`);
  const shtml = await sched.text();
  check("marketing: /scheduling 200", sched.status === 200);
  check("marketing: /scheduling has rundown", shtml.includes("Order of play"));
}
```

- [ ] **Step 2: Add the prompt-index row**

In `design/v3/README.md`, under the prompt index table, append:

```markdown
| [PROMPT-40](prompts/PROMPT-40-marketing-redesign.md) | Stadium-night marketing redesign: matchday-arc home, The Draw configurator, `/scheduling` attract board (spec: [12-marketing-redesign.md](../12-marketing-redesign.md)) | 30 (routes), 36 (funnel/pricing) |
```

- [ ] **Step 3: Full gate (house rule: tsc + unit before push; e2e for this wave)**

```bash
npx tsc -p . --noEmit
npx vitest run
npx playwright test e2e/marketing-home.spec.ts e2e/marketing-scheduling.spec.ts e2e/funnel.spec.ts e2e/pricing-v3.spec.ts e2e/discovery.spec.ts
npm run smoke   # or however scripts/smoke.ts is invoked per package.json — check "scripts"
```
Expected: everything green; funnel/pricing/discovery suites prove the untouched contracts survived.

- [ ] **Step 4: Lighthouse sanity (manual)**

Run Lighthouse (mobile) on `http://localhost:3000/` via Chrome devtools or `npx lighthouse` — target perf ≥ 90, LCP = the H1. Note the score in the PR body.

- [ ] **Step 5: Commit + PR**

```bash
git add scripts/smoke.ts design/v3/README.md design/v3/prompts/PROMPT-40-marketing-redesign.md
git commit -m "test(marketing): smoke coverage for home, preview API, /scheduling"
git push -u origin feat/marketing-matchday
gh pr create --title "PROMPT-40: stadium-night marketing redesign" --body "..."
```
PR body: link `design/v3/12-marketing-redesign.md`, list the retirements, note the Swiss→double-elim decision, paste the Lighthouse score, end with the standard generated-with footer.

---

## Self-Review (completed at plan time)

- **Spec coverage:** §2 tokens → Task 1; §4.1 nav → 9; §4.2 hero → 5+10; §4.3 ticker → 6; §4.4 Draw+API → 3+7; §4.5 tools/kit → 8; §4.6 dividers → 8; §4.7 audiences/this-week → 10; §4.8 stubs → 4; §4.9 footer → 9; §5 scheduling → 11+12; §6 retirements → 10; §9 a11y/perf → axe tests (10, 12) + reduced-motion CSS throughout + Lighthouse (13); §10 testing → per-task + 13; §11 rollout → 13.
- **Known judgment calls for the implementer:** exact `formatMinor` output shapes (Task 4 Step 4 says how to adjust), `preferredCurrency` signature (Task 10 Step 1), `LiveNowStrip` href pattern (Task 6 Step 1). These are verify-then-adjust steps, not open questions.
- **Type consistency:** `MarketingFormat`/`MARKETING_FORMATS` (T3) used by T7/T10; `PreviewPhase` from stages everywhere; `BoardState`/`place`/`isFull` (T11) drive T11 component + T12 e2e test ids; `Reveal` (T1) consumed by T4/T7/T8/T12; `variant` prop names match between shell/nav/funnel (T9/T10).
