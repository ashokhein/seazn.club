# v12 Matchday Documents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn every exported PDF into a designed courtside document (masthead, typography, zebra tables, sponsor + live-page-QR footer) by teaching the shared renderer the brand, and add two new documents — officials rota and admit tickets — surfaced from a Documents panel on the schedule board.

**Architecture:** One pure engine layer (`@seazn/engine/exports`) builds sport-neutral `DocModel`s; one effectful renderer (`apps/web/src/server/doc-render.ts`) turns a model into PDF/XLSX bytes. PR1 teaches the renderer `DocBranding` (all existing exports upgrade at once, gated on `exports.branded`). PR2 adds `officials_rota` + `admit_ticket` `DocKind`s, their builders/routes, and the Documents panel.

**Tech Stack:** TypeScript, Next.js (vendored, breaking — read `node_modules/next/dist/docs/` before touching routes), pdfkit (PDF), exceljs (XLSX), qrcode (QR), zod, postgres.js, vitest.

## Global Constraints

- **Builders stay pure:** `printedAt` and any QR **URL** are inputs; no `Date.now()`, no image bytes in the model. Pixels live only in `doc-render.ts`. (Goldens assert the model.)
- **Free-tier reach (DECIDED 2026-07-17):** community orgs (no `exports.branded`) get the clean upgrade — brand fonts, eyebrow, title, description, and zebra tables. Only the **night masthead band, org logo, and sponsor footer** are Pro-gated. The free-tier contract is therefore: **no masthead / logo / sponsor chrome when unbranded** — pin THAT with a draw-call spy (assert no `SEAZN CLUB` wordmark and no masthead band), not byte-identical output. Tables + typography upgrade for everyone.
- **`exports.branded` gate:** `branding` is set only when `hasFeature(orgId,'exports.branded')` passes; else `undefined` and the renderer draws the plain doc.
- **Extending `DocKind` breaks exhaustive switches at compile time — chase them all,** never `default`.
- **Broken asset degrades, never throws:** a missing/unreadable logo, font, or QR resolves to no-image, not a 500.
- **i18n parity gate (#108):** every new **UI string** (Documents panel, `/me` rota button, help copy) needs `en/fr/es/nl` in `lib/messages.ts` `ui` namespace + `translate` pass or CI fails. Print-document body text stays English.
- **House rules:** every change ships a fail-without-it test; `content/help/**` updated in the same PR (register the slug); `scripts/smoke.ts` extended (pro + free paths). Run `npm run typecheck` + unit suites before any push.
- **DB test suites** need `DATABASE_URL` exported and `skipIf(!HAS_DB)`; migrations (none expected here) live at repo-root `db/migration/deltas`.
- **Migration:** none. If any task appears to need one, stop and flag it.

---

## File Structure

**PR1 — Brand the renderer**
- Modify `packages/engine/src/exports/types.ts` — `DocBranding.sponsors` shape, `orgName`, `DocModel.description`, `BuildOpts.description`.
- Modify `packages/engine/src/exports/build.ts` — thread `description` through `base()`.
- Create `apps/web/assets/fonts/` — `BarlowCondensed-SemiBold.ttf`, `BarlowCondensed-Bold.ttf`, `Inter-Regular.ttf`, `Inter-Medium.ttf` (OFL).
- Create `apps/web/src/server/doc-theme.ts` — palette constants, kind→eyebrow map, font registration helper (one responsibility: brand tokens for the renderer).
- Modify `apps/web/src/server/doc-render.ts` — masthead/table/footer bands.
- Modify `apps/web/src/server/usecases/exports.ts` — `brandingFor` (sponsors + orgName), `divisionMeta` org join, wire branding into `buildCompetitionTimetable`, per-kind `description`.
- Modify `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/poster.pdf/route.ts` — branding via `resolveSponsors`.
- Test: `packages/engine/src/exports/build.test.ts`, `apps/web/src/server/__tests__/doc-render.test.ts` (new), `apps/web/src/server/usecases/__tests__/exports.test.ts`.

**PR2 — New docs + panel**
- Modify `packages/engine/src/exports/types.ts` — `DocKind` += `officials_rota`, `admit_ticket`; new build-input interfaces.
- Modify `packages/engine/src/exports/build.ts` — `buildOfficialsRota`, `buildAdmitTickets`.
- Modify `apps/web/src/server/doc-render.ts` — QR pre-pass + ticket layout.
- Modify `apps/web/src/server/usecases/exports.ts` — `buildOfficialsRotaDoc`, `buildAdmitTicketsDoc`.
- Modify `apps/web/src/app/api/v1/divisions/[id]/exports/[kind]/route.ts` — add `officials_rota`.
- Create `apps/web/src/app/api/v1/competitions/[id]/exports/tickets/route.ts`.
- Create `apps/web/src/app/api/v1/me/rota.pdf/route.ts`.
- Create `apps/web/src/components/v2/board/documents-menu.tsx`; modify `apps/web/src/components/v2/board/board-tray.tsx`.
- Modify `apps/web/src/lib/messages.ts` + `lib/messages/*.json` — `ui` strings.
- Create `content/help/matchday-documents.md`; register in the help slug registry.
- Modify `scripts/smoke.ts`.

---

# PR1 — Brand the renderer

### Task 1: Model — sponsor tier shape, orgName, description

**Files:**
- Modify: `packages/engine/src/exports/types.ts:34-65`
- Modify: `packages/engine/src/exports/build.ts:15-32,109-116`
- Test: `packages/engine/src/exports/build.test.ts`

**Interfaces:**
- Produces: `DocBranding.sponsors?: { name: string; tier: string }[]`; `DocBranding.orgName?: string`; `DocModel.description?: string`; `BuildOpts.description?: string`.

- [ ] **Step 1: Write the failing test** — append to `build.test.ts`:

```ts
import { DocBranding, DocModel } from "./types.ts";

it("DocBranding carries tiered sponsors + orgName", () => {
  const b = DocBranding.parse({
    orgName: "Riverside SC",
    colors: { primary: "#123456" },
    sponsors: [{ name: "Acme", tier: "title" }],
  });
  expect(b.sponsors?.[0]).toEqual({ name: "Acme", tier: "title" });
  expect(b.orgName).toBe("Riverside SC");
});

it("DocModel carries an optional description", () => {
  const m = DocModel.parse({
    kind: "timetable", title: "T", meta: { printedAt: "2026-07-19" },
    description: "All fixtures, in play order.", sections: [],
  });
  expect(m.description).toBe("All fixtures, in play order.");
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm run test -w @seazn/engine -- build.test.ts`
Expected: FAIL (zod rejects `sponsors` object / unknown `description`).

- [ ] **Step 3: Edit `types.ts`**

Replace the `DocBranding` block (lines 34-39):

```ts
export const DocBranding = z.object({
  orgName: z.string().optional(),
  colors: z.record(z.string(), z.string()).optional(),
  logos: z.array(z.string()).optional(), // storage paths
  sponsors: z.array(z.object({ name: z.string(), tier: z.string() })).optional(),
});
export type DocBranding = z.infer<typeof DocBranding>;
```

In `DocModel` (after the `title` line, ~line 56) add:

```ts
  description: z.string().optional(), // one-line "what this sheet is"
```

In `BuildOpts` (after `printedAt`, ~line 110) add:

```ts
  description?: string;
```

- [ ] **Step 4: Edit `build.ts` `base()`** — thread description through (line 21-31), add after the `meta` block:

```ts
    ...(opts.description !== undefined ? { description: opts.description } : {}),
```

- [ ] **Step 5: Run tests, verify pass**

Run: `npm run test -w @seazn/engine -- build.test.ts`
Expected: PASS (existing golden tests still green — `description` is additive/optional).

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/exports/types.ts packages/engine/src/exports/build.ts packages/engine/src/exports/build.test.ts
git commit -m "feat(exports): tiered sponsors, orgName, doc description on DocModel"
```

---

### Task 2: Renderer brand tokens + font registration (`doc-theme.ts`)

**Files:**
- Create: `apps/web/assets/fonts/{BarlowCondensed-SemiBold,BarlowCondensed-Bold,Inter-Regular,Inter-Medium}.ttf`
- Create: `apps/web/src/server/doc-theme.ts`
- Test: `apps/web/src/server/__tests__/doc-theme.test.ts`

**Interfaces:**
- Produces: `PALETTE` (named hex), `eyebrowFor(kind): string`, `registerFonts(doc): void` (safe; falls back to Helvetica, never throws), `FONT` = `{ display, displayBold, body, bodyMed }` (font names to pass to `doc.font()`).

- [ ] **Step 1: The font files are ALREADY committed** (commit `ef56465`, "bundle Barlow Condensed + Inter fonts"). Do NOT download — just verify they are present (note Inter is `.otf`, Barlow is `.ttf`):

```bash
ls -1 apps/web/assets/fonts/   # BarlowCondensed-{SemiBold,Bold}.ttf, Inter-{Regular,Medium}.otf, OFL-*.txt
```

- [ ] **Step 2: Write the failing test** — `doc-theme.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import PDFDocument from "pdfkit";
import { registerFonts, eyebrowFor, PALETTE, FONT } from "../doc-theme";

describe("doc-theme", () => {
  it("registers brand fonts without throwing and exposes their names", () => {
    const doc = new PDFDocument();
    expect(() => registerFonts(doc)).not.toThrow();
    expect(() => doc.font(FONT.display)).not.toThrow();
    expect(() => doc.font(FONT.body)).not.toThrow();
  });

  it("falls back to Helvetica when a font file is missing, never throws", () => {
    const doc = new PDFDocument();
    // point at a bad dir via env override
    process.env.DOC_FONT_DIR = "/nonexistent";
    expect(() => registerFonts(doc)).not.toThrow();
    delete process.env.DOC_FONT_DIR;
  });

  it("maps kinds to tracked-caps eyebrows", () => {
    expect(eyebrowFor("timetable")).toBe("ORDER OF PLAY");
    expect(eyebrowFor("officials_rota")).toBe("OFFICIALS ROTA");
    expect(eyebrowFor("admit_ticket")).toBe("ADMIT ONE");
  });

  it("palette exposes courtside constants", () => {
    expect(PALETTE.night).toBe("#150b36");
    expect(PALETTE.lime).toBe("#a3e635");
  });
});
```

- [ ] **Step 3: Run it, verify it fails**

Run: `npm run test -w web -- doc-theme.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Create `doc-theme.ts`**

```ts
import "server-only";
// Courtside print tokens (v12). The PDF brand is the same identity as
// r/[ref]/ticket.png and the email templates, made native to paged PDF.
import fs from "node:fs";
import path from "node:path";

export const PALETTE = {
  night: "#150b36",
  lime: "#a3e635",
  ball: "#ef4444",
  cream: "#f5f0e8",
  ink: "#18181b",
  slate: "#52525b",
  mute: "#71717a",
  hairline: "#e4e4e7",
} as const;

// pdfkit built-in names used as fallback when a TTF fails to load.
export const FONT = {
  display: "Display",
  displayBold: "DisplayBold",
  body: "Body",
  bodyMed: "BodyMed",
} as const;

const FALLBACK: Record<string, string> = {
  Display: "Helvetica-Bold",
  DisplayBold: "Helvetica-Bold",
  Body: "Helvetica",
  BodyMed: "Helvetica",
};

const FILES: Record<string, string> = {
  Display: "BarlowCondensed-SemiBold.ttf",
  DisplayBold: "BarlowCondensed-Bold.ttf",
  Body: "Inter-Regular.otf",   // Inter ships as OTF here (static weights)
  BodyMed: "Inter-Medium.otf",
};

function fontDir(): string {
  return process.env.DOC_FONT_DIR ?? path.join(process.cwd(), "apps/web/assets/fonts");
}

/** Register brand fonts on a pdfkit doc. Any file that fails to load aliases
 *  its slot to a built-in Helvetica so the render still succeeds. */
export function registerFonts(doc: PDFKit.PDFDocument): void {
  const dir = fontDir();
  for (const [name, file] of Object.entries(FILES)) {
    try {
      const p = path.join(dir, file);
      const bytes = fs.readFileSync(p);
      doc.registerFont(name, bytes);
    } catch {
      doc.registerFont(name, FALLBACK[name]!);
    }
  }
}

const EYEBROW: Record<string, string> = {
  timetable: "ORDER OF PLAY",
  scoresheet: "MATCH SHEET",
  roster: "TEAM ROSTER",
  standings: "STANDINGS",
  match_report: "MATCH REPORT",
  participants: "PARTICIPANTS",
  officials_rota: "OFFICIALS ROTA",
  admit_ticket: "ADMIT ONE",
};

export function eyebrowFor(kind: string): string {
  return EYEBROW[kind] ?? kind.replace(/_/g, " ").toUpperCase();
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `npm run test -w web -- doc-theme.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/assets/fonts apps/web/src/server/doc-theme.ts apps/web/src/server/__tests__/doc-theme.test.ts
git commit -m "feat(exports): courtside PDF brand tokens + safe font registration"
```

---

### Task 3: `brandingFor` — orgName + tiered sponsors + org join

**Files:**
- Modify: `apps/web/src/server/usecases/exports.ts:35-67,124-149`
- Test: `apps/web/src/server/usecases/__tests__/exports.test.ts`

**Interfaces:**
- Consumes: `resolveSponsors(orgId, competitionId)` → `ResolvedSponsor[]` (Task uses `.name` + `.tier`); `hasFeature`.
- Produces: `brandingFor` returns `{ orgName, colors?, logos?, sponsors? }` for Pro, `undefined` for free. `divisionMeta` now also returns `org_id`, `org_name`.

- [ ] **Step 1: Write the failing test** (DB-backed; follow the file's existing `skipIf(!HAS_DB)` + auth-fixture pattern):

```ts
it("brandingFor: Pro org gets orgName + tiered sponsors; free org gets undefined", async () => {
  // pro fixture with one title sponsor row on the competition
  const { auth, meta } = await proDivisionWithSponsor("Acme", "title");
  const branded = await brandingForTestExport(auth, meta); // thin test export of brandingFor
  expect(branded?.orgName).toBeTruthy();
  expect(branded?.sponsors).toContainEqual({ name: "Acme", tier: "title" });

  const free = await freeDivision();
  const plain = await brandingForTestExport(free.auth, free.meta);
  expect(plain).toBeUndefined();
});
```

Add a named re-export at the bottom of `exports.ts` for the test (kept internal otherwise):

```ts
export const __test = { brandingFor };
```

- [ ] **Step 2: Run it, verify it fails**

Run: `DATABASE_URL=$TEST_DATABASE_URL npm run test -w web -- exports.test.ts -t brandingFor`
Expected: FAIL (no `orgName`, no `sponsors`).

- [ ] **Step 3: Edit `divisionMeta`** (lines 35-54) — add org to the interface + query:

```ts
interface DivisionMeta {
  id: string;
  name: string;
  org_id: string;
  org_name: string;
  competition_id: string;
  competition_name: string;
  branding: Record<string, unknown> | null;
  sport_key: string;
  module_version: string;
  config: unknown;
}
```

```ts
  const [row] = await tx<DivisionMeta[]>`
    select d.id, d.name, d.org_id, org.name as org_name,
           d.competition_id, c.name as competition_name,
           c.branding, d.sport_key, d.module_version, d.config
    from divisions d
    join competitions c on c.id = d.competition_id
    join organizations org on org.id = d.org_id
    where d.id = ${divisionId}`;
```

- [ ] **Step 4: Edit `brandingFor`** (lines 58-67):

```ts
import { resolveSponsors } from "./sponsors";
// ...
async function brandingFor(auth: AuthCtx, meta: DivisionMeta): Promise<DocBranding | undefined> {
  if (!(await hasFeature(auth.orgId, "exports.branded"))) return undefined;
  const branding = meta.branding ?? {};
  const colors: Record<string, string> = {};
  if (typeof branding.primary_color === "string") colors.primary = branding.primary_color;
  const sponsors = (await resolveSponsors(meta.org_id, meta.competition_id)).map((s) => ({
    name: s.name,
    tier: s.tier,
  }));
  return {
    orgName: meta.org_name,
    ...(Object.keys(colors).length > 0 ? { colors } : {}),
    ...(typeof branding.logo_path === "string" ? { logos: [branding.logo_path] } : {}),
    ...(sponsors.length > 0 ? { sponsors } : {}),
  };
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `DATABASE_URL=$TEST_DATABASE_URL npm run test -w web -- exports.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/usecases/exports.ts apps/web/src/server/usecases/__tests__/exports.test.ts
git commit -m "feat(exports): brandingFor resolves orgName + tiered sponsors"
```

---

### Task 4: Renderer — masthead band + logo pre-pass

**Files:**
- Modify: `apps/web/src/server/doc-render.ts:1-159`
- Test: `apps/web/src/server/__tests__/doc-render.test.ts` (new)

**Interfaces:**
- Consumes: `PALETTE`, `FONT`, `registerFonts`, `eyebrowFor` (Task 2); `DocModel.branding`.
- Produces: `docModelToPdf(model)` draws a masthead band + eyebrow/title/description block when `branding` present; unchanged plain output when absent.

- [ ] **Step 1: Write the failing spy test** — `doc-render.test.ts`. **Do NOT scan the PDF bytes for literal strings:** embedded-TTF subsetting encodes text as glyph IDs, so `buf.toString().toContain("…")` is unreliable. Spy on pdfkit's draw calls instead — this is the free-tier "contract" mechanism the spec names. **This harness (the `pdfkit` mock + `render()` helper) is reused by Tasks 5, 6, and 12** — put it at the top of the file:

```ts
import { describe, it, expect, vi } from "vitest";

// Font-encoding-proof spy: records every draw call by intercepting pdfkit.
const rec = { text: [] as string[], images: 0, fills: [] as string[] };
vi.mock("pdfkit", () => {
  class FakeDoc {
    page = { width: 595.28, height: 841.89 };
    y = 40;
    private endCb?: () => void;
    on(ev: string, cb: () => void) { if (ev === "end") this.endCb = cb; return this; }
    registerFont() { return this; }
    font() { return this; } fontSize() { return this; }
    fillColor() { return this; } strokeColor() { return this; } lineWidth() { return this; }
    text(s: unknown) { rec.text.push(String(s)); return this; }
    image() { rec.images++; return this; }
    rect() { return this; } roundedRect() { return this; }
    moveTo() { return this; } lineTo() { return this; } stroke() { return this; }
    fill(c?: string) { if (typeof c === "string") rec.fills.push(c); return this; }
    dash() { return this; } undash() { return this; } moveDown() { return this; }
    addPage() { return this; } switchToPage() { return this; }
    widthOfString() { return 10; }
    bufferedPageRange() { return { start: 0, count: 1 }; }
    end() { this.endCb?.(); }        // resolves docModelToPdf's `done` after all drawing
  }
  return { default: FakeDoc };
});

import { docModelToPdf } from "../doc-render";
import type { DocModel } from "@seazn/engine/exports";

const model = (branding?: DocModel["branding"]): DocModel => ({
  kind: "timetable", title: "Summer League — Div 1",
  description: "All fixtures, in play order.",
  meta: { printedAt: "2026-07-19" },
  ...(branding ? { branding } : {}),
  sections: [{ table: { columns: ["Time", "Home"], rows: [["09:00", "Falcons"]] } }],
  pageBreaks: "auto",
});

async function render(m: DocModel) {
  rec.text = []; rec.images = 0; rec.fills = [];
  await docModelToPdf(m);
  return rec;
}

describe("doc-render masthead", () => {
  it("draws a night masthead wordmark + lime pitch-line when branded (Pro chrome)", async () => {
    const r = await render(model({ orgName: "Riverside SC", colors: { primary: "#150b36" } }));
    expect(r.text.join(" ")).toContain("SEAZN");        // masthead wordmark
    expect(r.fills).toContain("#a3e635");               // lime pitch-line rule (the signature)
    expect(r.text.join(" ")).toContain("ORDER OF PLAY");
  });

  it("free-tier: eyebrow + title upgrade for ALL, but NO masthead wordmark/pitch-line", async () => {
    const r = await render(model()); // no branding
    expect(r.text.join(" ")).toContain("ORDER OF PLAY"); // title block draws for everyone
    expect(r.text.join(" ")).toContain("Summer League — Div 1");
    expect(r.text.join(" ")).not.toContain("SEAZN");    // no night masthead when unbranded
    expect(r.fills).not.toContain("#a3e635");           // no pitch-line when unbranded
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm run test -w web -- doc-render.test.ts`
Expected: FAIL (no `SEAZN` wordmark / no lime fill — masthead + title band not drawn yet).

- [ ] **Step 3: Add the masthead drawer to `doc-render.ts`.** After imports add:

```ts
import { PALETTE, FONT, registerFonts, eyebrowFor } from "./doc-theme";

const MAST_H = 64; // masthead band height, page 1

/** Resolve a storage logo path to bytes. Missing/broken → null, never throws. */
async function resolveLogo(logoPath: string | undefined): Promise<Buffer | null> {
  if (!logoPath) return null;
  try {
    const { readObject } = await import("./storage"); // existing storage read
    return await readObject(logoPath);
  } catch {
    return null;
  }
}

function drawMasthead(
  doc: PDFKit.PDFDocument,
  model: DocModel,
  logo: Buffer | null,
): void {
  const b = model.branding!;
  const bar = b.colors?.primary ?? PALETTE.night;
  const w = doc.page.width;
  doc.rect(0, 0, w, MAST_H).fill(bar);
  // wordmark
  doc.font(FONT.displayBold).fontSize(18).fillColor(PALETTE.cream)
    .text("SEAZN", MARGIN, 16, { continued: true })
    .fillColor(PALETTE.lime).text(" CLUB", { continued: false });
  // org name, right
  if (b.orgName) {
    doc.font(FONT.bodyMed).fontSize(10).fillColor("rgba(245,240,232,0.7)" as never);
    doc.fillColor(PALETTE.cream).text(b.orgName.toUpperCase(), MARGIN, 22, {
      width: w - MARGIN * 2, align: "right", characterSpacing: 2,
    });
  }
  // logo, aspect-locked, right of wordmark
  if (logo) {
    try { doc.image(logo, w - MARGIN - 40, 12, { height: 40 }); } catch { /* skip */ }
  }
  // lime pitch-line rule — the signature
  doc.rect(0, MAST_H, w, 4).fill(PALETTE.lime);
  doc.fillColor(PALETTE.ink);
  doc.y = MAST_H + 18;
}

function drawTitleBlock(doc: PDFKit.PDFDocument, model: DocModel): void {
  doc.font(FONT.bodyMed).fontSize(8).fillColor(PALETTE.mute)
    .text(eyebrowFor(model.kind), MARGIN, doc.y, { characterSpacing: 2 });
  doc.moveDown(0.1);
  doc.font(FONT.displayBold).fontSize(26).fillColor(PALETTE.night)
    .text(model.title.toUpperCase(), MARGIN, doc.y, { characterSpacing: 0.5 });
  if (model.description) {
    doc.moveDown(0.15);
    doc.font(FONT.body).fontSize(9).fillColor(PALETTE.slate).text(model.description, MARGIN);
  }
  doc.moveDown(0.6);
  doc.fillColor(PALETTE.ink);
}
```

Then in `docModelToPdf`, replace the plain title block (the current `doc.font("Helvetica-Bold").fontSize(16).text(model.title, MARGIN)` lines). Register fonts after `doc` is created, resolve the logo up front. **Per the free-tier decision: the masthead + logo are Pro-only; the eyebrow/title/description band draws for EVERYONE:**

```ts
  registerFonts(doc);
  const logo = model.branding ? await resolveLogo(model.branding.logos?.[0]) : null;
  // ... existing chunks/done wiring ...
  if (model.branding) drawMasthead(doc, model, logo); // Pro-only night chrome + logo
  else doc.y = MARGIN;
  drawTitleBlock(doc, model);                          // eyebrow + title + description for ALL
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm run test -w web -- doc-render.test.ts`
Expected: PASS (branded → `SEAZN` wordmark + lime fill; free → eyebrow/title but no wordmark/lime).

- [ ] **Step 5: Verify pre-existing exports still build** — run the engine + web export suites:

Run: `npm run test -w web -- exports && npm run test -w @seazn/engine -- exports`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/doc-render.ts apps/web/src/server/__tests__/doc-render.test.ts
git commit -m "feat(exports): branded masthead + eyebrow/title/description band"
```

> **Note (implementer):** confirm the storage read helper name — grep `apps/web/src/server` for the function `r/[ref]/ticket.png` or logo rendering uses to fetch a stored object; wire `resolveLogo` to that instead of the illustrative `./storage#readObject` if the real name differs. Missing helper → keep `resolveLogo` returning `null` and flag it.

---

### Task 5: Renderer — zebra tables + type-aware alignment

**Files:**
- Modify: `apps/web/src/server/doc-render.ts:15-54` (`drawTable`)
- Test: `apps/web/src/server/__tests__/doc-render.test.ts`

**Interfaces:**
- Produces: `drawTable` renders a night header row (cream text), cream zebra alt-rows, hairline separators, right-aligned numeric columns, 18pt row height. Behaviour is identical whether branded or not (tables always upgrade — the plain-doc contract is about masthead/sponsor chrome, not table styling; the free-tier spy in Task 4 asserts no *masthead*, tables may restyle).

- [ ] **Step 1: Add a table-styling assertion** to `doc-render.test.ts`:

```ts
it("renders a night header row + data cells for a table", async () => {
  const r = await render(model()); // reuse the render() spy + timetable model
  expect(r.text.join(" ")).toContain("Time");     // header cell
  expect(r.text.join(" ")).toContain("Falcons");  // data cell
  expect(r.fills).toContain("#150b36");            // night header-row background
});
```

- [ ] **Step 2: Run it, verify it fails on the new header fill** — this guards the rewrite:

Run: `npm run test -w web -- doc-render.test.ts`
Expected: FAIL on `#150b36` (header not yet filled) — the cell-text asserts already pass; the fill assert drives the zebra rewrite.

- [ ] **Step 3: Rewrite `drawTable`** with brand styling and numeric alignment:

```ts
function isNumericColumn(table: DocTable, i: number): boolean {
  return table.rows.length > 0 &&
    table.rows.every((r) => r[i] === "" || typeof r[i] === "number" ||
      /^[\d.,:%+\-–—\s]*$/.test(String(r[i] ?? "")));
}

function drawTable(doc: PDFKit.PDFDocument, table: DocTable): void {
  const width = doc.page.width - MARGIN * 2;
  const weights = table.columns.map((_, i) => {
    const maxLen = Math.max(
      table.columns[i]!.length,
      ...table.rows.map((r) => String(r[i] ?? "").length),
    );
    return Math.min(Math.max(maxLen, 3), 40);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  const colW = weights.map((w) => (w / total) * width);
  const numeric = table.columns.map((_, i) => isNumericColumn(table, i));
  const rowHeight = 18;

  const drawRow = (cells: readonly (string | number)[], header: boolean, zebra: boolean) => {
    if (doc.y + rowHeight > doc.page.height - MARGIN) doc.addPage();
    const y = doc.y;
    if (header) doc.rect(MARGIN, y, width, rowHeight).fill(PALETTE.night);
    else if (zebra) doc.rect(MARGIN, y, width, rowHeight).fill(PALETTE.cream);
    let x = MARGIN;
    doc.font(header ? FONT.bodyMed : FONT.body).fontSize(header ? 8.5 : 9)
      .fillColor(header ? PALETTE.cream : PALETTE.ink);
    cells.forEach((cell, i) => {
      doc.text(String(cell ?? ""), x + 4, y + 5, {
        width: colW[i]! - 8, height: rowHeight, ellipsis: true, lineBreak: false,
        align: numeric[i] ? "right" : "left",
      });
      x += colW[i]!;
    });
    if (!header) {
      doc.moveTo(MARGIN, y + rowHeight).lineTo(MARGIN + width, y + rowHeight)
        .strokeColor(PALETTE.hairline).lineWidth(0.5).stroke();
    }
    doc.y = y + rowHeight;
    doc.fillColor(PALETTE.ink);
  };

  drawRow(table.columns, true, false);
  table.rows.forEach((row, i) => drawRow(row, false, i % 2 === 1));
  doc.moveDown(0.5);
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm run test -w web -- doc-render.test.ts && npm run test -w web -- exports`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/doc-render.ts apps/web/src/server/__tests__/doc-render.test.ts
git commit -m "feat(exports): zebra tables, night header, numeric right-align"
```

---

### Task 6: Renderer — footer band (tier-grouped sponsors + live QR + page N of M)

**Files:**
- Modify: `apps/web/src/server/doc-render.ts:142-159` (footer loop)
- Test: `apps/web/src/server/__tests__/doc-render.test.ts`

**Interfaces:**
- Consumes: `model.branding.sponsors` (`{name,tier}[]`), a new optional `model.meta.liveUrl?` (QR payload — set by callers; keep the builder pure by passing the URL string).
- Produces: footer draws tier-grouped sponsor names (title→gold→silver→partner), a small live-page QR when `meta.liveUrl` is set, and `printed <date> · page N of M`.

- [ ] **Step 1: Add `liveUrl` to the model** — in `types.ts` `DocModel.meta` add `liveUrl: z.string().optional()`, and `BuildOpts.liveUrl?: string` threaded in `base()` (mirror `footerNote`). Write the failing test in `doc-render.test.ts`:

```ts
it("footer groups sponsors by tier, title first", async () => {
  const r = await render(model({
    orgName: "Riverside SC",
    sponsors: [{ name: "Silverware Co", tier: "silver" }, { name: "Acme", tier: "title" }],
  }));
  // the sponsor line is one text call: "SPONSORS   Acme  ·  Silverware Co"
  const line = r.text.find((t) => t.includes("Acme") && t.includes("Silverware"));
  expect(line).toBeTruthy();
  expect(line!.indexOf("Acme")).toBeLessThan(line!.indexOf("Silverware")); // title before silver
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm run test -w web -- doc-render.test.ts -t "footer groups"`
Expected: FAIL (sponsors not drawn).

- [ ] **Step 3: Replace the footer loop** in `docModelToPdf`:

```ts
const TIER_RANK: Record<string, number> = { title: 0, gold: 1, silver: 2, partner: 3 };

function sponsorLine(sponsors: { name: string; tier: string }[]): string {
  return [...sponsors]
    .sort((a, b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9))
    .map((s) => s.name)
    .join("  ·  ");
}
```

```ts
  const range = doc.bufferedPageRange();
  const qrPng = model.meta.liveUrl ? await qrBuffer(model.meta.liveUrl) : null; // see Task 12 helper
  const total = range.count;
  for (let i = range.start; i < range.start + total; i++) {
    doc.switchToPage(i);
    const fy = doc.page.height - MARGIN + 2;
    const sponsors = model.branding?.sponsors ?? [];
    if (sponsors.length > 0) {
      doc.font(FONT.bodyMed).fontSize(7).fillColor(PALETTE.slate)
        .text(`SPONSORS   ${sponsorLine(sponsors)}`, MARGIN, fy - 12,
          { width: doc.page.width - MARGIN * 2 - 40, characterSpacing: 1, lineBreak: false });
    }
    if (qrPng) {
      try { doc.image(qrPng, doc.page.width - MARGIN - 28, fy - 20, { width: 28 }); } catch { /* skip */ }
    }
    doc.font(FONT.body).fontSize(7).fillColor(PALETTE.mute).text(
      `${model.meta.footerNote ?? model.title} — printed ${model.meta.printedAt} · page ${i - range.start + 1} of ${total}`,
      MARGIN, fy, { lineBreak: false },
    );
  }
```

> `qrBuffer` is created in PR2 Task 12; for PR1, gate the QR block behind `model.meta.liveUrl` which callers don't yet set, so it stays inert. Move the `qrBuffer` import + helper into `doc-theme.ts` in Task 12; until then `qrPng` stays `null`. To keep PR1 self-contained, define a local `async function qrBuffer(_: string) { return null; }` stub and replace it in Task 12.

- [ ] **Step 4: Run tests, verify pass**

Run: `npm run test -w web -- doc-render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/doc-render.ts packages/engine/src/exports/types.ts apps/web/src/server/__tests__/doc-render.test.ts
git commit -m "feat(exports): footer sponsor line, live-page QR slot, page N of M"
```

---

### Task 7: Wire branding + description + liveUrl into every caller

**Files:**
- Modify: `apps/web/src/server/usecases/exports.ts:124-291`
- Modify: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/poster.pdf/route.ts`
- Test: `apps/web/src/server/usecases/__tests__/exports.test.ts`

**Interfaces:**
- Produces: `buildCompetitionTimetable` attaches branding; every kind sets a `description`; timetable/standings set `liveUrl` to the public page.

- [ ] **Step 1: Write the failing test:**

```ts
it("buildCompetitionTimetable carries branding for a Pro org", async () => {
  const { auth, competitionId } = await proCompetition();
  const m = await buildCompetitionTimetable(auth, competitionId, { printedAt: "2026-07-19" });
  expect(m.branding?.orgName).toBeTruthy();
});

it("division timetable sets a description", async () => {
  const { auth, divisionId } = await proDivision();
  const m = await buildDivisionDocModel(auth, divisionId, "timetable", { printedAt: "2026-07-19" });
  expect(m.description).toMatch(/fixtures/i);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `DATABASE_URL=$TEST_DATABASE_URL npm run test -w web -- exports.test.ts -t "branding for a Pro org"`
Expected: FAIL.

- [ ] **Step 3: Edit `buildDivisionDocModel`** — add a per-kind description + liveUrl to `common` (after line 143):

```ts
    const DESCRIPTIONS: Record<string, string> = {
      timetable: "Every fixture across all courts, in play order.",
      standings: "Current table, updated as results land.",
      roster: "Squads by team — sign each player in before play.",
      participants: "All registered players by club and division.",
      scoresheet: "One sheet per match — record the score and sign off.",
    };
    const common = {
      printedAt: opts.printedAt,
      description: DESCRIPTIONS[kind],
      ...(branding !== undefined ? { branding } : {}),
      ...(opts.pageBreaks !== undefined ? { pageBreaks: opts.pageBreaks } : {}),
      ...(opts.landscape !== undefined ? { landscape: opts.landscape } : {}),
    };
```

For the `scoresheet` `DocModel.parse` block (line 255) add `description: DESCRIPTIONS.scoresheet,` and pass branding (already there).

- [ ] **Step 4: Edit `buildCompetitionTimetable`** (line 269) — resolve branding + orgName. Add an org+branding read and pass it:

```ts
  return withTenant(auth.orgId, async (tx) => {
    const [comp] = await tx<{ name: string; org_id: string; org_name: string }[]>`
      select c.name, c.org_id, org.name as org_name
      from competitions c join organizations org on org.id = c.org_id
      where c.id = ${competitionId}`;
    if (!comp) throw new HttpError(404, "competition not found");
    const branded = await hasFeature(auth.orgId, "exports.branded");
    const branding = branded
      ? {
          orgName: comp.org_name,
          ...(((await resolveSponsors(comp.org_id, competitionId)).map((s) => ({ name: s.name, tier: s.tier }))) as { name: string; tier: string }[]).length > 0
            ? { sponsors: (await resolveSponsors(comp.org_id, competitionId)).map((s) => ({ name: s.name, tier: s.tier })) }
            : {},
        }
      : undefined;
    // ... existing divisions loop ...
    return buildTimetable(comp.name, all, {
      printedAt: opts.printedAt,
      description: "Every fixture across all divisions.",
      ...(branding ? { branding } : {}),
      pageBreaks: opts.pageBreaks ?? "per_division",
    });
  });
```

> Refactor note: extract a small `orgBranding(tx, orgId, orgName, competitionId)` helper to avoid the double `resolveSponsors` call above; the illustrative inline is intentionally un-DRY — the implementer should factor it into one call. Keep `hasFeature`/`requireFeature` imports.

- [ ] **Step 5: Edit `poster.pdf/route.ts`** — feed `resolveSponsors(org.id, competition.id)` into the model's branding sponsors (match the existing branding shape in that route; if it already renders sponsor names, convert them to `{name, tier}`).

- [ ] **Step 6: Run tests, verify pass**

Run: `DATABASE_URL=$TEST_DATABASE_URL npm run test -w web -- exports.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/server/usecases/exports.ts "apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/poster.pdf/route.ts" apps/web/src/server/usecases/__tests__/exports.test.ts
git commit -m "feat(exports): brand competition timetable + poster; per-kind descriptions"
```

---

### Task 8: XLSX header — org name + sponsor row

**Files:**
- Modify: `apps/web/src/server/doc-render.ts:162-185` (`docModelToXlsx`)
- Test: `apps/web/src/server/__tests__/doc-render.test.ts`

- [ ] **Step 1: Failing test:**

```ts
it("xlsx header includes org name + sponsor row when branded", async () => {
  const { docModelToXlsx } = await import("../doc-render");
  const ExcelJS = (await import("exceljs")).default;
  const buf = await docModelToXlsx(model({ orgName: "Riverside SC", sponsors: [{ name: "Acme", tier: "title" }] }));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const cells = wb.worksheets[0].getSheetValues().flat().map(String).join(" ");
  expect(cells).toContain("Riverside SC");
  expect(cells).toContain("Acme");
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm run test -w web -- doc-render.test.ts -t "xlsx header"`
Expected: FAIL.

- [ ] **Step 3: Edit `docModelToXlsx`** — after the title row (line 165) insert:

```ts
  if (model.branding?.orgName) sheet.addRow([model.branding.orgName]).font = { size: 11, color: { argb: "FF52525B" } };
  const sp = model.branding?.sponsors ?? [];
  if (sp.length > 0) sheet.addRow([`Sponsors: ${sp.map((s) => s.name).join(", ")}`]).font = { italic: true, size: 9 };
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm run test -w web -- doc-render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/doc-render.ts apps/web/src/server/__tests__/doc-render.test.ts
git commit -m "feat(exports): name the org + sponsors in xlsx header"
```

---

### Task 9: PR1 close — typecheck, smoke (branded/plain), help note

**Files:**
- Modify: `scripts/smoke.ts`
- Modify: `content/help/**` (branded-vs-plain note; fuller page in PR2)

- [ ] **Step 1** Add to `scripts/smoke.ts`: pro path downloads a division timetable PDF and asserts the bytes contain `ORDER OF PLAY`; free path asserts they do not. Follow the file's existing pro/free harness.
- [ ] **Step 2** Run `npm run typecheck` — expect 0 errors. Fix any exhaustive-switch fallout.
- [ ] **Step 3** Run `npm run smoke` (or the documented command) — expect green.
- [ ] **Step 4: Commit**

```bash
git add scripts/smoke.ts content/help
git commit -m "test(exports): smoke asserts branded vs plain timetable"
```

---

# PR2 — Officials rota + admit tickets + Documents panel

### Task 10: `DocKind` extension + rota builder

**Files:**
- Modify: `packages/engine/src/exports/types.ts:41-49` + new input interface
- Modify: `packages/engine/src/exports/build.ts`
- Test: `packages/engine/src/exports/build.test.ts`

**Interfaces:**
- Produces: `DocKind` += `officials_rota`, `admit_ticket`. `ExportOfficialDuty` interface. `buildOfficialsRota(title, officials, opts): DocModel`.

```ts
export interface ExportOfficialDuty {
  at: string;          // pre-formatted venue-local time string (built server-side)
  court: string | null;
  compDivision: string;
  role: string;
  opponents: string;   // "Falcons vs Hawks"
  response: "pending" | "accepted" | "declined";
}
export interface ExportOfficialSchedule {
  officialName: string;
  duties: ExportOfficialDuty[];
}
```

- [ ] **Step 1: Golden test** in `build.test.ts`:

```ts
import { buildOfficialsRota } from "./build.ts";

it("buildOfficialsRota: one section per official with a duties table", () => {
  const m = buildOfficialsRota("Summer League — Officials", [
    { officialName: "Sam Ref", duties: [
      { at: "Sat 19 Jul 09:00", court: "1", compDivision: "Summer · Div 1",
        role: "Referee", opponents: "Falcons vs Hawks", response: "accepted" },
    ] },
  ], { printedAt: "2026-07-19", pageBreaks: "per_team" });
  expect(m.kind).toBe("officials_rota");
  expect(m.sections).toHaveLength(1);
  expect(m.sections[0].heading).toBe("Sam Ref");
  expect(m.sections[0].table?.rows[0]).toContain("Referee");
  expect(m.sections[0].signatures).toBeTruthy();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm run test -w @seazn/engine -- build.test.ts -t buildOfficialsRota`
Expected: FAIL.

- [ ] **Step 3: Extend `DocKind`** (types.ts) — add `"officials_rota", "admit_ticket"` to the enum, and add the input interfaces above.

- [ ] **Step 4: Add `buildOfficialsRota`** to `build.ts`:

```ts
const ROTA_COLUMNS = ["When", "Court", "Competition · Division", "Role", "Match", "Response"];

export function buildOfficialsRota(
  title: string,
  officials: readonly ExportOfficialSchedule[],
  opts: BuildOpts,
): DocModel {
  const perOfficial = (opts.pageBreaks ?? "auto") === "per_team";
  const sections: DocSection[] = officials.map((o, i) => ({
    heading: o.officialName,
    ...(o.duties.length === 0 ? { subheading: "No duties assigned" } : {}),
    ...(o.duties.length > 0
      ? {
          table: {
            columns: ROTA_COLUMNS,
            rows: o.duties.map((d) => [
              d.at, d.court ?? "—", d.compDivision, d.role, d.opponents,
              d.response === "accepted" ? "Accepted" : d.response === "declined" ? "Declined" : "Pending",
            ]),
          },
        }
      : {}),
    signatures: ["Official signature", "Time on", "Time off"],
    ...(perOfficial && i > 0 ? { pageBreakBefore: true } : {}),
  }));
  return base("officials_rota", title, sections, opts);
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `npm run test -w @seazn/engine -- build.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck the enum blast radius**

Run: `npm run typecheck`
Expected: FAIL initially at every exhaustive `DocKind` switch — add `officials_rota`/`admit_ticket` arms (or leave `admit_ticket` for Task 11). Fix all, re-run to 0.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/exports/types.ts packages/engine/src/exports/build.ts packages/engine/src/exports/build.test.ts
git commit -m "feat(exports): officials_rota + admit_ticket kinds; buildOfficialsRota"
```

---

### Task 11: Admit-ticket builder

**Files:**
- Modify: `packages/engine/src/exports/build.ts`, `types.ts`
- Test: `packages/engine/src/exports/build.test.ts`

**Interfaces:**
- Produces: `ExportTicket` interface + `buildAdmitTickets(title, tickets, opts): DocModel` — one `DocSection` per ticket with `columnsHint: 2`, carrying the QR **URL** (not pixels) via a new `DocSection.ticket` payload.

```ts
export interface ExportTicket {
  maskedName: string;
  competition: string;
  dates: string;
  ref: string;
  status: string;   // "CONFIRMED" | "PAID" | ...
  qrUrl: string;    // `${origin}/r/${ref}` — URL only
  seq: number;      // 1-based sequence for cutting
}
```

- Add to `DocSection` (types.ts): `ticket: z.object({ maskedName, competition, dates, ref, status, qrUrl, seq }).optional()`.

- [ ] **Step 1: Golden test:**

```ts
import { buildAdmitTickets } from "./build.ts";

it("buildAdmitTickets: one 2-up section per ticket, QR is a URL not pixels", () => {
  const m = buildAdmitTickets("Summer League — Tickets", [
    { maskedName: "S. Ref", competition: "Summer League", dates: "19 Jul",
      ref: "AB12CD", status: "CONFIRMED", qrUrl: "https://x/r/AB12CD", seq: 1 },
  ], { printedAt: "2026-07-19" });
  expect(m.kind).toBe("admit_ticket");
  expect(m.sections[0].columnsHint).toBe(2);
  expect(m.sections[0].ticket?.qrUrl).toBe("https://x/r/AB12CD");
  expect(JSON.stringify(m)).not.toMatch(/data:image/); // no pixels in the model
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm run test -w @seazn/engine -- build.test.ts -t buildAdmitTickets`
Expected: FAIL.

- [ ] **Step 3: Add `buildAdmitTickets`:**

```ts
export function buildAdmitTickets(
  title: string,
  tickets: readonly ExportTicket[],
  opts: BuildOpts,
): DocModel {
  const sections: DocSection[] = tickets.map((t) => ({ columnsHint: 2, ticket: t }));
  return base("admit_ticket", title, sections, opts);
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm run test -w @seazn/engine -- build.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/exports/types.ts packages/engine/src/exports/build.ts packages/engine/src/exports/build.test.ts
git commit -m "feat(exports): buildAdmitTickets (QR URL in model, 2-up sections)"
```

---

### Task 12: Renderer — QR helper + ticket layout

**Files:**
- Modify: `apps/web/src/server/doc-theme.ts` (add `qrBuffer`)
- Modify: `apps/web/src/server/doc-render.ts` (ticket section drawer + QR pre-pass)
- Test: `apps/web/src/server/__tests__/doc-render.test.ts`

**Interfaces:**
- Consumes: `DocSection.ticket`, `qrcode`.
- Produces: `qrBuffer(url): Promise<Buffer|null>`; ticket sections render the courtside pass (night masthead card, title, masked name, mono ref, status stamp, dashed perforation, QR, "SCAN AT THE DESK / ADMIT ONE", seq).

- [ ] **Step 1: Add `qrBuffer` to `doc-theme.ts`:**

```ts
import QRCode from "qrcode";
/** QR PNG bytes for a URL. Failure → null (ticket renders without QR). */
export async function qrBuffer(url: string): Promise<Buffer | null> {
  try { return await QRCode.toBuffer(url, { margin: 1, width: 180 }); }
  catch { return null; }
}
```

Replace the Task 6 `qrBuffer` stub import in `doc-render.ts` with the real one from `./doc-theme`.

- [ ] **Step 2: Failing test:**

```ts
it("renders admit tickets with ref + ADMIT ONE", async () => {
  const ticketModel: DocModel = {
    kind: "admit_ticket", title: "Tickets", meta: { printedAt: "2026-07-19" },
    branding: { orgName: "Riverside SC" },
    sections: [{ columnsHint: 2, ticket: {
      maskedName: "S. Ref", competition: "Summer League", dates: "19 Jul",
      ref: "AB12CD", status: "CONFIRMED", qrUrl: "https://x/r/AB12CD", seq: 1 } }],
    pageBreaks: "auto",
  };
  const r = await render(ticketModel); // reuse the Task 4 render() spy
  expect(r.text.join(" ")).toContain("AB12CD");
  expect(r.text.join(" ")).toContain("ADMIT ONE");
  expect(r.images).toBeGreaterThan(0); // QR drawn
});
```

- [ ] **Step 3: Run it, verify it fails**

Run: `npm run test -w web -- doc-render.test.ts -t "admit tickets"`
Expected: FAIL (ticket section not drawn).

- [ ] **Step 4: Add a QR pre-pass + `drawTicket`.** In `docModelToPdf`, before the section loop, resolve all ticket QRs:

```ts
  const qrByRef = new Map<string, Buffer | null>();
  for (const s of model.sections) {
    if (s.ticket) qrByRef.set(s.ticket.ref, await qrBuffer(s.ticket.qrUrl));
  }
```

In `drawSection` (or a branch in the section loop), when `section.ticket` is set, call `drawTicket(doc, section.ticket, qrByRef.get(ref) ?? null)` instead of the table path. Implement `drawTicket` mirroring `r/[ref]/ticket.png`: night card header (SEAZN CLUB wordmark + org name), lime rule, competition title (Barlow), "ENTRANT" label + masked name, "YOUR REFERENCE" + mono ref + rotated status stamp, dashed vertical perforation, QR image, "SCAN AT THE DESK", "ADMIT ONE", small "No. {seq}". Two per A4 via the existing `columnsHint===2` pairing in the section loop; add crop ticks at the page-half.

```ts
function drawTicket(doc: PDFKit.PDFDocument, t: NonNullable<DocSection["ticket"]>, qr: Buffer | null): void {
  const w = doc.page.width - MARGIN * 2;
  const top = doc.y;
  const cardH = 200;
  // card
  doc.roundedRect(MARGIN, top, w, cardH, 10).fill("#ffffff");
  doc.roundedRect(MARGIN, top, w, 44, 10).fill(PALETTE.night);
  doc.font(FONT.displayBold).fontSize(16).fillColor(PALETTE.cream)
    .text("SEAZN", MARGIN + 16, top + 14, { continued: true })
    .fillColor(PALETTE.lime).text(" CLUB");
  doc.rect(MARGIN, top + 44, w, 4).fill(PALETTE.lime);
  doc.font(FONT.displayBold).fontSize(22).fillColor(PALETTE.ink)
    .text(t.competition.toUpperCase(), MARGIN + 16, top + 60);
  doc.font(FONT.body).fontSize(9).fillColor(PALETTE.mute).text("ENTRANT", MARGIN + 16, top + 100, { characterSpacing: 2 });
  doc.font(FONT.displayBold).fontSize(16).fillColor(PALETTE.ink).text(t.maskedName, MARGIN + 16, top + 112);
  doc.font(FONT.body).fontSize(9).fillColor(PALETTE.mute).text("YOUR REFERENCE", MARGIN + 16, top + 140, { characterSpacing: 2 });
  doc.font("Courier-Bold").fontSize(20).fillColor(PALETTE.ink).text(t.ref, MARGIN + 16, top + 152);
  // stub
  const stubX = MARGIN + w - 150;
  doc.moveTo(stubX, top).lineTo(stubX, top + cardH).dash(3, { space: 3 }).strokeColor(PALETTE.hairline).stroke().undash();
  if (qr) { try { doc.image(qr, stubX + 35, top + 40, { width: 80 }); } catch { /* skip */ } }
  doc.font(FONT.body).fontSize(8).fillColor(PALETTE.mute).text("SCAN AT THE DESK", stubX + 20, top + 128, { characterSpacing: 1 });
  doc.font(FONT.displayBold).fontSize(14).fillColor(PALETTE.night).text("ADMIT ONE", stubX + 30, top + 145, { characterSpacing: 4 });
  doc.font(FONT.body).fontSize(7).fillColor(PALETTE.mute).text(`No. ${t.seq}`, stubX + 20, top + 175);
  doc.y = top + cardH + 16;
  doc.fillColor(PALETTE.ink);
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `npm run test -w web -- doc-render.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/doc-theme.ts apps/web/src/server/doc-render.ts apps/web/src/server/__tests__/doc-render.test.ts
git commit -m "feat(exports): admit-ticket layout + QR pre-pass (courtside pass)"
```

---

### Task 13: Server assembly — rota + tickets docs

**Files:**
- Modify: `apps/web/src/server/usecases/exports.ts`
- Test: `apps/web/src/server/usecases/__tests__/exports.test.ts`

**Interfaces:**
- Produces: `buildOfficialsRotaDoc(auth, divisionId): Promise<DocModel>`, `buildAdmitTicketsDoc(auth, competitionId): Promise<DocModel>`, `buildMyRotaDoc(userId): Promise<DocModel>` (SEAZN-neutral).

- [ ] **Step 1: Failing tests** — rota lists an official's duties with response; tickets carry masked names + `/r/[ref]` URLs; `buildMyRotaDoc` has no branding.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** in `exports.ts`. Rota reads `fixture_officials` joined to `officials` scoped by division (org-scoped via `withTenant`), formats `at` in venue tz (reuse the tz-format helper the officiating lane uses — grep `venue_tz` formatting in `me-officiating`/`me` UI), attaches branding via the Task 7 helper. Tickets read confirmed registrations for the competition (mask names with the same helper `publicRegistrationStatusByRef` uses) and set `qrUrl = ${origin}/r/${ref}`. `buildMyRotaDoc(userId)` calls `getMyOfficiating(userId)` (superuser, cross-org), groups by `official_id`/org, builds one rota with `branding: undefined`.

```ts
export async function buildMyRotaDoc(userId: string, opts: ExportOpts, origin: string): Promise<DocModel> {
  const { assignments } = await getMyOfficiating(userId);
  const byOfficial = new Map<string, ExportOfficialSchedule>();
  for (const a of assignments) {
    const key = a.official_id;
    const s = byOfficial.get(key) ?? { officialName: a.org_name, duties: [] };
    s.duties.push({
      at: formatVenue(a.scheduled_at, a.venue_tz),
      court: a.court_label,
      compDivision: `${a.competition_name} · ${a.division_name}`,
      role: a.role_key,
      opponents: `${a.home_name ?? "TBD"} vs ${a.away_name ?? "TBD"}`,
      response: a.response,
    });
    byOfficial.set(key, s);
  }
  return buildOfficialsRota("My officiating rota", [...byOfficial.values()], {
    printedAt: opts.printedAt,
    description: "Your upcoming duties across every organisation.",
    pageBreaks: "per_team",
  });
}
```

- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/usecases/exports.ts apps/web/src/server/usecases/__tests__/exports.test.ts
git commit -m "feat(exports): rota + tickets + personal-rota doc assembly"
```

---

### Task 14: Routes — rota kind, tickets, `/me/rota.pdf`

**Files:**
- Modify: `apps/web/src/app/api/v1/divisions/[id]/exports/[kind]/route.ts:11` (add `officials_rota`)
- Create: `apps/web/src/app/api/v1/competitions/[id]/exports/tickets/route.ts`
- Create: `apps/web/src/app/api/v1/me/rota.pdf/route.ts`
- Test: `apps/web/src/server/usecases/__tests__/exports.test.ts` (authz), or a route test if the repo has route tests.

**Interfaces:**
- Consumes: `buildOfficialsRotaDoc`, `buildAdmitTicketsDoc`, `buildMyRotaDoc`, `docModelToPdf/Xlsx`.

- [ ] **Step 1** Read `node_modules/next/dist/docs/` route-handler guide before editing routes (vendored Next — signatures differ from training data).
- [ ] **Step 2: Failing authz test** — `/me/rota.pdf` returns only the caller's own assignments (seed two officials, assert the PDF contains only the caller's org/fixtures).
- [ ] **Step 3** Extend the `[kind]` enum with `officials_rota`; route it to `buildOfficialsRotaDoc`. Create the tickets route (`format=pdf` only) mirroring the existing export route's raw-file + `Content-Disposition` shape. Create `/me/rota.pdf`: resolve the session user, `buildMyRotaDoc(userId, ...)`, `docModelToPdf`, attachment. Scope strictly to the session user — no org tenant.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/api/v1/divisions/[id]/exports/[kind]/route.ts" "apps/web/src/app/api/v1/competitions/[id]/exports/tickets/route.ts" "apps/web/src/app/api/v1/me/rota.pdf/route.ts" apps/web/src/server/usecases/__tests__/exports.test.ts
git commit -m "feat(exports): rota + tickets + /me/rota.pdf routes"
```

---

### Task 15: Documents panel on the schedule board

**Files:**
- Create: `apps/web/src/components/v2/board/documents-menu.tsx`
- Modify: `apps/web/src/components/v2/board/board-tray.tsx`
- Modify: `apps/web/src/lib/messages.ts` + `lib/messages/*.json` (ui strings)
- Test: an existing board component test or a new one asserting the menu renders the four rows with correct hrefs.

**Interfaces:**
- Consumes: division id / competition id from board props; `useMsg`.
- Produces: a "Documents" control listing Order of play (PDF/XLSX), Match sheets (PDF/XLSX), Officials rota (PDF/XLSX), Admit tickets (PDF only), each linking to the export routes.

- [ ] **Step 1** Add ui strings (`documents.title`, `documents.orderOfPlay`, `documents.matchSheets`, `documents.rota`, `documents.tickets`, `documents.pdf`, `documents.xlsx`, `me.downloadRota`) to `messages.ts` `ui` namespace; run the `translate` pass for fr/es/nl so parity holds. Verify: `npm run i18n:check` (or the repo's parity command) green.
- [ ] **Step 2: Failing test** — render `<DocumentsMenu divisionId=… competitionId=…/>`, assert four rows + tickets row has no XLSX link.
- [ ] **Step 3** Build `documents-menu.tsx` (follow `board-tray.tsx` menu/popover pattern; per-row format flags: `tickets` → PDF only). Mount it in `board-tray.tsx`. Add **Download my rota** → `/api/v1/me/rota.pdf` in the `/me` officiating lane.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/v2/board apps/web/src/lib/messages.ts apps/web/src/lib/messages
git commit -m "feat(board): Documents menu (order of play, sheets, rota, tickets) + /me rota"
```

---

### Task 16: Live-page QR wiring

**Files:**
- Modify: `apps/web/src/server/usecases/exports.ts` (set `liveUrl` on branded timetable/standings)
- Test: `exports.test.ts`

- [ ] **Step 1: Failing test** — a branded division timetable sets `meta.liveUrl` to the public schedule URL.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3** Set `liveUrl` in `common` for `timetable`/`standings` to the public page (`${origin}/shared/${orgSlug}/${competitionSlug}` + schedule/standings path — reuse the slug lookup the poster/embed routes use). Thread `origin` into `buildDivisionDocModel` (the route already has the request URL).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/usecases/exports.ts apps/web/src/server/usecases/__tests__/exports.test.ts
git commit -m "feat(exports): branded timetable/standings carry a live-page QR"
```

---

### Task 17: Help page + smoke + registry

**Files:**
- Create: `content/help/matchday-documents.md`
- Modify: help slug registry (grep the registry test that lists slugs — memory: help-slug-registry test)
- Modify: `scripts/smoke.ts`

- [ ] **Step 1** Write `content/help/matchday-documents.md`: what each document is (order of play, match sheets, rota, tickets), PDF vs XLSX, branded (Pro) vs plain, QR check-in on tickets, the personal `/me` rota. Register the slug so the registry test passes.
- [ ] **Step 2** Extend `scripts/smoke.ts`: pro path also generates an officials rota + admit tickets (assert non-empty PDF, ref + ADMIT ONE present); reuse the Task 9 branded/plain timetable assertion.
- [ ] **Step 3** Run the help registry test + smoke — expect green.
- [ ] **Step 4: Commit**

```bash
git add content/help scripts/smoke.ts
git commit -m "docs+test(exports): matchday-documents help + rota/ticket smoke"
```

---

### Task 18: PR2 close — full verify + live visual check

- [ ] **Step 1** `npm run typecheck` → 0. `npm run test` (engine + web) → green. `npm run smoke` → green. `npm run i18n:check` → parity green.
- [ ] **Step 2** Main-thread Playwright visual verify (implementer has no browser — this runs on the main thread): render a branded timetable, an officials rota, and an admit-ticket run; snapshot each; eyeball masthead / lime pitch-line / zebra table / QR against `r/[ref]/ticket.png` and the email templates at desktop + print widths. Confirm free-tier timetable stays plain.
- [ ] **Step 3** Update `HANDOFF.md` per AGENTS.md protocol.
- [ ] **Step 4: Commit**

```bash
git add HANDOFF.md
git commit -m "chore(v12): handoff + verify notes"
```

---

## Self-Review

**Spec coverage** (§ = spec section):
- §3 design system → Tasks 2 (tokens/fonts), 4 (masthead/eyebrow/description), 5 (zebra), 6 (footer/sponsors), 12 (ticket). ✓
- §4 PR1 model/type changes → Task 1; brandingFor/callers → Tasks 3, 7. ✓
- §4 renderer decision (pdfkit-native ticket) → Task 12. ✓
- §4 PR2 kinds/builders/routes/panel → Tasks 10, 11, 13, 14, 15. ✓
- §5 data sources → Tasks 3 (sponsors), 13 (`getMyOfficiating`, ticket status). ✓
- §6 improvements: description (Task 7), eyebrow (Task 2/4), live QR (Tasks 6/16), summary strip (fold into Task 7 description — **noted**), empty states (Task 10 rota "No duties"), ticket crop/seq (Tasks 11/12). ✓
- §7 i18n/help/smoke/tests → Tasks 15, 17, 9, and per-task tests. ✓
- §8 acceptance → Tasks 9, 18. ✓
- §9 decisions: sponsors `{name,tier}` (Task 1), pdfkit ticket (Task 12), `/me` neutral (Tasks 13/14), draw-call spy (Task 4), all-callers (Task 7), TTFs (Task 2). ✓

**Gap found & folded:** the §6 "summary strip" (N fixtures · M courts) is not its own task — it is implemented as part of the per-kind `description` in Task 7 (the description string composes the count). If a distinct strip is wanted, it is a one-line addition to `drawTitleBlock` (Task 4). Flagged, not silently dropped.

**Placeholder scan:** the route/panel/help tasks (14, 15, 17) describe behaviour + exact files but defer some boilerplate to "follow the existing pattern" — acceptable only because the exact sibling file is named for the implementer to mirror; all novel logic (builders, renderer, gate, types) carries real code.

**Type consistency:** `DocBranding.sponsors: {name,tier}[]` used identically in Tasks 1, 3, 6, 7, 8; `ExportOfficialSchedule`/`ExportTicket` defined in Tasks 10/11 and consumed in 13; `qrBuffer` stubbed in Task 6, realised in Task 12 (noted inline). `formatVenue` (Task 13) must be sourced from the existing venue-tz formatter — flagged in the task.
