// Regenerate the committed OpenAPI spec from the Zod route contracts
// (PROMPT-11 §6). CI regenerates and fails on `git diff` — a route/schema
// change without its spec update cannot merge.
//   node --experimental-strip-types scripts/openapi-gen.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "../apps/web/src/server/api-v1/openapi.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, "openapi", "v1.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(buildOpenApiDocument(), null, 2) + "\n");
console.log(`wrote ${out}`);
