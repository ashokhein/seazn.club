// Incremental AI translation (v5 i18n §7). en/*.json is the source of truth.
// Only keys whose source hash changed since the last run are re-translated
// (manifest tracks hashes), so re-runs are cheap and self-healing. Translations
// go through claude-opus-4-8 with structured output, a per-run glossary, and
// explicit {placeholder}/brand preservation. Run: `npm run i18n:translate`.
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { changedKeys, hashValue } from "../../apps/web/src/lib/i18n-dict-utils.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DICT = join(here, "../../apps/web/src/dictionaries");
const MANIFEST = join(here, "manifest.json");
const GLOSSARY = join(here, "glossary.json");
const EN = "en";
const MODEL = "claude-opus-4-8";

type StrMap = Record<string, string>;
type Manifest = Record<string, StrMap>; // locale → key → source-hash

// A strict json_schema with one required prop per key is compiled into a grammar
// by the API; too many keys at once overflows it ("compiled grammar is too
// large"). Translate in bounded slices so the grammar stays small — and so a
// mid-run failure only loses the current slice (the manifest persists the rest).
const CHUNK = 30;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Translate a batch of flat key→English-value entries into `locale`. Structured
 *  output guarantees the returned object has exactly the requested keys. */
export async function translateBatch(
  client: Pick<Anthropic, "messages">,
  args: { locale: string; entries: StrMap; glossary: unknown },
): Promise<StrMap> {
  const keys = Object.keys(args.entries);
  if (keys.length === 0) return {};
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])),
    required: keys,
  };
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    output_config: { format: { type: "json_schema", schema }, effort: "low" },
    system:
      `You are a professional UI-string translator. Translate each English value to ${args.locale} (BCP-47). ` +
      `Preserve every {placeholder} token EXACTLY. Keep brand/product names verbatim. Match the source's ` +
      `punctuation and sentence case. Apply this glossary consistently: ${JSON.stringify(args.glossary)}. ` +
      `Return a JSON object mapping each input key to its translated string.`,
    messages: [{ role: "user", content: JSON.stringify(args.entries) }],
  });
  const text = res.content.map((b) => ("text" in b ? b.text : "")).join("");
  return JSON.parse(text) as StrMap;
}

async function main(): Promise<void> {
  const client = new Anthropic();
  const glossary = existsSync(GLOSSARY) ? JSON.parse(readFileSync(GLOSSARY, "utf8")) : {};
  const manifest: Manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : {};

  const namespaces = readdirSync(join(DICT, EN))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(".json", ""));
  const locales = readdirSync(DICT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== EN)
    .map((d) => d.name);

  const REVIEW = new Set(["hi", "ta"]); // flag non-Latin for later native review

  for (const locale of locales) {
    manifest[locale] ??= {};
    for (const ns of namespaces) {
      const enFlat = JSON.parse(readFileSync(join(DICT, EN, `${ns}.json`), "utf8")) as StrMap;
      const changed = changedKeys(enFlat, manifest[locale], hashValue);
      if (changed.length === 0) continue;

      const path = join(DICT, locale, `${ns}.json`);
      const slices = chunk(changed, CHUNK);
      console.log(
        `→ ${locale}/${ns}: translating ${changed.length} key(s) in ${slices.length} slice(s)…`,
      );
      for (const [i, slice] of slices.entries()) {
        if (slices.length > 1) console.log(`   slice ${i + 1}/${slices.length} (${slice.length})`);
        const entries: StrMap = Object.fromEntries(slice.map((k) => [k, enFlat[k]]));
        const translated = await translateBatch(client, { locale, entries, glossary });

        const current = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as StrMap) : {};
        const merged = { ...current, ...translated };
        if (REVIEW.has(locale)) merged["__reviewNeeded"] = "true"; // machine-QA flag
        writeFileSync(path, JSON.stringify(merged, null, 2) + "\n");

        // Persist manifest per slice so a later failure resumes cleanly.
        for (const k of slice) manifest[locale][k] = hashValue(enFlat[k]);
        writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
      }
    }
  }

  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log("i18n:translate done. Run `npm run i18n:check` to confirm parity.");
}

// Run only when invoked directly (not when imported by the test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
