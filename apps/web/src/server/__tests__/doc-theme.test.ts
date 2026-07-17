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
