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

describe("doc-render tables", () => {
  it("renders a night header row + data cells for a table", async () => {
    const r = await render(model()); // reuse the render() spy + timetable model
    expect(r.text.join(" ")).toContain("Time");     // header cell
    expect(r.text.join(" ")).toContain("Falcons");  // data cell
    expect(r.fills).toContain("#150b36");            // night header-row background
  });
});

describe("doc-render footer", () => {
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
});
