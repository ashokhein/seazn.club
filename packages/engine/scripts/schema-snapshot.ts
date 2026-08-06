// Regenerate the committed JSON-Schema snapshots — #429 scope item 2.
//
//   npm run schema:snapshot --workspace packages/engine
//
// Writes sports/<dir>/<key>.schema.json for every builtin module. Unlike the
// golden corpora this is a SAFE, routine regenerate: the snapshot records only
// the declared schemas and the structural state shape, so it can never launder
// a fold change, and it carries no recorded behaviour to lose. The review
// artefact is the diff — added lines are a widening, removed lines are a
// narrowing, and the CI gate exists so a narrowing cannot land unregenerated
// and unread.
//
// It touches NO *.golden.json and needs no UPDATE_GOLDEN / REBASELINE_GOLDEN.
import { statSync } from "node:fs";
import { relative } from "node:path";
import { builtinModules } from "../src/sports/index.ts";
import {
  buildSchemaSnapshot,
  snapshotPath,
  writeSchemaSnapshot,
} from "../src/testkit/schema-snapshot.ts";

let written = 0;
let bytes = 0;

for (const module of builtinModules) {
  const path = snapshotPath(module.key);
  const changed = writeSchemaSnapshot(buildSchemaSnapshot(module));
  const size = statSync(path).size;
  bytes += size;
  if (changed) written++;
  console.log(
    `${module.key.padEnd(12)} ${String(size).padStart(7)} B  ${changed ? "written" : "unchanged"}  ${relative(process.cwd(), path)}`,
  );
}

console.log(
  `\n${builtinModules.length} snapshots, ${bytes} B total, ${written} written, ${builtinModules.length - written} already current.`,
);
