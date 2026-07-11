// Regenerate the committed OpenAPI specs from the Zod route contracts
// (PROMPT-11 §6, v3/08 §3). CI regenerates and fails on `git diff` — a
// route/schema change without its spec update cannot merge.
//   node --experimental-strip-types scripts/openapi-gen.ts
//
// Two documents:
//   openapi/v1.json        — full internal spec (route coverage gate)
//   openapi/v1.public.json — published developer spec: the key-scoped
//                            surface + public tag only (served on /developers)
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "../apps/web/src/server/api-v1/openapi.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
mkdirSync(join(root, "openapi"), { recursive: true });

const full = join(root, "openapi", "v1.json");
writeFileSync(full, JSON.stringify(buildOpenApiDocument(), null, 2) + "\n");
console.log(`wrote ${full}`);

const published = join(root, "openapi", "v1.public.json");
writeFileSync(
  published,
  JSON.stringify(buildOpenApiDocument({ published: true }), null, 2) + "\n",
);
console.log(`wrote ${published}`);
