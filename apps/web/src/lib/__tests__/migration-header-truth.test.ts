// A migration that misnames itself in its own header is the most expensive kind
// of wrong comment: it is the AUTHORITATIVE file, so every reader who opens it
// to check a fact copies the wrong version number out of it.
//
// That is not hypothetical. #312 corrected 33 citations across 23 files that all
// said V310 for facts V314 states — and the source was V314's own header
// (`-- V310 — billing moves off the org...`). One wrong header produced 33 wrong
// citations, which is the whole argument for this guard costing a test.
//
// Scope, deliberately narrow: this checks ONLY the self-naming header — the
// first non-empty line, in the `-- V### — description` shape this repo uses to
// title a migration. A migration that legitimately REFERENCES another one in
// prose ("V283 deliberately withheld DELETE on sponsor_orders...") is not
// naming itself and must not be flagged; requiring the dash separator is what
// tells the two apart. 64 of 101 migrations have no self-naming header at all,
// which is fine — the rule is "if you name yourself, be right", not "name
// yourself".
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const DELTAS = path.resolve(__dirname, "../../../../../db/migration/deltas");

/** `-- V314 — billing moves off the org` → "314". Null for anything else,
 *  including a prose line that merely starts with a version reference. */
const selfNamed = (line: string): string | null =>
  /^--\s*V(\d+)\s*[—–-]\s/.exec(line.trim())?.[1] ?? null;

/** The version a migration file's NAME declares. */
const fileVersion = (name: string): string => /^V(\d+)__/.exec(name)![1]!;

/**
 * Migrations whose header is known-wrong and which cannot be corrected in place.
 *
 * Flyway checksums applied migrations, so editing the body — even one comment
 * character — fails `flyway migrate` validation on every environment where the
 * migration has already run. Correcting these costs a coordinated `flyway
 * repair`, tracked in #366 to ride along with the next migration that already
 * requires coordination.
 *
 * All three are one incident: V314/V315/V316 were renumbered after being
 * written and their headers never followed, which is exactly the off-by-four
 * run you would expect from a rebase.
 *
 * This list may only ever SHRINK. The test below fails if an entry stops being
 * wrong, so a fixed header cannot leave a stale exemption behind to hide the
 * next one.
 */
const KNOWN_WRONG_HEADERS: Readonly<Record<string, string>> = {
  "V314__billing_groups.sql": "310",
  "V315__billing_group_transfers.sql": "311",
  "V316__competition_fee_lock.sql": "312",
};

const migrations = fs
  .readdirSync(DELTAS)
  .filter((f) => /^V\d+__.*\.sql$/.test(f))
  .sort();

describe("migration headers name their own file", () => {
  it("finds the migration directory and a plausible number of files", () => {
    // Guards the guard: a wrong path would make every assertion below vacuous
    // by iterating an empty list, which is the failure mode this whole file
    // exists to argue against.
    expect(migrations.length).toBeGreaterThan(50);
  });

  it("every self-naming header states its own version (#366)", () => {
    const wrong: string[] = [];
    for (const file of migrations) {
      const first = fs
        .readFileSync(path.join(DELTAS, file), "utf8")
        .split("\n")
        .find((l) => l.trim() !== "");
      const claimed = first ? selfNamed(first) : null;
      if (claimed === null) continue; // no self-naming header — not this rule's business
      if (claimed === fileVersion(file)) continue;
      if (KNOWN_WRONG_HEADERS[file] === claimed) continue; // tracked in #366
      wrong.push(`${file} names itself V${claimed}`);
    }
    expect(wrong).toEqual([]);
  });

  it("the #366 exemption list holds nothing that has since been fixed", () => {
    // A stale exemption is worse than none: it silently permits the exact
    // defect it was written to tolerate temporarily. When #366 lands, this is
    // the test that tells you to delete the entry rather than leaving it to rot.
    const stale: string[] = [];
    for (const [file, claimed] of Object.entries(KNOWN_WRONG_HEADERS)) {
      const full = path.join(DELTAS, file);
      if (!fs.existsSync(full)) {
        stale.push(`${file} no longer exists — drop it from KNOWN_WRONG_HEADERS`);
        continue;
      }
      const first = fs
        .readFileSync(full, "utf8")
        .split("\n")
        .find((l) => l.trim() !== "");
      const actual = first ? selfNamed(first) : null;
      if (actual !== claimed) {
        stale.push(`${file} no longer claims V${claimed} — drop it from KNOWN_WRONG_HEADERS`);
      }
    }
    expect(stale).toEqual([]);
  });

  it("does not flag a header that merely REFERENCES another migration", () => {
    // The distinguishing case, pinned so a future tightening of the regex
    // cannot quietly start failing legitimate prose. V300 opens with
    // "-- V283 deliberately withheld DELETE on sponsor_orders from app_user"
    // — a sentence about V283, not a claim to be V283.
    expect(selfNamed("-- V283 deliberately withheld DELETE on sponsor_orders")).toBeNull();
    expect(selfNamed("-- V314 — billing moves off the org")).toBe("314");
    expect(selfNamed("-- V314 - billing moves off the org")).toBe("314");
    expect(selfNamed("-- Adds a column. See V283 for why.")).toBeNull();
  });
});
