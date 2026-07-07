import "server-only";
// Upload → header-mapped ImportRow[] (Jul3/01 §3): the effectful half of the
// import pipeline's front end. CSV is parsed natively; XLSX via exceljs. The
// header auto-detector produces a column mapping the client can override and
// the org can remember (Jul3/01 §8).
import ExcelJS from "exceljs";
import { ImportRow } from "@seazn/engine/import";
import { HttpError } from "@/lib/errors";

export type ImportField = Exclude<keyof ImportRow, "rowNo">;

// normalized header → field. Normalization strips everything but [a-z0-9].
const HEADER_ALIASES: Record<string, ImportField> = {
  club: "clubName",
  clubname: "clubName",
  parentclub: "clubName",
  clubshort: "clubShortName",
  clubshortname: "clubShortName",
  clubabbr: "clubShortName",
  clubref: "clubExternalRef",
  clubexternalref: "clubExternalRef",
  affiliation: "clubExternalRef",
  fanumber: "clubExternalRef",
  team: "teamName",
  teamname: "teamName",
  teamshort: "teamShortName",
  teamshortname: "teamShortName",
  player: "playerFullName",
  playername: "playerFullName",
  playerfullname: "playerFullName",
  fullname: "playerFullName",
  name: "playerFullName",
  dob: "dob",
  dateofbirth: "dob",
  birthdate: "dob",
  born: "dob",
  gender: "gender",
  sex: "gender",
  number: "squadNumber",
  no: "squadNumber",
  squadnumber: "squadNumber",
  shirtnumber: "squadNumber",
  jersey: "squadNumber",
  position: "position",
  pos: "position",
  captain: "isCaptain",
  iscaptain: "isCaptain",
  capt: "isCaptain",
  division: "divisionSlug",
  divisionslug: "divisionSlug",
  displayname: "entrantDisplayName",
  entrantname: "entrantDisplayName",
  entrantdisplayname: "entrantDisplayName",
};

export function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Auto-detect a column mapping from a header row (client may override). */
export function detectMapping(header: string[]): Record<string, ImportField> {
  const mapping: Record<string, ImportField> = {};
  const taken = new Set<ImportField>();
  for (const raw of header) {
    const field = HEADER_ALIASES[normalizeHeader(raw)];
    if (field && !taken.has(field)) {
      mapping[raw] = field;
      taken.add(field);
    }
  }
  return mapping;
}

// --- cell coercion ----------------------------------------------------------

function parseDob(raw: string): string | undefined {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s); // ISO (or ISO datetime)
  if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(s); // dd/mm/yyyy | dd.mm.yyyy
  if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  return undefined;
}

function parseGender(raw: string): "m" | "f" | "x" | undefined {
  switch (raw.trim().toLowerCase()) {
    case "m": case "male": case "boy": return "m";
    case "f": case "female": case "girl": case "w": return "f";
    case "x": case "other": case "nb": case "nonbinary": return "x";
    default: return undefined;
  }
}

function parseBool(raw: string): boolean {
  return ["y", "yes", "true", "1", "x", "c"].includes(raw.trim().toLowerCase());
}

/** Map a raw table (header row + data rows) into ImportRow[]. rowNo is the
 *  1-based SOURCE line (header = 1) so issues anchor to the spreadsheet. */
export function toImportRows(
  table: string[][],
  mapping?: Record<string, ImportField>,
): { rows: ImportRow[]; mapping: Record<string, ImportField> } {
  const [header, ...data] = table;
  if (!header) throw new HttpError(422, "The file has no header row");
  const map = mapping ?? detectMapping(header);
  const fieldByCol: (ImportField | null)[] = header.map((h) => map[h] ?? null);
  if (!fieldByCol.some((f) => f !== null)) {
    throw new HttpError(422, "No recognisable columns — map the headers manually");
  }

  const rows: ImportRow[] = [];
  data.forEach((cells, i) => {
    const rowNo = i + 2; // header is line 1
    const row: Record<string, unknown> = { rowNo };
    cells.forEach((cell, col) => {
      const field = fieldByCol[col];
      const value = cell?.trim();
      if (!field || !value) return;
      switch (field) {
        case "squadNumber": {
          const n = Number.parseInt(value, 10);
          if (Number.isInteger(n)) row[field] = n;
          break;
        }
        case "isCaptain":
          row[field] = parseBool(value);
          break;
        case "gender": {
          const g = parseGender(value);
          if (g) row[field] = g;
          break;
        }
        case "dob": {
          const d = parseDob(value);
          if (d) row[field] = d;
          break;
        }
        default:
          row[field] = value;
      }
    });
    if (Object.keys(row).length > 1) rows.push(ImportRow.parse(row));
  });
  return { rows, mapping: map };
}

/** Parse CSV text into a raw table (RFC-4180 quoting, CRLF tolerant). */
export function parseCsv(text: string): string[][] {
  const table: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c !== "")) table.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== "")) table.push(row);
  return table;
}

/** Parse the first worksheet of an XLSX file into a raw table. Values are
 *  rendered as display text (dates → ISO date). */
export async function parseXlsx(buffer: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new HttpError(422, "The workbook has no sheets");
  const table: string[][] = [];
  sheet.eachRow((row) => {
    const cells: string[] = [];
    // row.values is 1-based; hole cells come back undefined
    const values = row.values as unknown[];
    for (let c = 1; c < values.length; c++) {
      const v = values[c];
      if (v === null || v === undefined) cells.push("");
      else if (v instanceof Date) cells.push(v.toISOString().slice(0, 10));
      else if (typeof v === "object" && "text" in (v as object)) {
        cells.push(String((v as { text: unknown }).text));
      } else cells.push(String(v));
    }
    if (cells.some((cell) => cell.trim() !== "")) table.push(cells);
  });
  return table;
}

/** Parse an upload by content type / filename into a raw table. */
export async function parseUpload(
  filename: string,
  contentType: string | null,
  buffer: Buffer,
): Promise<string[][]> {
  const isXlsx =
    filename.toLowerCase().endsWith(".xlsx") ||
    contentType?.includes("spreadsheetml") === true;
  if (isXlsx) return parseXlsx(buffer);
  return parseCsv(buffer.toString("utf8"));
}
