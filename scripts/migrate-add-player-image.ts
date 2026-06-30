// Non-destructive migration: add players.image_url if it doesn't exist.
// Run with:
//   node --env-file=.env.local --experimental-strip-types scripts/migrate-add-player-image.ts
import postgres from "postgres";

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

try {
  await sql`alter table players add column if not exists image_url text`;
  const [{ count }] =
    await sql`select count(*)::int as count from players`;
  console.log(`OK: players.image_url ensured. players=${count}`);
} catch (err) {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
