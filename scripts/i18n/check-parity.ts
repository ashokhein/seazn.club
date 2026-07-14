// CI gate: every non-en locale must have exactly the same key set as en.
// Missing keys would silently fall back to English; extra keys are dead weight
// (usually a renamed/removed en key left behind). Exits 1 on any diff.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { flattenKeys, diffKeys } from "../../apps/web/src/lib/i18n-dict-utils.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DICT_DIR = join(here, "../../apps/web/src/dictionaries");
const EN = "en";

function keysFor(locale: string): string[] {
  const dir = join(DICT_DIR, locale);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => flattenKeys(JSON.parse(readFileSync(join(dir, f), "utf8"))));
}

const enKeys = keysFor(EN);
const locales = readdirSync(DICT_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== EN)
  .map((d) => d.name);

let failed = false;
for (const locale of locales) {
  const { missing, extra } = diffKeys(enKeys, keysFor(locale));
  if (missing.length || extra.length) {
    failed = true;
    console.error(`✗ ${locale}: ${missing.length} missing, ${extra.length} extra`);
    if (missing.length) console.error(`    missing: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? " …" : ""}`);
    if (extra.length) console.error(`    extra:   ${extra.slice(0, 10).join(", ")}${extra.length > 10 ? " …" : ""}`);
  } else {
    console.log(`✓ ${locale}: parity with en (${enKeys.length} keys)`);
  }
}

if (failed) {
  console.error("\ni18n parity check failed — run `npm run i18n:translate` to fill locales.");
  process.exit(1);
}
console.log("\ni18n parity OK.");
