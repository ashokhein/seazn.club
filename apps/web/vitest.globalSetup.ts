// Runs ONCE per vitest invocation (not per file — `isolate: true` would make a
// setupFiles banner fire 363 times).
//
// Why this exists: the DB-backed suites are `describe.skipIf(!HAS_DB)`. Without
// DATABASE_URL they skip, vitest reports them as SKIPPED rather than failed, and
// the run exits 0. A full run then looks like this —
//
//     Test Files  259 passed | 104 skipped (363)
//          Tests  1738 passed | 775 skipped (2513)
//
// — which reads as a pass at a glance and is how a billing change was twice
// reported "green" here having executed none of its own tests. The failure count
// is not the number to trust; the skipped count is.
//
// Deliberately NOT auto-loading .env.local: its DATABASE_URL is the local DEV
// database, and these suites create and mutate rows. Pointing them there on
// import would be worse than skipping. Opt in explicitly, to a throwaway schema.
export default function setup(): void {
  if (process.env.DATABASE_URL) return;
  const files = 22; // src/lib/__tests__ (18) + src/app (4); the rest live in src/server
  console.warn(
    [
      "",
      "  \x1b[33m▲ DATABASE_URL is not set — every DB-backed suite will SKIP.\x1b[0m",
      "",
      `    That is ~${files} files outside src/server plus most of src/server itself.`,
      "    This run WILL exit 0 with them skipped. Read the skipped count, not the",
      "    failure count, before calling it green.",
      "",
      "    To run them, against a throwaway schema (never .env.local, never seazn_club):",
      "",
      "      DATABASE_URL=postgresql://postgres@127.0.0.1:54329/seazn_smoke \\",
      "      DATABASE_SSL=disable DB_SCHEMA=<your_schema> npx vitest run",
      "",
      "    A fresh schema also needs `npm run db:apply` then `npm run sync:sports`",
      "    under the same env, or the sports-catalog suites fail environmentally.",
      "",
    ].join("\n"),
  );
}
