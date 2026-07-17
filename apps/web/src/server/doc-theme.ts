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
  Body: "Inter-Regular.otf", // Inter ships as OTF here (static weights)
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
