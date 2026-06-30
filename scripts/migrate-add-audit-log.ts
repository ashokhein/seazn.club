// Non-destructive migration: create the audit_log table if it doesn't exist.
// Run with:
//   node --env-file=.env.local --experimental-strip-types scripts/migrate-add-audit-log.ts
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
  await sql`
    create table if not exists audit_log (
      id              uuid primary key default gen_random_uuid(),
      tournament_id   uuid references tournaments(id) on delete cascade,
      actor           text,
      action          text not null,
      summary         text not null,
      detail          jsonb,
      created_at      timestamptz not null default now()
    )`;
  await sql`
    create index if not exists audit_log_tournament_idx
      on audit_log(tournament_id, created_at desc)`;
  const [{ count }] = await sql`select count(*)::int as count from audit_log`;
  console.log(`OK: audit_log ensured. rows=${count}`);
} catch (err) {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
