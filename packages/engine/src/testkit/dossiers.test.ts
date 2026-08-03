// W4 shared-engine item 6 (#407) — "audited" must be a checkable property.
//
// W4 audited all eleven sport modules against their real scorebooks and wrote
// each result up as a domain dossier. That claim lived in commit messages and
// nowhere else: nothing in the build could tell an audited module from an
// unaudited one, so the twelfth sport would ship with no dossier and no one
// would notice. This suite makes the dossier part of the contract.
//
// Purity: dossiers.ts touches node:fs and is deliberately NOT exported from
// testkit/index.ts — @seazn/engine ships zero runtime dependencies and the
// barrel is a published entrypoint. golden.ts set that precedent; this follows
// it, and the last test here holds the line.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { builtinModules } from "../sports/index.ts";
import {
  DOSSIER_STATUSES,
  MAPPING_COLUMNS,
  dossierPath,
  readDossier,
  type Dossier,
} from "./dossiers.ts";

/** A dossier this thin is a placeholder, not an audit. */
const MIN_CHARS = 2000;
const MIN_ROWS = 1;

describe("every builtin sport module ships a domain dossier", () => {
  it("covers all eleven builtins", () => {
    expect(builtinModules.length).toBe(11);
  });

  it("names the sport key when a dossier is missing", () => {
    // The failure message is the product here: a bare ENOENT on an absolute
    // path does not tell the next author which sport they forgot.
    expect(() => readDossier("kabaddi")).toThrowError(/kabaddi/);
  });

  for (const module of builtinModules) {
    describe(module.key, () => {
      let dossier: Dossier;

      it(`has a dossier on disk (${module.key})`, () => {
        expect(() => {
          dossier = readDossier(module.key);
        }, `sport module "${module.key}" has no domain dossier`).not.toThrow();
      });

      it(`is non-trivial (${module.key})`, () => {
        dossier ??= readDossier(module.key);
        expect(
          dossier.text.length,
          `dossier for "${module.key}" is a stub (${dossier.path})`,
        ).toBeGreaterThan(MIN_CHARS);
        expect(dossier.text, `dossier for "${module.key}" has no heading`).toMatch(/^#\s+\S/m);
      });

      it(`carries a mapping table (${module.key})`, () => {
        dossier ??= readDossier(module.key);
        expect(
          dossier.hasMappingHeader,
          `dossier for "${module.key}" has no mapping table header ` +
            `(expected columns: ${MAPPING_COLUMNS.join(" | ")}) — ${dossier.path}`,
        ).toBe(true);
      });

      it(`maps at least one fact with a declared status (${module.key})`, () => {
        dossier ??= readDossier(module.key);
        expect(
          dossier.rows.length,
          `dossier for "${module.key}" maps no facts (${dossier.path})`,
        ).toBeGreaterThanOrEqual(MIN_ROWS);
        // Asserting `rows` all carry a declared status would assert the parser
        // against its own filter — readDossier only collects rows that already
        // passed it. The check that can actually fail is the rejects list: a
        // typo'd or invented status in a mapping row.
        expect(
          dossier.badStatusRows.map((r) => `${dossier.path}:${r.line} "${r.status}"`),
          `dossier for "${module.key}" has mapping rows with an undeclared status ` +
            `(expected one of ${DOSSIER_STATUSES.join(" / ")})`,
        ).toEqual([]);
      });

      // A hand-maintained tally under the mapping table is a claim about the
      // table, and football's had already drifted from it (it said 10 extended
      // / 19 deferred while the rows said 11 / 18). Seven dossiers declared no
      // tally at all. Either the number is checked or it is a lie the next wave
      // reads as fact — so every dossier declares one and this asserts it.
      it(`declares a row tally that matches its own table (${module.key})`, () => {
        dossier ??= readDossier(module.key);
        const tally = { modelled: 0, extended: 0, deferred: 0 };
        for (const row of dossier.rows) tally[row.status] += 1;
        const actual = { ...tally, total: dossier.rows.length };
        expect(
          dossier.declaredCounts,
          `dossier for "${module.key}" declares no row tally (${dossier.path}) — ` +
            `expected a line reading "**Row counts:** ${actual.modelled} modelled, ` +
            `${actual.extended} extended, ${actual.deferred} deferred (${actual.total} rows)."`,
        ).not.toBeNull();
        const declared = dossier.declaredCounts as NonNullable<Dossier["declaredCounts"]>;
        expect(
          { ...declared, line: undefined },
          `dossier for "${module.key}" row tally is stale ` +
            `(${dossier.path}:${declared.line})`,
        ).toEqual({ ...actual, line: undefined });
      });
    });
  }

  // GFM lets a cell hold a literal pipe as `\|`, and football's dossier does
  // it inside a code span (`State.periods[].home\|away`). Splitting naively
  // gave that row an extra cell and shifted its status out of column five,
  // which silently dropped every football row once row scoping was added.
  it("reads cells across an escaped pipe inside a mapping row", () => {
    const football = readDossier("football");
    expect(football.text, "fixture assumption: football still escapes a pipe").toContain("\\|");
    expect(football.rows.length).toBeGreaterThan(20);
    expect(football.badStatusRows).toEqual([]);
  });

  it("finds a substantial mapping table in every dossier, not just one row", () => {
    // MIN_ROWS is the contract; this pins that the parser is not limping.
    for (const module of builtinModules) {
      const dossier = readDossier(module.key);
      expect(dossier.rows.length, `${module.key} mapping rows`).toBeGreaterThan(10);
    }
  });

  it("puts each dossier next to its module, by the golden path convention", () => {
    const paths = builtinModules.map((m) => dossierPath(m.key));
    expect(new Set(paths).size, "two modules share one dossier file").toBe(paths.length);
    // The setbased trio share a directory, so the KEY has to be in the file
    // name; every other module owns its directory and uses a bare DOMAIN.md.
    expect(dossierPath("badminton").endsWith("setbased/DOMAIN.badminton.md")).toBe(true);
    expect(dossierPath("football").endsWith("football/DOMAIN.md")).toBe(true);
  });

  // Structural, not cosmetic: node:fs must never reach @seazn/engine/testkit.
  it("keeps node:fs out of the published testkit barrel", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const barrel = readFileSync(join(here, "index.ts"), "utf8");
    expect(barrel).not.toMatch(/dossiers/);
    expect(barrel).not.toMatch(/golden/);
  });
});
