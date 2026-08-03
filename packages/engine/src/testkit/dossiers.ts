// Domain-dossier reader — W4 item 6 (#407).
//
// WHY THIS EXISTS. W4 audited all eleven sport modules against their real
// scorebooks and wrote each result up as a dossier. "Audited" was then a claim
// in a commit message and nothing else: nothing in the build could tell an
// audited module from an unaudited one, so the twelfth sport would ship with no
// dossier and nobody would notice. This makes it a checkable property.
//
// Purity note: this file lives in testkit and may touch node:fs. It is
// deliberately NOT re-exported from testkit/index.ts, exactly as golden.ts is
// not — the barrel is a published entrypoint and @seazn/engine ships with zero
// runtime dependencies. Nothing under src/sport/** or src/sports/** may import
// it; dossiers.test.ts is its only consumer.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SPORT_DIRS } from "./golden.ts";

/** The status vocabulary a mapping row may declare. `modelled` = the engine
 *  already held the fact; `extended` = W4 added it; `deferred` = deliberately
 *  out of scope, with the reason in the note column. */
export const DOSSIER_STATUSES = ["modelled", "extended", "deferred"] as const;
export type DossierStatus = (typeof DOSSIER_STATUSES)[number];

/** The mapping table's columns, in order. Every dossier repeats this header —
 *  cricket repeats it once per sub-table, which is why parsing is per-row. */
export const MAPPING_COLUMNS = [
  "fact",
  "variants",
  "who/what participates",
  "schema path",
  "status",
  "note",
] as const;

const STATUS_COLUMN = MAPPING_COLUMNS.indexOf("status");

export interface MappingRow {
  fact: string;
  status: DossierStatus;
  line: number; // 1-based, so a failure message can point into the file
}

export interface Dossier {
  key: string;
  path: string;
  text: string;
  /** Every mapping-table row carrying a declared status. */
  rows: MappingRow[];
  /** Mapping rows whose status cell is NOT one of DOSSIER_STATUSES — a typo'd
   *  or invented status. Silently dropping these would let a broken table pass
   *  on the strength of one surviving good row. */
  badStatusRows: { fact: string; status: string; line: number }[];
  /** Did the file repeat the canonical mapping-table header at least once? */
  hasMappingHeader: boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where a module's dossier lives. A directory that hosts ONE sport carries a
 *  bare `DOMAIN.md`; the setbased trio share a directory, so the file name
 *  carries the key (`DOMAIN.badminton.md`). Same rule golden.ts uses for
 *  corpora, driven off the same SPORT_DIRS map so the two cannot drift. */
export function dossierPath(key: string): string {
  const dir = SPORT_DIRS[key];
  if (dir === undefined) {
    throw new Error(`no sport directory registered for sport module "${key}"`);
  }
  return join(HERE, "..", "sports", dir, dir === key ? "DOMAIN.md" : `DOMAIN.${key}.md`);
}

/** Cells of a markdown table row, `**bold**` stripped and trimmed. Returns null
 *  for a non-table line and for the `| --- |` separator (which cricket writes
 *  without spaces and everyone else writes with them).
 *
 *  Splits on UNESCAPED pipes only: GFM lets a cell contain a literal `|` as
 *  `\|`, and football's dossier does exactly that inside a code span
 *  (`State.periods[].home\|away`). Splitting naively gave that row seven cells
 *  and shifted its status out of column five. */
function tableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const parts = trimmed.split(/(?<!\\)\|/);
  parts.shift(); // text before the leading pipe (always empty)
  if (parts.length > 0 && (parts[parts.length - 1] as string).trim() === "") parts.pop();
  const cells = parts.map((cell) =>
    cell
      .replace(/\\\|/g, "|")
      .trim()
      .replace(/^\*\*(.*)\*\*$/, "$1")
      .trim(),
  );
  if (cells.length === 0) return null;
  if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) return null;
  return cells;
}

function isMappingHeader(cells: string[]): boolean {
  return (
    cells.length === MAPPING_COLUMNS.length &&
    cells.every((cell, i) => cell.toLowerCase() === MAPPING_COLUMNS[i])
  );
}

/** Reads and parses one module's dossier. Throws with the sport KEY in the
 *  message when the file is missing — naming the gap is the whole point; a bare
 *  ENOENT on an absolute path does not tell the next author what they forgot. */
export function readDossier(key: string): Dossier {
  const path = dossierPath(key);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`sport module "${key}" has no domain dossier at ${path}`);
  }

  const rows: MappingRow[] = [];
  const badStatusRows: { fact: string; status: string; line: number }[] = [];
  let hasMappingHeader = false;
  // Rows only count once a mapping header has been seen, and only when they
  // have the mapping table's exact column count — otherwise an unrelated table
  // elsewhere in the file (carrom's variant table) could stand in for a
  // mapping table that is missing or malformed.
  let inMapping = false;
  text.split("\n").forEach((line, i) => {
    const cells = tableCells(line);
    if (cells === null) return; // blank/prose lines end nothing: separators only
    if (isMappingHeader(cells)) {
      hasMappingHeader = true;
      inMapping = true;
      return;
    }
    if (cells.length !== MAPPING_COLUMNS.length) {
      inMapping = false; // a different table started
      return;
    }
    if (!inMapping) return;
    const fact = cells[0] as string;
    const status = (cells[STATUS_COLUMN] as string).toLowerCase();
    if (!(DOSSIER_STATUSES as readonly string[]).includes(status)) {
      badStatusRows.push({ fact, status, line: i + 1 });
      return;
    }
    rows.push({ fact, status: status as DossierStatus, line: i + 1 });
  });

  return { key, path, text, rows, badStatusRows, hasMappingHeader };
}
