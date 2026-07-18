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
    rect() { return this; } roundedRect() { return this; } circle() { return this; }
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

  it("draws the red ball alongside the wordmark + lime line (the full mark)", async () => {
    // a timetable model has no other red element, so this is a clean,
    // non-tautological assertion for PALETTE.ball (#ef4444).
    const r = await render(model({ orgName: "Riverside SC", colors: { primary: "#150b36" } }));
    expect(r.fills).toContain("#ef4444");
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

  it("carries a 'Powered by seazn.club' attribution on unbranded (free-tier) docs", async () => {
    const r = await render(model()); // no branding
    expect(r.text.join(" ")).toContain("seazn.club");
  });

  it("carries a 'Powered by seazn.club' attribution on branded (Pro) docs too", async () => {
    const r = await render(model({ orgName: "Riverside SC" }));
    expect(r.text.join(" ")).toContain("seazn.club");
  });
});

describe("doc-render tickets", () => {
  const ticketModel = (status: string): DocModel => ({
    kind: "admit_ticket", title: "Tickets", meta: { printedAt: "2026-07-19" },
    branding: { orgName: "Riverside SC" },
    sections: [{ columnsHint: 2, ticket: {
      maskedName: "S. Ref", competition: "Summer League", dates: "19 Jul",
      ref: "AB12CD", status, qrUrl: "https://x/r/AB12CD", seq: 1 } }],
    pageBreaks: "auto",
  });

  it("renders admit tickets with ref + ADMIT ONE", async () => {
    const r = await render(ticketModel("CONFIRMED")); // reuse the Task 4 render() spy
    expect(r.text.join(" ")).toContain("AB12CD");
    expect(r.text.join(" ")).toContain("ADMIT ONE");
    expect(r.images).toBeGreaterThan(0); // QR drawn
  });

  it("stamps a CONFIRMED ticket green, not the generic ball-red (Task 12b)", async () => {
    const r = await render(ticketModel("CONFIRMED"));
    expect(r.fills).toContain("#047857");
    // the brand ball itself is legitimately ball-red — one on the page
    // masthead (branded ticketModel) + one on the ticket card — but the
    // CONFIRMED stamp colour must never reuse ball-red, so no THIRD hit.
    expect(r.fills.filter((c) => c === "#ef4444")).toHaveLength(2);
  });

  it("stamps a WAITLISTED ticket blue (Task 12b)", async () => {
    // real domain value is "waitlisted" (registrations.status enum;
    // r/[ref]/ticket.png/route.tsx STAMP map) — not "waitlist".
    const r = await render(ticketModel("WAITLISTED"));
    expect(r.fills).toContain("#0369a1");
  });

  it("falls back to pending amber for an unrecognized status (Task 12b)", async () => {
    const r = await render(ticketModel("SOME_UNKNOWN_STATUS"));
    expect(r.fills).toContain("#b45309");
    // brand ball contributes two #ef4444 fills (masthead + ticket card, see
    // above); the fallback stamp colour itself must not add a third.
    expect(r.fills.filter((c) => c === "#ef4444")).toHaveLength(2);
  });

  it("carries the org name on the ticket card header, uppercased (Task 12b)", async () => {
    const r = await render(ticketModel("CONFIRMED"));
    // page masthead draws it once already — the card must carry a SECOND
    // copy (cut-out tickets lose the page masthead), so require >= 2 hits.
    const hits = r.text.filter((t) => t === "RIVERSIDE SC").length;
    expect(hits).toBeGreaterThanOrEqual(2);
  });
});

describe("doc-render xlsx", () => {
  it("xlsx header includes org name + sponsor row when branded", async () => {
    const { docModelToXlsx } = await import("../doc-render");
    const ExcelJS = (await import("exceljs")).default;
    const buf = await docModelToXlsx(model({ orgName: "Riverside SC", sponsors: [{ name: "Acme", tier: "title" }] }));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const cells = wb.worksheets[0].getSheetValues().flat().map(String).join(" ");
    expect(cells).toContain("Riverside SC");
    expect(cells).toContain("Acme");
  });
});
