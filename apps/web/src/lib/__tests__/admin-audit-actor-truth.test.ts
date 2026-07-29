// `staff_audit_log` is the schema's only generic actor+target+detail sink, so a
// couple of CUSTOMER self-service effects record themselves there too (#285's
// forfeited wallet, #306's ride_out comp). That is right for the record and
// wrong for /admin, which reads the table as "what staff did" — hence
// CUSTOMER_SELF_SERVICE_AUDIT_ACTIONS and the exclusions on the dashboard.
//
// The risk this file exists for: someone adds a THIRD direct insert with the
// customer as actor, does not know the list exists, and silently re-opens #308.
// Nothing about writing that insert would tell them. So this scans the source
// for direct inserts and fails when one uses an action the list does not carry.
//
// Source-scanning rather than DB-backed on purpose: the defect is a missing
// registration at author time, which no runtime fixture can observe.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { CUSTOMER_SELF_SERVICE_AUDIT_ACTIONS } from "@/lib/admin";

const SRC = path.resolve(__dirname, "../..");
/** `lib/admin.ts` owns the sanctioned staff writer; its insert is the reference
 *  implementation, not a violation. */
const WRITER = path.join(SRC, "lib", "admin.ts");

/** Every .ts/.tsx under src, excluding tests. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "__tests__" || e.name === "node_modules") continue;
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

/**
 * Dotted action literals appearing in a direct `insert into staff_audit_log`.
 *
 * Deliberately NOT trying to match balanced parentheses: the real inserts wrap
 * across lines and nest `sql.json({...})` inside the values list, so a
 * paren-matching regex is fragile in exactly the way that makes a guard read
 * green while matching nothing. It takes a fixed window after the statement
 * and pulls dotted string literals out of it — over-inclusive by design, since
 * a false positive fails loudly and a false negative fails silently.
 */
function directInsertActions(src: string): string[] {
  const found: string[] = [];
  for (const m of src.matchAll(/insert into staff_audit_log/g)) {
    const window = src.slice(m.index!, m.index! + 600);
    for (const lit of window.matchAll(/['"]([a-z_]+(?:\.[a-z_]+)+)['"]/g)) found.push(lit[1]!);
  }
  return found;
}

describe("staff_audit_log actor truth (#308)", () => {
  const files = sourceFiles(SRC).filter((f) => f !== WRITER);

  it("scans a plausible number of source files", () => {
    // Guards the guard: a wrong root would iterate nothing and pass vacuously,
    // which is the exact shape of failure this repo keeps having to unlearn.
    expect(files.length).toBeGreaterThan(200);
  });

  it("every direct insert uses an action registered as customer self-service", () => {
    const unregistered: string[] = [];
    for (const file of files) {
      const actions = directInsertActions(fs.readFileSync(file, "utf8"));
      for (const a of actions) {
        if ((CUSTOMER_SELF_SERVICE_AUDIT_ACTIONS as readonly string[]).includes(a)) continue;
        unregistered.push(`${path.relative(SRC, file)} writes '${a}'`);
      }
    }
    // A staff action must go through logStaffAction; a customer one must be
    // registered so /admin can exclude it. A direct insert of an unregistered
    // dotted action is neither, and is how #308 would come back.
    expect(unregistered).toEqual([]);
  });

  it("finds the two known customer writers, so the scanner is not silently matching nothing", () => {
    const seen = new Set(files.flatMap((f) => directInsertActions(fs.readFileSync(f, "utf8"))));
    for (const a of CUSTOMER_SELF_SERVICE_AUDIT_ACTIONS) expect(seen).toContain(a);
  });

  it("the registered list holds nothing that no longer exists in the source", () => {
    // The mirror of the check above: a stale entry silently permits an action
    // nobody writes any more, and would hide a real one that took its name.
    const seen = new Set(files.flatMap((f) => directInsertActions(fs.readFileSync(f, "utf8"))));
    expect([...CUSTOMER_SELF_SERVICE_AUDIT_ACTIONS].filter((a) => !seen.has(a))).toEqual([]);
  });
});
