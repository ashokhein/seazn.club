import "server-only";
// DocModel → bytes (Jul3/06 §2) — the effectful half of the export pipeline.
// The model decides WHAT to print; this file owns layout. PDF via pdfkit,
// XLSX via exceljs.
import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import type { DocModel, DocSection, DocTable } from "@seazn/engine/exports";

const MARGIN = 40;

function isLandscape(model: DocModel): boolean {
  return model.sections.some((s) => s.table?.landscape === true);
}

function drawTable(doc: PDFKit.PDFDocument, table: DocTable): void {
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

  const rowHeight = 16;
  const drawRow = (cells: readonly (string | number)[], bold: boolean) => {
    if (doc.y + rowHeight > doc.page.height - MARGIN) doc.addPage();
    const y = doc.y;
    let x = MARGIN;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8);
    cells.forEach((cell, i) => {
      doc.text(String(cell ?? ""), x + 2, y + 3, {
        width: colW[i]! - 4,
        height: rowHeight,
        ellipsis: true,
        lineBreak: false,
      });
      x += colW[i]!;
    });
    doc
      .moveTo(MARGIN, y + rowHeight)
      .lineTo(MARGIN + width, y + rowHeight)
      .strokeColor("#dddddd")
      .lineWidth(0.5)
      .stroke();
    doc.y = y + rowHeight;
  };
  drawRow(table.columns, true);
  for (const row of table.rows) drawRow(row, false);
  doc.moveDown(0.5);
}

function drawSection(doc: PDFKit.PDFDocument, section: DocSection): void {
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
  if (section.table !== undefined) drawTable(doc, section.table);
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

  doc.font("Helvetica-Bold").fontSize(16).text(model.title, MARGIN);
  doc.moveDown(0.6);

  // columnsHint 2 (12 Jun "two per A4"): pair sections onto one page by
  // separating with a rule instead of a page break.
  let sinceBreak = 0;
  for (const section of model.sections) {
    const pair = section.columnsHint === 2;
    if (pair && sinceBreak >= 2) {
      doc.addPage();
      sinceBreak = 0;
    }
    drawSection(doc, section);
    if (pair) {
      sinceBreak += 1;
      doc
        .moveTo(MARGIN, doc.y)
        .lineTo(doc.page.width - MARGIN, doc.y)
        .strokeColor("#999999")
        .lineWidth(1)
        .stroke();
      doc.moveDown(0.8);
    }
  }

  // footer: printed date on every page (1 Sep ask)
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc
      .font("Helvetica")
      .fontSize(7)
      .fillColor("#888888")
      .text(
        `${model.meta.footerNote ?? model.title} — printed ${model.meta.printedAt}`,
        MARGIN,
        doc.page.height - MARGIN + 10,
        { lineBreak: false },
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
