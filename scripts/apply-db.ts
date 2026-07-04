// Apply supabase/schema.sql then every migration (in order) to DATABASE_URL.
// Used by CI to bootstrap an ephemeral Postgres before the smoke test.
// Run with: node --experimental-strip-types scripts/apply-db.ts
import postgres from "postgres";
import { readFileSync, readdirSync } from "node:fs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const sql = postgres(url, {
  ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
  prepare: !url.includes(":6543"),
  max: 1,
});

const dir = new URL("../supabase/", import.meta.url);
const migrations = readdirSync(new URL("migrations/", dir))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => `migrations/${f}`);

// schema.sql (v1) + migrations, then schema_v2.sql (greenfield engine v2 tables,
// created alongside v1 — dropped only at the PROMPT-15 cutover).
const files = ["schema.sql", ...migrations, "schema_v2.sql"];

try {
  for (const f of files) {
    const body = readFileSync(new URL(f, dir), "utf8");
    await sql.unsafe(body).simple();
    console.log(`applied ${f}`);
  }
  const [{ count }] = await sql`select count(*)::int as count from users`;
  console.log(`OK: database ready (users=${count}).`);
} catch (err) {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
