# Product-Led Growth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate Seazn Club's built-in distribution surfaces into instrumented growth loops (attribution CTAs, player→organiser + share loops) so every free-tier org recruits the next.

**Architecture:** Extend the existing PostHog taxonomy (`lib/analytics-events.ts`) with loop events, fire them from small client components (`lib/analytics` `track()`), and convert passive brand surfaces (badge, embed, `/me`, emails, Discover) into UTM-tagged CTAs back to `/start`. No schema changes — analytics is external (PostHog) and the surfaces already exist.

**Tech Stack:** Next.js (this fork — read `node_modules/next/dist/docs/` before route/layout changes), React server + client components, PostHog (`posthog-js` client, `posthog-node` server), Vitest + Testing Library, i18n dictionaries (`dictionaries/<lang>/*.json`, `lib/messages.ts` `ui` namespace).

## Global Constraints

Copied verbatim from project rules (AGENTS.md + team conventions). Every task implicitly includes these:

- **This is NOT stock Next.js** — read the relevant guide in `node_modules/next/dist/docs/` before writing route/layout/metadata code.
- **Regression test each change** — every code change ships a test that FAILS without the change.
- **Extend `scripts/smoke.ts`** — each feature adds coverage on both pro and free paths.
- **Update help** — MANDATORY closing pass: update `content/help/*.md` in the same branch, never skip.
- **i18n parity** — every new user-facing string added to `dictionaries/en/*.json` (or `lib/messages.ts` `ui`) must be added to `fr`, `es`, `nl` too (parity is gated).
- **Verify before push** — run `tsc` + unit tests before any push (unit alone has missed tsc breaks).
- **Analytics event names are canonical in `lib/analytics-events.ts`** — never inline a raw string; add to `EVENTS` and reference `EVENTS.X`.
- **PostHog is best-effort** — capture must never throw into the request it rides on (existing `captureServer`/`track` already swallow errors; keep that).
- **No DB migration** in this plan. If you reach for one, stop — you've mis-scoped.
- Work in a git worktree (`superpowers:using-git-worktrees`), not the main checkout.

## File Structure

**New files:**
- `apps/web/src/components/attribution-link.tsx` — client CTA link (badge + embed), fires `ATTRIBUTION_CLICKED`.
- `apps/web/src/components/share-bar.tsx` — client share row (native share + WhatsApp + copy), fires `SHARE_FIRED`.
- `apps/web/src/components/run-your-own-cta.tsx` — client "Run your own tournament →" card, fires `PLAYER_STARTED_OWN_ORG`.
- `docs/superpowers/runbooks/plg-posthog-dashboards.md` — the two PostHog dashboards (external config, documented not coded).
- Test files colocated under `__tests__/` beside each.

**Modified files:**
- `apps/web/src/lib/analytics-events.ts` — add loop events to `EVENTS`.
- `apps/web/src/app/(public)/shared/[orgSlug]/layout.tsx:109-116` — badge → `<AttributionLink>`.
- `apps/web/src/app/embed/layout.tsx:27-36` — backlink → `<AttributionLink>`.
- `apps/web/src/app/me/page.tsx` — mount `<RunYourOwnCta>`.
- `apps/web/src/lib/email-templates/compose.ts` — shell footer CTA line.
- `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/page.tsx` — mount `<ShareBar>` in hero.
- `apps/web/src/app/[lang]/(marketing)/discover/page.tsx:124` — CTA → `/start` + live counter.
- The competition-publish action (locate in Task 5) — fire `COMPETITION_MADE_PUBLIC`.
- `dictionaries/{en,fr,es,nl}/*.json` and/or `lib/messages.ts` — new strings.
- `scripts/smoke.ts`, `content/help/*.md` — per Global Constraints.

**Task order (dependency + ICE sequence):** Task 1 (events) → 2 (L1) → 3 (L2) → 4 (L3) → 5 (L6) → 6 (L5).

---

### Task 1: Growth event taxonomy + dashboard runbook (L4)

**Files:**
- Modify: `apps/web/src/lib/analytics-events.ts`
- Create: `docs/superpowers/runbooks/plg-posthog-dashboards.md`
- Test: `apps/web/src/lib/__tests__/analytics-events.test.ts`

**Interfaces:**
- Produces: `EVENTS.ATTRIBUTION_CLICKED = "attribution_clicked"`, `EVENTS.SHARE_FIRED = "share_fired"`, `EVENTS.PLAYER_STARTED_OWN_ORG = "player_started_own_org"`, `EVENTS.COMPETITION_MADE_PUBLIC = "competition_made_public"`, `EVENTS.EMBED_RENDERED = "embed_rendered"`. All typed into the existing `AnalyticsEvent` union. Consumed by Tasks 2–6.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/__tests__/analytics-events.test.ts
import { describe, expect, it } from "vitest";
import { EVENTS } from "@/lib/analytics-events";

describe("PLG growth events", () => {
  it("exposes the loop event names", () => {
    expect(EVENTS.ATTRIBUTION_CLICKED).toBe("attribution_clicked");
    expect(EVENTS.SHARE_FIRED).toBe("share_fired");
    expect(EVENTS.PLAYER_STARTED_OWN_ORG).toBe("player_started_own_org");
    expect(EVENTS.COMPETITION_MADE_PUBLIC).toBe("competition_made_public");
    expect(EVENTS.EMBED_RENDERED).toBe("embed_rendered");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace apps/web -- src/lib/__tests__/analytics-events.test.ts`
Expected: FAIL — `EVENTS.ATTRIBUTION_CLICKED` is `undefined`.

- [ ] **Step 3: Add the events**

In `apps/web/src/lib/analytics-events.ts`, inside the `EVENTS` object (after `SUBSCRIPTION_RESUMED`), add:

```ts
  // PLG growth loops (2026-07-17 plan) — distribution + referral.
  ATTRIBUTION_CLICKED: "attribution_clicked",
  SHARE_FIRED: "share_fired",
  PLAYER_STARTED_OWN_ORG: "player_started_own_org",
  COMPETITION_MADE_PUBLIC: "competition_made_public",
  EMBED_RENDERED: "embed_rendered",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace apps/web -- src/lib/__tests__/analytics-events.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the dashboard runbook**

Create `docs/superpowers/runbooks/plg-posthog-dashboards.md` documenting the two dashboards an operator builds in PostHog (external config — no code):

```markdown
# PLG PostHog dashboards

## 1. Activation funnel
Steps (event names): funnel_draft_created → funnel_claimed →
competition_created → competition_made_public → result_entered (★ north-star).
Breakdown by organization group. Target: % reaching result_entered.

## 2. K-factor panel
- attribution_clicked / active org (surface: badge|embed)
- share_fired / public page view (channel: native|whatsapp|copy)
- player_started_own_org / player_account_created  (loop #1 rate)
Watch these, not signup counts.
```

- [ ] **Step 6: Verify + commit**

Run: `npm run typecheck --workspace apps/web && npm run test --workspace apps/web -- src/lib/__tests__/analytics-events.test.ts`
Expected: tsc clean, test PASS.

```bash
git add apps/web/src/lib/analytics-events.ts apps/web/src/lib/__tests__/analytics-events.test.ts docs/superpowers/runbooks/plg-posthog-dashboards.md
git commit -m "feat(analytics): add PLG growth-loop events + dashboard runbook"
```

---

### Task 2: CTA-ify attribution (L1)

Convert the passive "Powered by seazn.club" badge and the "live on seazn.club" embed backlink into a UTM-tagged CTA that fires `ATTRIBUTION_CLICKED`. Free-tier gating (`org.branded`) is unchanged — Pro still removes the badge.

**Files:**
- Create: `apps/web/src/components/attribution-link.tsx`
- Test: `apps/web/src/components/__tests__/attribution-link.test.tsx`
- Modify: `apps/web/src/app/(public)/shared/[orgSlug]/layout.tsx` (badge, ~lines 109-116)
- Modify: `apps/web/src/app/embed/layout.tsx` (backlink, lines 27-36)

**Interfaces:**
- Consumes: `EVENTS.ATTRIBUTION_CLICKED`, `track` (from `@/lib/analytics`).
- Produces: `<AttributionLink surface="badge" | "embed" />` (client component).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/__tests__/attribution-link.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const track = vi.fn();
vi.mock("@/lib/analytics", () => ({
  EVENTS: { ATTRIBUTION_CLICKED: "attribution_clicked" },
  track,
}));

import { AttributionLink } from "../attribution-link";

describe("AttributionLink", () => {
  it("links to /start with surface UTM and fires the event on click", () => {
    render(<AttributionLink surface="badge" />);
    const link = screen.getByRole("link", { name: /run your own free/i });
    expect(link).toHaveAttribute("href", expect.stringContaining("seazn.club/start"));
    expect(link).toHaveAttribute("href", expect.stringContaining("utm_source=badge"));
    fireEvent.click(link);
    expect(track).toHaveBeenCalledWith("attribution_clicked", { surface: "badge" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace apps/web -- src/components/__tests__/attribution-link.test.tsx`
Expected: FAIL — cannot find `../attribution-link`.

- [ ] **Step 3: Create the component**

```tsx
// apps/web/src/components/attribution-link.tsx
"use client";
import { EVENTS, track } from "@/lib/analytics";

const START = "https://seazn.club/start";

/** Free-tier attribution turned into an acquisition CTA (PLG L1). Renders the
 *  brand line + a tracked "Run your own free →" link back to /start. */
export function AttributionLink({ surface }: { surface: "badge" | "embed" }) {
  const href = `${START}?utm_source=${surface}&utm_medium=attribution&utm_campaign=plg`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={() => track(EVENTS.ATTRIBUTION_CLICKED, { surface })}
      className="font-medium underline hover:opacity-80"
    >
      Run your own free →
    </a>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace apps/web -- src/components/__tests__/attribution-link.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire into the shared badge**

In `apps/web/src/app/(public)/shared/[orgSlug]/layout.tsx`, replace the `org.branded ? null : (...)` block (lines ~109-116) with:

```tsx
        {org.branded ? null : (
          <p>
            Powered by <span className="font-medium">Seazn Club</span> ·{" "}
            <AttributionLink surface="badge" />
          </p>
        )}
```

Add at top: `import { AttributionLink } from "@/components/attribution-link";`

- [ ] **Step 6: Wire into the embed backlink**

In `apps/web/src/app/embed/layout.tsx`, replace the `<a href="https://seazn.club">…live on seazn.club</a>` (lines 28-35) with `<AttributionLink surface="embed" />` and add the import. Keep the wrapping `<p className="mt-3 text-right text-[10px] text-zinc-400">`.

- [ ] **Step 7: Verify + commit**

Run: `npm run typecheck --workspace apps/web && npm run test --workspace apps/web -- src/components/__tests__/attribution-link.test.tsx`
Expected: tsc clean, test PASS. (Embed stays English-only — a widget footer, not per-org localized; the shared badge line "Powered by Seazn Club" is brand copy, no new dict key.)

```bash
git add apps/web/src/components/attribution-link.tsx apps/web/src/components/__tests__/attribution-link.test.tsx "apps/web/src/app/(public)/shared/[orgSlug]/layout.tsx" apps/web/src/app/embed/layout.tsx
git commit -m "feat(plg): CTA-ify free-tier attribution badge + embed backlink"
```

---

### Task 3: Player→organiser CTA in /me + email footer (L2)

**Files:**
- Create: `apps/web/src/components/run-your-own-cta.tsx`
- Test: `apps/web/src/components/__tests__/run-your-own-cta.test.tsx`
- Modify: `apps/web/src/app/me/page.tsx` (mount CTA in `<main>`)
- Modify: `apps/web/src/lib/email-templates/compose.ts` (shell footer CTA)
- Test: `apps/web/src/lib/email-templates/__tests__/compose.test.ts`
- Modify: `dictionaries/{en,fr,es,nl}` or `lib/messages.ts` `ui` — `me.runYourOwn.title` / `me.runYourOwn.cta`

**Interfaces:**
- Consumes: `EVENTS.PLAYER_STARTED_OWN_ORG`, `track`.
- Produces: `<RunYourOwnCta label={string} cta={string} />`.

- [ ] **Step 1: Write the failing component test**

```tsx
// apps/web/src/components/__tests__/run-your-own-cta.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
const track = vi.fn();
vi.mock("@/lib/analytics", () => ({ EVENTS: { PLAYER_STARTED_OWN_ORG: "player_started_own_org" }, track }));
import { RunYourOwnCta } from "../run-your-own-cta";

describe("RunYourOwnCta", () => {
  it("links to /start and fires the loop event", () => {
    render(<RunYourOwnCta label="Run your own" cta="Start free →" />);
    const link = screen.getByRole("link", { name: /start free/i });
    expect(link).toHaveAttribute("href", expect.stringContaining("/start"));
    fireEvent.click(link);
    expect(track).toHaveBeenCalledWith("player_started_own_org", { from: "me" });
  });
});
```

- [ ] **Step 2: Run to verify fail** — `npm run test --workspace apps/web -- src/components/__tests__/run-your-own-cta.test.tsx` → FAIL (missing module).

- [ ] **Step 3: Create the component**

```tsx
// apps/web/src/components/run-your-own-cta.tsx
"use client";
import Link from "next/link";
import { EVENTS, track } from "@/lib/analytics";

/** Player→organiser loop (PLG L2): nudges an engaged player to start their own
 *  competition. Copy is passed in so the page localizes it. */
export function RunYourOwnCta({ label, cta }: { label: string; cta: string }) {
  return (
    <div className="card mt-6 flex flex-col gap-2 p-6 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm font-medium">{label}</p>
      <Link
        href="/start?utm_source=me&utm_medium=player&utm_campaign=plg"
        onClick={() => track(EVENTS.PLAYER_STARTED_OWN_ORG, { from: "me" })}
        className="btn btn-primary text-sm"
      >
        {cta}
      </Link>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass** — same command → PASS.

- [ ] **Step 5: Add i18n strings (en + parity)**

Add to the `ui` namespace source (`lib/messages.ts` or `dictionaries/en/*` per how `me.*` keys are defined — grep `"me.title"` to find the file):
`me.runYourOwn.title` = `"Run your own tournament — free."`, `me.runYourOwn.cta` = `"Start free →"`. Add the same keys with translations to `fr`, `es`, `nl` (parity gate). Use `npm run i18n:translate` if the repo's pipeline exists, else translate the two strings.

- [ ] **Step 6: Mount in /me**

In `apps/web/src/app/me/page.tsx` `<main>`, after the page title block, add:

```tsx
        <RunYourOwnCta label={t(ui, "me.runYourOwn.title")} cta={t(ui, "me.runYourOwn.cta")} />
```

Add import: `import { RunYourOwnCta } from "@/components/run-your-own-cta";`

- [ ] **Step 7: Write failing email-footer test**

```ts
// apps/web/src/lib/email-templates/__tests__/compose.test.ts
import { describe, expect, it } from "vitest";
import { composeEmail } from "@/lib/email-templates/compose";
// Adapt to compose's real export/signature (grep `export` in compose.ts).

describe("email shell footer", () => {
  it("includes a run-your-own CTA linking to /start", () => {
    const html = composeEmail({ /* minimal valid shell args */ } as never).html;
    expect(html).toContain("/start");
    expect(html).toMatch(/run your own/i);
  });
});
```

- [ ] **Step 8: Run to verify fail**, then add a persistent CTA line to the shell footer HTML in `compose.ts` (near the `FOOTER_NOTE` placeholder, ~line 150): a small `<a href="https://seazn.club/start?utm_source=email&utm_medium=footer&utm_campaign=plg">Run your own — free</a>`. Re-run → PASS.

- [ ] **Step 9: Verify + commit**

Run: `npm run typecheck --workspace apps/web && npm run test --workspace apps/web -- src/components/__tests__/run-your-own-cta.test.tsx src/lib/email-templates/__tests__/compose.test.ts`
Expected: all PASS.

```bash
git add apps/web/src/components/run-your-own-cta.tsx apps/web/src/components/__tests__/run-your-own-cta.test.tsx apps/web/src/app/me/page.tsx apps/web/src/lib/email-templates/compose.ts apps/web/src/lib/email-templates/__tests__/compose.test.ts apps/web/src/lib/messages.ts apps/web/src/dictionaries
git commit -m "feat(plg): player→organiser CTA in /me + email footer"
```

---

### Task 4: ShareBar on public fan pages (L3)

Native `navigator.share` + WhatsApp deep-link + copy on the public competition page fans/parents open. Fires `SHARE_FIRED`.

**Files:**
- Create: `apps/web/src/components/share-bar.tsx`
- Test: `apps/web/src/components/__tests__/share-bar.test.tsx`
- Modify: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/page.tsx` (hero `<section>` ~line 89)

**Interfaces:**
- Consumes: `EVENTS.SHARE_FIRED`, `track`.
- Produces: `<ShareBar path={string} title={string} />` (client).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/__tests__/share-bar.test.tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
const track = vi.fn();
vi.mock("@/lib/analytics", () => ({ EVENTS: { SHARE_FIRED: "share_fired" }, track }));
import { ShareBar } from "../share-bar";

describe("ShareBar", () => {
  beforeEach(() => { track.mockClear(); Object.defineProperty(window, "location", { value: { origin: "https://seazn.club" }, writable: true }); });

  it("builds a wa.me link to the absolute URL and fires share_fired", () => {
    render(<ShareBar path="/shared/riverside/spring-cup" title="Spring Cup" />);
    const wa = screen.getByRole("link", { name: /whatsapp/i });
    expect(wa).toHaveAttribute("href", expect.stringContaining("wa.me/?text="));
    expect(decodeURIComponent(wa.getAttribute("href")!)).toContain("https://seazn.club/shared/riverside/spring-cup");
    fireEvent.click(wa);
    expect(track).toHaveBeenCalledWith("share_fired", { channel: "whatsapp" });
  });
});
```

- [ ] **Step 2: Run to verify fail** → FAIL (missing module).

- [ ] **Step 3: Create the component**

```tsx
// apps/web/src/components/share-bar.tsx
"use client";
import { useEffect, useState } from "react";
import { EVENTS, track } from "@/lib/analytics";

/** Fan-facing share row (PLG L3): native share on mobile, WhatsApp + copy
 *  everywhere. Grassroots sport runs on WhatsApp. */
export function ShareBar({ path, title }: { path: string; title: string }) {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);
  const url = origin ? `${origin}${path}` : path;
  const wa = `https://wa.me/?text=${encodeURIComponent(`${title} — ${url}`)}`;

  async function native() {
    track(EVENTS.SHARE_FIRED, { channel: "native" });
    try { await navigator.share?.({ title, url }); } catch { /* dismissed */ }
  }
  async function copy() {
    track(EVENTS.SHARE_FIRED, { channel: "copy" });
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* blocked */ }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {typeof navigator !== "undefined" && "share" in navigator && (
        <button type="button" onClick={native} className="btn btn-ghost">Share</button>
      )}
      <a href={wa} target="_blank" rel="noreferrer" onClick={() => track(EVENTS.SHARE_FIRED, { channel: "whatsapp" })} className="btn btn-ghost" aria-label="Share on WhatsApp">WhatsApp</a>
      <button type="button" onClick={copy} className="btn btn-ghost">{copied ? "Copied ✓" : "Copy link"}</button>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass** → PASS.

- [ ] **Step 5: Mount in the public competition hero**

In `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/page.tsx`, inside the hero `<section>` (after the `<h1>` at ~line 130), add:

```tsx
              <div className="mt-4">
                <ShareBar path={`/shared/${org.slug}/${competition.slug}`} title={competition.name} />
              </div>
```

Add import: `import { ShareBar } from "@/components/share-bar";` (confirm the competition display field name — grep the file for `competition.` to match `name`/`title`).

- [ ] **Step 6: Verify + commit**

Run: `npm run typecheck --workspace apps/web && npm run test --workspace apps/web -- src/components/__tests__/share-bar.test.tsx`
Expected: tsc clean, PASS.

```bash
git add apps/web/src/components/share-bar.tsx apps/web/src/components/__tests__/share-bar.test.tsx "apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/page.tsx"
git commit -m "feat(plg): fan-facing ShareBar (native + WhatsApp + copy) on public comp page"
```

---

### Task 5: COMPETITION_MADE_PUBLIC event (L6, activation funnel completion)

The activation funnel already has `competition_created` → `result_entered`; add the missing "made public" step so the north-star funnel is complete. No guided-onboarding UI in this plan (deferred) — instrumentation first.

**Files:**
- Modify: the server action that flips a competition to public/visible (locate below).
- Test: colocated test for that action, or `apps/web/src/lib/__tests__/`.

**Interfaces:**
- Consumes: `captureServer` (`@/lib/posthog-server`), `EVENTS.COMPETITION_MADE_PUBLIC`.

- [ ] **Step 1: Locate the publish action**

Run: `grep -rniE "is_public|visibility|publish|make.?public|listed" apps/web/src/server apps/web/src/app --include=*.ts | grep -viE "test|posthog" | head`
Pick the handler that transitions a competition to public. Note its file + the point after the successful DB write.

- [ ] **Step 2: Write the failing test**

Write a test that calls that handler (or its usecase) with a competition transitioning to public and asserts `captureServer` is invoked with `event: EVENTS.COMPETITION_MADE_PUBLIC` and the `orgId`. Mock `@/lib/posthog-server`:

```ts
import { vi, expect, it } from "vitest";
const captureServer = vi.fn();
vi.mock("@/lib/posthog-server", () => ({ captureServer }));
// import + call the located publish usecase with a going-public transition
it("captures competition_made_public on publish", async () => {
  // await publishCompetition({ ... });
  expect(captureServer).toHaveBeenCalledWith(expect.objectContaining({ event: "competition_made_public" }));
});
```

- [ ] **Step 3: Run to verify fail**, then add after the successful publish write:

```ts
await captureServer({
  event: EVENTS.COMPETITION_MADE_PUBLIC,
  distinctId: userId,
  orgId,
  properties: { competitionId },
});
```

Import `captureServer` and `EVENTS` if not present. Re-run → PASS.

- [ ] **Step 4: Verify + commit**

Run: `npm run typecheck --workspace apps/web && npm run test --workspace apps/web -- <the test file>`

```bash
git add <handler file> <test file>
git commit -m "feat(plg): fire competition_made_public to complete the activation funnel"
```

---

### Task 6: Sharpen Discover CTA + live counter (L5)

Discover already has a signup CTA (`page.tsx:124`, `/login?tab=signup`). Point it at `/start` with "Start your own free", and add a live social-proof counter from the existing discovery data source.

**Files:**
- Modify: `apps/web/src/app/[lang]/(marketing)/discover/page.tsx` (CTA ~line 124; counter near the `<h1>` ~line 75)
- Modify: `dictionaries/{en,fr,es,nl}/marketing.json` — `discover.cta.start`, `discover.liveCount`
- Test: `apps/web/src/app/[lang]/(marketing)/discover/__tests__/page.test.tsx` (or extend existing discover test)

**Interfaces:**
- Consumes: the discovery listing already loaded in the page (count of live competitions). Grep the file for the variable holding the live list (`listDiscover…` / the mapped array).

- [ ] **Step 1: Write the failing test** — assert the primary CTA links to `/start` (not `/login`) and that a live-count string renders when the list is non-empty. Mirror the existing discover test's render setup (grep `discover` under `__tests__`).

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Change the CTA** — replace `href="/login?tab=signup"` with `` href={`/${lang}/start?utm_source=discover&utm_medium=directory&utm_campaign=plg`} `` and the label with `t(d, "discover.cta.start")`.

- [ ] **Step 4: Add the counter** — near the `<h1>` (line 75), render `t(d, "discover.liveCount", { count })` where `count` is the live-competition list length already in scope (only when `> 0`, per the "no empty SEO shells" convention).

- [ ] **Step 5: Add i18n strings** — `discover.cta.start` = `"Start your own — free"`, `discover.liveCount` = `"{count} clubs live right now"`, to `en` + `fr`/`es`/`nl` (parity).

- [ ] **Step 6: Run to verify pass.**

- [ ] **Step 7: Verify + commit**

```bash
git add "apps/web/src/app/[lang]/(marketing)/discover/page.tsx" apps/web/src/dictionaries "apps/web/src/app/[lang]/(marketing)/discover/__tests__"
git commit -m "feat(plg): Discover fan→organiser CTA to /start + live club counter"
```

---

### Task 7: Closing pass — smoke + help (Global Constraints)

**Files:**
- Modify: `scripts/smoke.ts`
- Modify: `content/help/*.md` (grep for the growth/sharing/getting-started article; add or extend)

- [ ] **Step 1: Extend smoke** — add assertions on both free and pro paths: (a) free-tier public comp page contains the attribution CTA + ShareBar; (b) `/me` renders the run-your-own CTA; (c) Discover renders the `/start` CTA. Follow the existing `scripts/smoke.ts` structure (it's large — copy a nearby public-page check as the template).

- [ ] **Step 2: Run smoke** — `npm run test:smoke` (or the repo's smoke command; grep `"smoke"` in `package.json`). Expected: PASS including new assertions.

- [ ] **Step 3: Update help** — add/extend a help article on sharing + growing your club (attribution, share buttons, "run your own"). Register the slug if the repo uses a help-slug registry (grep `slug` under `content/help` tooling).

- [ ] **Step 4: Final verify + commit**

Run: `npm run typecheck --workspace apps/web && npm run test && npm run test:smoke`
Expected: all green.

```bash
git add scripts/smoke.ts content/help
git commit -m "test(plg): smoke coverage + help for growth loops"
```

---

## Self-Review

**Spec coverage:** L1→Task 2, L2→Task 3, L3→Task 4, L4→Task 1, L5→Task 6, L6→Task 5. North-star (`result_entered`) already exists + funnel completed by Task 5. Monetization flywheel: unchanged `org.branded`/`dashboard.branding` gate preserved (Task 2 Step 5). All six levers + instrumentation covered.

**Placeholder scan:** Two intentional locate-steps (Task 5 Step 1 publish handler; Task 6 live-list variable) give exact grep commands, not vague "handle it" — acceptable per plan rules. Email test (Task 3 Step 7) says "adapt to compose's real signature" — mitigated by the grep instruction; implementer must read `compose.ts` exports first.

**Type consistency:** `track(event, properties)` and `captureServer({event, distinctId, orgId, properties})` match the real signatures read from `lib/analytics.ts` and `lib/posthog-server.ts`. Event constants referenced as `EVENTS.X` throughout, all defined in Task 1. Component prop names (`surface`, `path`/`title`, `label`/`cta`) consistent between definition and mount sites.

**No schema/migration** — confirmed; analytics is external.
