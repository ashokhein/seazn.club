// Apply supabase/schema.sql using DATABASE_URL from the environment.
// Run with: node --env-file=.env.local --experimental-strip-types scripts/apply-schema.ts
import postgres from "postgres";
import { readFileSync } from "node:fs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (check .env.local).");
  process.exit(1);
}

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const sql = postgres(url, {
  ssl: isLocal ? false : "require",
  prepare: !url.includes(":6543"),
  max: 1,
});

const schema = readFileSync(
  new URL("../supabase/schema.sql", import.meta.url),
  "utf8",
);

try {
  await sql.unsafe(schema).simple();

  const [{ count: users }] =
    await sql`select count(*)::int as count from users`;
  console.log(
    `OK: schema applied. users=${users}. ` +
      `Create the first account from the app's sign-up screen.`,
  );
} catch (err) {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
