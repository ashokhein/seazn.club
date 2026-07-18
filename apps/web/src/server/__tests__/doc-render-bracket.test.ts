// Bracket-poster renderer (PROMPT-62 §4) — pdfkit draw-call spy (same harness
// as doc-render.test.ts; position/clipping is proven separately by
// doc-bracket-geometry.test.ts, which the spy cannot see).
import { describe, it, expect, vi } from "vitest";

const rec = { text: [] as string[], images: 0, fills: [] as string[] };
vi.mock("pdfkit", () => {
  class FakeDoc {
    page = { width: 841.89, height: 595.28 }; // landscape A4
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
    end() { this.endCb?.(); }
  }
  return { default: FakeDoc };
});

import { docModelToPdf } from "../doc-render";
import { buildBracket } from "@seazn/engine/exports";

const eight = [
  { id: "q1", round_no: 0, seq_in_round: 1, home: "Mexico", away: "Chile", headline: "2–0", decided: true },
  { id: "q2", round_no: 0, seq_in_round: 2, home: "Japan", away: "Ghana", headline: "1–0", decided: true },
  { id: "q3", round_no: 0, seq_in_round: 3, home: "France", away: "Peru", headline: null, decided: false },
  { id: "q4", round_no: 0, seq_in_round: 4, home: "Canada", away: "Italy", headline: null, decided: false },
  { id: "s1", round_no: 1, seq_in_round: 1, home: "Mexico", away: "Japan", headline: null, decided: false },
  { id: "s2", round_no: 1, seq_in_round: 2, home: null, away: null, headline: null, decided: false },
  { id: "f", round_no: 2, seq_in_round: 1, home: null, away: null, headline: null, decided: false },
];

async function render(branded: boolean) {
  rec.text = []; rec.images = 0; rec.fills = [];
  const model = buildBracket("Summer Cup — Open", eight, {
    printedAt: "2026-07-18T00:00:00Z",
    description: "The knockout tree — filled from live results.",
    ...(branded ? { branding: { orgName: "Riverside SC" } } : {}),
  });
  await docModelToPdf(model);
  return rec;
}

describe("doc-render bracket poster", () => {
  it("draws every team name, the headlines and the round labels", async () => {
    const r = await render(false);
    const all = r.text.join(" ");
    for (const name of ["Mexico", "Chile", "Japan", "Ghana", "France", "Peru", "Canada", "Italy"]) {
      expect(all).toContain(name);
    }
    expect(all).toContain("2–0");
    expect(all).toContain("QUARTER-FINALS");
    expect(all).toContain("FINAL");
    expect(all).toContain("TBD"); // unresolved feeds
  });

  it("free model carries no branded chrome (no lime fill, no wordmark)", async () => {
    const r = await render(false);
    expect(r.fills).not.toContain("#a3e635");
    expect(r.text.join(" ")).not.toContain("SEAZN");
  });

  it("branded model draws the masthead chrome", async () => {
    const r = await render(true);
    expect(r.fills).toContain("#a3e635");
    expect(r.text.join(" ")).toContain("SEAZN");
  });
});
