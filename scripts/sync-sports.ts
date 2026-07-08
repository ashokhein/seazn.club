// Sync the DB sport catalog from the engine registry (PROMPT-10 task 2).
// The `sports` + system `sport_variants` rows are GENERATED from module
// metadata, never hand-edited: this script upserts one `sports` row per shipped
// SportModule and one system `sport_variants` row per named preset the module
// declares. Run after db:apply, as the superuser (bypasses RLS to write the
// global catalog + org_id=null system presets):
//   node --experimental-strip-types scripts/sync-sports.ts
import postgres from "postgres";
import { builtinModules } from "@seazn/engine/sports";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const sql = postgres(url, {
  connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
  ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
  prepare: !url.includes(":6543"),
  max: 1,
});

// Human display names for the sport keys (engine modules carry only keys).
// Anything not listed falls back to a title-cased key.
const SPORT_NAMES: Record<string, string> = {
  football: "Football",
  cricket: "Cricket",
  volleyball: "Volleyball",
  badminton: "Badminton",
  tabletennis: "Table Tennis",
  boardgame: "Board game",
  generic: "Generic",
};

function titleCase(key: string): string {
  return key
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

try {
  let sportCount = 0;
  let variantCount = 0;

  for (const module of builtinModules) {
    const name = SPORT_NAMES[module.key] ?? titleCase(module.key);
    await sql`
      insert into sports (key, name, module_version, position_catalog)
      values (${module.key}, ${name}, ${module.version}, ${sql.json(module.positions)})
      on conflict (key) do update set
        name = excluded.name,
        module_version = excluded.module_version,
        position_catalog = excluded.position_catalog
    `;
    sportCount++;

    for (const [variantKey, config] of Object.entries(module.variants)) {
      await sql`
        insert into sport_variants (sport_key, key, name, config, is_system, org_id)
        values (${module.key}, ${variantKey}, ${titleCase(variantKey)},
                ${sql.json(config ?? {})}, true, null)
        on conflict on constraint sport_variants_pkey do update set
          name = excluded.name,
          config = excluded.config,
          is_system = true
      `;
      variantCount++;
    }
  }

  console.log(
    `sync-sports: upserted ${sportCount} sports, ${variantCount} system variants.`,
  );
} catch (err) {
  console.error("sync-sports FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
