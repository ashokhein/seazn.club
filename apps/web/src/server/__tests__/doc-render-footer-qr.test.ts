import { describe, it, expect, vi } from "vitest";

// The stock doc-render spy throws geometry away, which is exactly what this
// bug lives in — so this one records the x/y/width of every draw.
interface TextCall { s: string; x?: number; y?: number; opts?: { width?: number; align?: string } }
interface ImageCall { x: number; y: number; width?: number }
const rec = { text: [] as TextCall[], images: [] as ImageCall[] };

vi.mock("pdfkit", () => {
  class FakeDoc {
    page = { width: 595.28, height: 841.89 };
    y = 40;
    private endCb?: () => void;
    on(ev: string, cb: () => void) { if (ev === "end") this.endCb = cb; return this; }
    registerFont() { return this; }
    font() { return this; } fontSize() { return this; }
    fillColor() { return this; } strokeColor() { return this; } lineWidth() { return this; }
    text(s: unknown, x?: number, y?: number, opts?: TextCall["opts"]) {
      rec.text.push({ s: String(s), ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}), ...(opts ? { opts } : {}) });
      return this;
    }
    image(_b: unknown, x: number, y: number, opts?: { width?: number }) {
      rec.images.push({ x, y, ...(opts?.width !== undefined ? { width: opts.width } : {}) });
      return this;
    }
    rect() { return this; } roundedRect() { return this; } circle() { return this; }
    moveTo() { return this; } lineTo() { return this; } stroke() { return this; }
    fill() { return this; }
    dash() { return this; } undash() { return this; } moveDown() { return this; }
    addPage() { return this; } switchToPage() { return this; }
    widthOfString() { return 10; }
    bufferedPageRange() { return { start: 0, count: 1 }; }
    end() { this.endCb?.(); }
  }
  return { default: FakeDoc };
});

import { docModelToPdf } from "../doc-render";
import type { DocModel } from "@seazn/engine/exports";

const MARGIN = 40;
const PAGE_W = 595.28;

const model = (liveUrl?: string): DocModel => ({
  kind: "timetable",
  title: "Summer League — Div 1",
  meta: { printedAt: "2026-07-19", ...(liveUrl !== undefined ? { liveUrl } : {}) },
  sections: [{ table: { columns: ["Time", "Home"], rows: [["09:00", "Falcons"]] } }],
  pageBreaks: "auto",
});

async function render(m: DocModel) {
  rec.text = [];
  rec.images = [];
  await docModelToPdf(m);
  return rec;
}

// The live-page QR is drawn at the bottom-right of every page, and so is the
// "Powered by seazn.club" attribution — both anchored to the same right edge,
// at overlapping heights. On any export with a public live page the QR sat on
// top of the wordmark, which is both ugly and a scanning risk: an obscured
// finder pattern is a QR that phones refuse to read.
describe("doc-render footer — QR and attribution", () => {
  it("keeps the attribution clear of the QR when one is drawn", async () => {
    const r = await render(model("https://seazn.club/shared/o/c/d"));
    expect(r.images).toHaveLength(1);
    const qr = r.images[0]!;
    const qrLeft = qr.x;

    const attribution = r.text.find((t) => t.s.includes("Powered by"));
    expect(attribution).toBeDefined();
    // Right-aligned inside a box starting at MARGIN, so its right edge is
    // MARGIN + width. That edge must stop before the QR begins.
    const right = (attribution!.x ?? 0) + (attribution!.opts?.width ?? 0);
    expect(right).toBeLessThanOrEqual(qrLeft);
  });

  it("still uses the full width when there is no QR", async () => {
    // Private competitions get no QR (the /shared page 404s), and the
    // attribution should not be needlessly indented on those.
    const r = await render(model());
    expect(r.images).toHaveLength(0);
    const attribution = r.text.find((t) => t.s.includes("Powered by"));
    expect(attribution!.opts?.width).toBe(PAGE_W - MARGIN * 2);
  });

  it("draws the QR inside the page, above the footer baseline", async () => {
    const r = await render(model("https://seazn.club/shared/o/c/d"));
    const qr = r.images[0]!;
    expect(qr.x + (qr.width ?? 0)).toBeLessThanOrEqual(PAGE_W - MARGIN);
    expect(qr.y).toBeGreaterThan(0);
  });
});
