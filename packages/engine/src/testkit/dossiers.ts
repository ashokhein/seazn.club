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
  /** Every table row whose status cell carries a declared status. */
  rows: MappingRow[];
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
 *  without spaces and everyone else writes with them). */
function tableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const cells = trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) =>
      cell
        .trim()
        .replace(/^\*\*(.*)\*\*$/, "$1")
        .trim(),
    );
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
  let hasMappingHeader = false;
  text.split("\n").forEach((line, i) => {
    const cells = tableCells(line);
    if (cells === null) return;
    if (isMappingHeader(cells)) {
      hasMappingHeader = true;
      return;
    }
    if (cells.length <= STATUS_COLUMN) return; // e.g. carrom's variant table
    const status = (cells[STATUS_COLUMN] as string).toLowerCase();
    if (!(DOSSIER_STATUSES as readonly string[]).includes(status)) return;
    rows.push({ fact: cells[0] as string, status: status as DossierStatus, line: i + 1 });
  });

  return { key, path, text, rows, hasMappingHeader };
}
