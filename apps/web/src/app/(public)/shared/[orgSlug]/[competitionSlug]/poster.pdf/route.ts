// Printable A4 QR poster as a PDF (v3/10 #3): comp name, org logo, dates,
// a big QR to the public dashboard, "follow live" line. pdfkit directly
// (Jul3/06's DocModel is table-shaped and has no image vocabulary — the
// poster is one designed page, so it owns its layout the way doc-render
// owns tables). `?division=<slug>` scopes the QR to one division.
import QRCode from "qrcode";
import PDFDocument from "pdfkit";
import { notFound } from "next/navigation";
import { getPublicCompetition } from "@/server/public-site/data";

export const revalidate = 300;

const VIOLET = "#7c3aed";
const INK = "#18181b";
const MUTED = "#52525b";

type Ctx = { params: Promise<{ orgSlug: string; competitionSlug: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { orgSlug, competitionSlug } = await params;
  const data = await getPublicCompetition(orgSlug, competitionSlug);
  if (!data) notFound();
  const { org, competition, divisions } = data;

  const divisionSlug = new URL(req.url).searchParams.get("division");
  const division = divisionSlug
    ? (divisions.find((d) => d.slug === divisionSlug) ?? null)
    : null;

  const path = division
    ? `/shared/${org.slug}/${competition.slug}/${division.slug}`
    : `/shared/${org.slug}/${competition.slug}`;
  const url = `https://seazn.club${path}`;
  const qr = await QRCode.toBuffer(url, { width: 900, margin: 1 });

  const fmt = (d: string) =>
    new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const dates = [
    competition.starts_on ? fmt(competition.starts_on) : null,
    competition.ends_on ? fmt(competition.ends_on) : null,
  ]
    .filter(Boolean)
    .join(" – ");

  const doc = new PDFDocument({ size: "A4", margin: 0 });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  const W = doc.page.width; // 595pt
  const H = doc.page.height; // 842pt

  // Accent keel top + bottom — the courtside signature in print.
  doc.rect(0, 0, W, 16).fill(VIOLET);
  doc.rect(0, H - 16, W, 16).fill(VIOLET);

  doc
    .font("Helvetica-Bold").fontSize(15).fillColor(MUTED)
    .text(org.name.toUpperCase(), 0, 64, { align: "center", characterSpacing: 3 });

  doc
    .font("Helvetica-Bold").fontSize(38).fillColor(INK)
    .text(competition.name.toUpperCase(), 48, 92, { align: "center", width: W - 96 });

  let y = doc.y + 6;
  if (division) {
    doc
      .font("Helvetica-Bold").fontSize(20).fillColor(VIOLET)
      .text(division.name, 48, y, { align: "center", width: W - 96 });
    y = doc.y + 4;
  }
  if (dates) {
    doc
      .font("Helvetica").fontSize(15).fillColor(MUTED)
      .text(dates, 48, y, { align: "center", width: W - 96 });
    y = doc.y;
  }

  // Big QR, centered, framed.
  const qrSize = 320;
  const qrX = (W - qrSize) / 2;
  const qrY = Math.max(y + 28, 250);
  doc
    .roundedRect(qrX - 14, qrY - 14, qrSize + 28, qrSize + 28, 18)
    .lineWidth(2).strokeColor("#e4e4e7").stroke();
  doc.image(qr, qrX, qrY, { width: qrSize, height: qrSize });

  doc
    .font("Helvetica-Bold").fontSize(24).fillColor(INK)
    .text("Scan to follow live", 48, qrY + qrSize + 42, { align: "center", width: W - 96 });
  doc
    .font("Helvetica").fontSize(15).fillColor(MUTED)
    .text("Live scores · fixtures · standings — no app needed", 48, doc.y + 6, {
      align: "center",
      width: W - 96,
    });
  doc
    .font("Helvetica-Bold").fontSize(13).fillColor(VIOLET)
    .text(url.replace("https://", ""), 48, doc.y + 18, { align: "center", width: W - 96 });

  doc
    .font("Helvetica").fontSize(9).fillColor("#a1a1aa")
    .text("seazn.club", 48, H - 48, { align: "center", width: W - 96 });

  doc.end();
  const pdf = await done;

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${competition.slug}-poster.pdf"`,
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
    },
  });
}
