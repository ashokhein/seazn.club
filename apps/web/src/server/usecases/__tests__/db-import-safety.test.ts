// Import-safety lock (v17 gap W4, PR #323 CI regression).
//
// `sql` (lib/db.ts) is a Proxy whose apply AND get traps both call
// getClient(), which THROWS when DATABASE_URL is unset. So any module-scope
// `sql\`…\`` — e.g. `const COSTED = sql\`…\`` — opens a database client at
// IMPORT time rather than query time.
//
// That is not a style point. CI's unit job deliberately runs with no
// DATABASE_URL so DB-backed suites self-skip via
// `describe.skipIf(!process.env.DATABASE_URL)`. One eager fragment in
// ai-runs-admin.ts therefore took ~30 suites down at COLLECTION — schedule-ai
// and officials-ai import that module, and much of the usecase graph imports
// those. It is invisible locally, because vitest.config.ts loads .env.local
// and DATABASE_URL is always present.
//
// It is also invisible in a naive test count: a collection failure reports as
// `fail 0` with `success: false`, so a "0 failures" glance reads green.
//
// This test pins the CAUSE rather than the symptom, so it runs in every job
// (including ones that DO have a database): importing these modules must not
// touch the sql proxy at all. Verified to fail when the fix is reverted.
import { beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ touched: [] as string[] }));

vi.mock("@/lib/db", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/db")>();
  const record = (how: string) => {
    probe.touched.push(how);
  };
  const sqlProxy = new Proxy(actual.sql, {
    apply(target, thisArg, args: unknown[]) {
      record("called as a tagged template");
      return Reflect.apply(target as never, thisArg, args);
    },
    get(target, prop, receiver) {
      record(`property read: ${String(prop)}`);
      return Reflect.get(target as never, prop, receiver);
    },
  });
  return { ...actual, sql: sqlProxy };
});

/** Every server module this wave touched that sits on the AI/credits import
 *  graph. A new module-scope `sql` anywhere in here fails this test. */
const WAVE_MODULES = [
  "@/server/usecases/ai-runs-admin",
  "@/server/usecases/schedule-ai",
  "@/server/usecases/officials-ai",
  "@/server/usecases/competitions",
  "@/lib/credits",
  "@/lib/email",
  "@/lib/ai-pricing",
];

beforeEach(() => {
  probe.touched = [];
});

describe("module-scope db safety (PR #323)", () => {
  it.each(WAVE_MODULES)("importing %s opens no database client", async (specifier) => {
    // Fresh evaluation, so we observe THIS import rather than a cached one.
    vi.resetModules();
    await import(specifier);
    expect(
      probe.touched,
      `${specifier} touched the sql proxy at import time (${probe.touched.join(", ")}). ` +
        `Module-scope sql\`…\` opens a client on import and breaks every suite in ` +
        `CI's no-DATABASE_URL unit job at collection. Make it a function: ` +
        `const X = () => sql\`…\`, called inside the query.`,
    ).toEqual([]);
  });
});
