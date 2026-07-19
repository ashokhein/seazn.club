import "server-only";
// DocModel → bytes (Jul3/06 §2) — the effectful half of the export pipeline.
// The model decides WHAT to print; this file owns layout. PDF via pdfkit,
// XLSX via exceljs.
import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import type { DocModel, DocSection, DocTable } from "@seazn/engine/exports";
import { PALETTE, FONT, registerFonts, eyebrowFor, qrBuffer } from "./doc-theme";
import {
  bracketDePageGeometry,
  bracketPageGeometry,
  ladderPageGeometry,
} from "./doc-bracket-geometry";

const MARGIN = 40;

const MAST_H = 64; // masthead band height, page 1

import { publicStorageUrl } from "@/lib/supabase-storage";

/** Resolve a logo storage path (or an already-absolute URL) to bytes. Logos
 *  live in the PUBLIC Supabase bucket — there is no server-side byte reader,
 *  so fetch the public URL. Missing/broken → null, never throws (a broken
 *  export is worse than an unbranded one). */
async function resolveLogo(logoPath: string | undefined): Promise<Buffer | null> {
  if (!logoPath) return null;
  try {
    const url = /^https?:\/\//.test(logoPath) ? logoPath : publicStorageUrl(logoPath);
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
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
    doc.font(FONT.bodyMed).fontSize(10);
    doc.fillColor(PALETTE.cream).text(b.orgName.toUpperCase(), MARGIN, 22, {
      width: w - MARGIN * 2, align: "right", characterSpacing: 2,
    });
  }
  // logo, aspect-locked, right of wordmark
  if (logo) {
    try { doc.image(logo, w - MARGIN - 40, 12, { height: 40 }); } catch { /* skip */ }
  }
  // red ball riding the lime line, right-aligned — mirrors ticket.png's mark
  // (wordmark + ball + pitch line is the full SEAZN brand, not just the line)
  doc.circle(w - MARGIN - 4, MAST_H - 10, 4).fill(PALETTE.ball);
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

const TIER_RANK: Record<string, number> = { title: 0, gold: 1, silver: 2, partner: 3 };

function sponsorLine(sponsors: { name: string; tier: string }[]): string {
  return [...sponsors]
    .sort((a, b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9))
    .map((s) => s.name)
    .join("  ·  ");
}

function isLandscape(model: DocModel): boolean {
  // The bracket poster is landscape by nature (PROMPT-62 §4).
  return model.kind === "bracket" || model.sections.some((s) => s.table?.landscape === true);
}

/** Bracket poster (PROMPT-62 §4): one landscape sheet, scale-to-fit — the
 *  geometry (and its in-box guarantee) lives in doc-bracket-geometry.ts. */
function drawBracket(doc: PDFKit.PDFDocument, model: DocModel): void {
  // One painter, three geometries — single-elim two-sided, double-elim
  // two-lane, stepladder rungs all emit the same rect/line/label shape.
  const box = {
    x: MARGIN,
    y: doc.y + 6,
    w: doc.page.width - MARGIN * 2,
    h: doc.page.height - MARGIN - 24 - (doc.y + 6),
  };
  const g = model.bracket
    ? bracketPageGeometry(model.bracket, box)
    : model.bracketDe
      ? bracketDePageGeometry(model.bracketDe, box)
      : model.ladder
        ? ladderPageGeometry(model.ladder, box)
        : null;
  if (!g) return;
  for (const label of g.labels) {
    doc.font(FONT.display).fontSize(8).fillColor(PALETTE.mute)
      .text(label.text.toUpperCase(), label.x, label.y, {
        width: label.w, align: "center", lineBreak: false, ellipsis: true,
      });
  }
  for (const line of g.lines) {
    const [first, ...rest] = line.points;
    doc.moveTo(first![0], first![1]);
    for (const [x, y] of rest) doc.lineTo(x, y);
    doc.strokeColor(PALETTE.hairline).lineWidth(1).stroke();
  }
  for (const r of g.rects) {
    doc.roundedRect(r.x, r.y, r.w, r.h, 4).fillColor("#ffffff").fill();
    doc.roundedRect(r.x, r.y, r.w, r.h, 4).strokeColor(PALETTE.hairline).lineWidth(0.8).stroke();
    if (r.decided) {
      doc.rect(r.x, r.y, 2, r.h).fill(PALETTE.night);
    }
    const textW = r.w - 10 - (r.headline !== null ? 34 : 0);
    // F6: hard one-line clamp — pdfkit still wraps some long names with
    // lineBreak:false, overlapping the second side; bound height too.
    const oneLine = { width: textW, height: 10, lineBreak: false, ellipsis: true } as const;
    doc.font(r.isCenter ? FONT.bodyMed : FONT.body).fontSize(8).fillColor(PALETTE.ink)
      .text(r.home, r.x + 6, r.y + r.h / 2 - 10, oneLine);
    doc.font(FONT.body).fontSize(8).fillColor(PALETTE.ink)
      .text(r.away, r.x + 6, r.y + r.h / 2 + 2, oneLine);
    if (r.headline !== null) {
      doc.font(FONT.bodyMed).fontSize(8).fillColor(PALETTE.ink)
        .text(r.headline, r.x + r.w - 36, r.y + r.h / 2 - 4, { width: 32, align: "right", lineBreak: false });
    }
  }
  doc.fillColor(PALETTE.ink);
}

function isNumericColumn(table: DocTable, i: number): boolean {
  return table.rows.length > 0 &&
    table.rows.every((r) => r[i] === "" || typeof r[i] === "number" ||
      /^[\d.,:%+\-–—\s]*$/.test(String(r[i] ?? "")));
}

function drawTable(
  doc: PDFKit.PDFDocument,
  table: DocTable,
  badges?: Map<string, Buffer | null>,
): void {
  const width = doc.page.width - MARGIN * 2;
  // proportional widths: text-heavy columns get more room
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
  // PROMPT-60: tables carrying rowBadges indent the name column (index 1) so
  // crested and crestless rows align; the crest draws in the indent.
  const badged = table.rowBadges !== undefined;
  const BADGE_W = 13;

  const drawRow = (
    cells: readonly (string | number)[],
    header: boolean,
    zebra: boolean,
    badge?: Buffer | null,
  ) => {
    if (doc.y + rowHeight > doc.page.height - MARGIN) doc.addPage();
    const y = doc.y;
    if (header) doc.rect(MARGIN, y, width, rowHeight).fill(PALETTE.night);
    else if (zebra) doc.rect(MARGIN, y, width, rowHeight).fill(PALETTE.cream);
    let x = MARGIN;
    doc.font(header ? FONT.bodyMed : FONT.body).fontSize(header ? 8.5 : 9)
      .fillColor(header ? PALETTE.cream : PALETTE.ink);
    cells.forEach((cell, i) => {
      const indent = badged && !header && i === 1 ? BADGE_W : 0;
      doc.text(String(cell ?? ""), x + 4 + indent, y + 5, {
        width: colW[i]! - 8 - indent, height: rowHeight, ellipsis: true, lineBreak: false,
        align: numeric[i] ? "right" : "left",
      });
      x += colW[i]!;
    });
    if (badge) {
      try {
        doc.image(badge, MARGIN + colW[0]! + 3, y + 3.5, { fit: [11, 11] });
      } catch {
        // Unsupported image bytes — skip the crest, never break the export.
      }
    }
    if (!header) {
      doc.moveTo(MARGIN, y + rowHeight).lineTo(MARGIN + width, y + rowHeight)
        .strokeColor(PALETTE.hairline).lineWidth(0.5).stroke();
    }
    doc.y = y + rowHeight;
    doc.fillColor(PALETTE.ink);
  };

  drawRow(table.columns, true, false);
  table.rows.forEach((row, i) =>
    drawRow(
      row,
      false,
      i % 2 === 1,
      badged ? badges?.get(table.rowBadges?.[i] ?? "") ?? null : null,
    ),
  );
  doc.moveDown(0.5);
}

// Status-stamp colours — mirrors r/[ref]/ticket.png's STAMP map so a printed
// ticket and its digital twin read the same at a glance.
const STAMP_COLORS: Record<string, string> = {
  paid: "#047857",
  confirmed: "#047857",
  waitlisted: "#0369a1",
  pending: "#b45309",
  withdrawn: "#71717a",
};

function stampColorFor(status: string): string {
  // unrecognized status falls back to pending amber, mirroring ticket.png's
  // `STAMP[status] ?? STAMP.pending` — not the ball-red default.
  return STAMP_COLORS[status.toLowerCase()] ?? STAMP_COLORS.pending!;
}

/** The courtside pass — mirrors r/[ref]/ticket.png as a printable card.
 *  Night masthead card, mono ref + rotated status stamp, dashed
 *  perforation, QR on the stub, "ADMIT ONE". Two per A4 via columnsHint. */
function drawTicket(
  doc: PDFKit.PDFDocument,
  t: NonNullable<DocSection["ticket"]>,
  qr: Buffer | null,
  orgName: string | undefined,
): void {
  const w = doc.page.width - MARGIN * 2;
  const top = doc.y;
  const cardH = 200;
  // card
  doc.roundedRect(MARGIN, top, w, cardH, 10).fill("#ffffff");
  doc.roundedRect(MARGIN, top, w, 44, 10).fill(PALETTE.night);
  doc.font(FONT.displayBold).fontSize(16).fillColor(PALETTE.cream)
    .text("SEAZN", MARGIN + 16, top + 14, { continued: true })
    .fillColor(PALETTE.lime).text(" CLUB");
  // org identity, top-right of the card header — cut-out tickets lose the
  // page masthead, so each card carries its own org name (mirrors ticket.png).
  if (orgName) {
    doc.font(FONT.bodyMed).fontSize(9).fillColor(PALETTE.cream)
      .text(orgName.toUpperCase(), MARGIN + 16, top + 16, {
        width: w - 32, align: "right", characterSpacing: 2, lineBreak: false,
      });
  }
  // red ball riding the lime line, right-aligned — mirrors ticket.png's mark
  // so cut-out tickets (which lose the page masthead) carry the full mark.
  doc.circle(MARGIN + w - 12, top + 36, 3.5).fill(PALETTE.ball);
  doc.rect(MARGIN, top + 44, w, 4).fill(PALETTE.lime);
  doc.font(FONT.displayBold).fontSize(22).fillColor(PALETTE.ink)
    .text(t.competition.toUpperCase(), MARGIN + 16, top + 60);
  doc.font(FONT.body).fontSize(9).fillColor(PALETTE.mute).text("ENTRANT", MARGIN + 16, top + 100, { characterSpacing: 2 });
  doc.font(FONT.displayBold).fontSize(16).fillColor(PALETTE.ink).text(t.maskedName, MARGIN + 16, top + 112);
  doc.font(FONT.body).fontSize(9).fillColor(PALETTE.mute).text("YOUR REFERENCE", MARGIN + 16, top + 140, { characterSpacing: 2 });
  doc.font("Courier-Bold").fontSize(20).fillColor(PALETTE.ink).text(t.ref, MARGIN + 16, top + 152);
  // status stamp beside the reference block — a colour-coded underline plus
  // matching text, mirroring ticket.png's bordered STAMP chip.
  const stampColor = stampColorFor(t.status);
  doc.rect(MARGIN + 150, top + 163, 60, 2).fill(stampColor);
  doc.font(FONT.displayBold).fontSize(11).fillColor(stampColor)
    .text(t.status.toUpperCase(), MARGIN + 150, top + 148, { characterSpacing: 2, lineBreak: false });
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

/** Crop ticks at the page edges, at the mid-cut line between two stacked
 *  tickets (columnsHint 2) — a cuttable sheet instead of a full-width rule. */
function drawCropTicks(doc: PDFKit.PDFDocument, y: number): void {
  const tickLen = 10;
  doc.moveTo(0, y).lineTo(tickLen, y).strokeColor("#999999").lineWidth(1).stroke();
  doc.moveTo(doc.page.width - tickLen, y).lineTo(doc.page.width, y).strokeColor("#999999").lineWidth(1).stroke();
}

function drawSection(
  doc: PDFKit.PDFDocument,
  section: DocSection,
  badges?: Map<string, Buffer | null>,
): void {
  if (section.pageBreakBefore === true) doc.addPage();
  if (section.heading !== undefined) {
    doc.font("Helvetica-Bold").fontSize(13).fillColor("#111111").text(section.heading, MARGIN);
    doc.moveDown(0.2);
  }
  if (section.subheading !== undefined) {
    doc.font("Helvetica").fontSize(10).fillColor("#555555").text(section.subheading, MARGIN);
    doc.moveDown(0.3);
  }
  if (section.swatches !== undefined) {
    let x = MARGIN;
    const y = doc.y;
    for (const s of section.swatches) {
      doc.rect(x, y, 10, 10).fillColor(s.color).fill();
      doc.fillColor("#111111").font("Helvetica").fontSize(8).text(s.label, x + 14, y + 1, { lineBreak: false });
      x += 14 + doc.widthOfString(s.label) + 16;
    }
    doc.y = y + 16;
  }
  doc.fillColor("#111111");
  if (section.table !== undefined) drawTable(doc, section.table, badges);
  for (const line of section.formLines ?? []) {
    doc.font("Helvetica").fontSize(10).text(line, MARGIN);
    doc.moveDown(0.4);
  }
  if (section.signatures !== undefined && section.signatures.length > 0) {
    doc.moveDown(1);
    const width = doc.page.width - MARGIN * 2;
    const per = width / section.signatures.length;
    const y = doc.y;
    section.signatures.forEach((label, i) => {
      const x = MARGIN + i * per;
      doc
        .moveTo(x, y + 18)
        .lineTo(x + per - 20, y + 18)
        .strokeColor("#888888")
        .lineWidth(0.5)
        .stroke();
      doc.font("Helvetica").fontSize(8).fillColor("#555555").text(label, x, y + 21, { lineBreak: false });
    });
    doc.y = y + 36;
    doc.fillColor("#111111");
  }
  doc.moveDown(0.6);
}

/** Render a DocModel to PDF bytes. Layout only — content is the model's. */
export async function docModelToPdf(model: DocModel): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    layout: isLandscape(model) ? "landscape" : "portrait",
    margin: MARGIN,
    bufferPages: true,
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  registerFonts(doc);
  const logo = model.branding ? await resolveLogo(model.branding.logos?.[0]) : null;
  if (model.branding) drawMasthead(doc, model, logo); // Pro-only night chrome + logo
  else doc.y = MARGIN;
  drawTitleBlock(doc, model); // eyebrow + title + description for ALL

  // QR pre-pass (Task 12): pdfkit draws synchronously, so every ticket's QR
  // must be resolved to bytes BEFORE the section loop — no awaiting mid-draw.
  const qrByRef = new Map<string, Buffer | null>();
  for (const s of model.sections) {
    if (s.ticket) qrByRef.set(s.ticket.ref, await qrBuffer(s.ticket.qrUrl));
  }

  // PROMPT-60: crest pre-pass — like the QR pre-pass, pdfkit draws
  // synchronously, so every table row badge resolves to bytes up front.
  // resolveLogo never throws (null on failure ⇒ row renders without a crest).
  const badgeBuffers = new Map<string, Buffer | null>();
  for (const s of model.sections) {
    for (const url of s.table?.rowBadges ?? []) {
      if (url && !badgeBuffers.has(url)) badgeBuffers.set(url, await resolveLogo(url));
    }
  }

  // PROMPT-62 §4: the bracket poster draws its own body (sections are empty).
  if (model.bracket !== undefined || model.bracketDe !== undefined || model.ladder !== undefined) drawBracket(doc, model);

  // columnsHint 2 (12 Jun "two per A4"): pair sections onto one page by
  // separating with a rule instead of a page break.
  let sinceBreak = 0;
  for (const section of model.sections) {
    const pair = section.columnsHint === 2;
    if (pair && sinceBreak >= 2) {
      doc.addPage();
      sinceBreak = 0;
    }
    if (section.ticket) {
      drawTicket(doc, section.ticket, qrByRef.get(section.ticket.ref) ?? null, model.branding?.orgName);
    } else drawSection(doc, section, badgeBuffers);
    if (pair) {
      sinceBreak += 1;
      if (section.ticket) {
        // cuttable sheet: short crop ticks at the page edges, not a full rule
        drawCropTicks(doc, doc.y + 4);
      } else {
        doc
          .moveTo(MARGIN, doc.y)
          .lineTo(doc.page.width - MARGIN, doc.y)
          .strokeColor("#999999")
          .lineWidth(1)
          .stroke();
      }
      doc.moveDown(0.8);
    }
  }

  // footer: tier-grouped sponsor line + live-page QR slot + page N of M
  const range = doc.bufferedPageRange();
  const qrPng = model.meta.liveUrl ? await qrBuffer(model.meta.liveUrl) : null; // see Task 12 helper
  const total = range.count;
  for (let i = range.start; i < range.start + total; i++) {
    doc.switchToPage(i);
    // Keep the whole footer stack inside the content box — text placed at/below
    // the bottom-margin edge (page.height - MARGIN) is suppressed by pdfkit.
    const fy = doc.page.height - MARGIN - 10;
    const sponsors = model.branding?.sponsors ?? [];
    if (sponsors.length > 0) {
      doc.font(FONT.bodyMed).fontSize(7).fillColor(PALETTE.slate)
        .text(`SPONSORS   ${sponsorLine(sponsors)}`, MARGIN, fy - 12,
          { width: doc.page.width - MARGIN * 2 - 40, characterSpacing: 1, lineBreak: false });
    }
    if (qrPng) {
      try { doc.image(qrPng, doc.page.width - MARGIN - 28, fy - 22, { width: 28 }); } catch { /* skip */ }
    }
    doc.font(FONT.body).fontSize(7).fillColor(PALETTE.mute).text(
      `${model.meta.footerNote ?? model.title} — printed ${model.meta.printedAt} · page ${i - range.start + 1} of ${total}`,
      MARGIN, fy, { width: doc.page.width - MARGIN * 2 - 90, lineBreak: false },
    );
    // platform attribution — every tier, every page (free tier otherwise
    // carries no SEAZN identity at all since the masthead wordmark is Pro-only)
    doc.font(FONT.body).fontSize(7).fillColor(PALETTE.mute).text(
      "Powered by seazn.club",
      MARGIN, fy, { width: doc.page.width - MARGIN * 2, align: "right", lineBreak: false },
    );
  }
  doc.end();
  return done;
}

/** Render a DocModel to XLSX bytes: one sheet, sections as blocks. */
export async function docModelToXlsx(model: DocModel): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(model.kind);
  sheet.addRow([model.title]).font = { bold: true, size: 14 };
  if (model.branding?.orgName) sheet.addRow([model.branding.orgName]).font = { size: 11, color: { argb: "FF52525B" } };
  const sp = model.branding?.sponsors ?? [];
  if (sp.length > 0) sheet.addRow([`Sponsors: ${sp.map((s) => s.name).join(", ")}`]).font = { italic: true, size: 9 };
  sheet.addRow([]);
  for (const section of model.sections) {
    if (section.heading !== undefined) {
      sheet.addRow([section.heading]).font = { bold: true, size: 12 };
    }
    if (section.subheading !== undefined) {
      sheet.addRow([section.subheading]).font = { italic: true };
    }
    if (section.table !== undefined) {
      sheet.addRow(section.table.columns).font = { bold: true };
      for (const row of section.table.rows) sheet.addRow([...row]);
    }
    sheet.addRow([]);
  }
  sheet.addRow([`printed ${model.meta.printedAt}`]).font = { size: 8, color: { argb: "FF888888" } };
  sheet.columns.forEach((col) => {
    col.width = 16;
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
