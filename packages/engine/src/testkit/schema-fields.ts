// Optional-field introspection for the golden tripwire — W4a (#425) T10.
//
// PURE by construction: no node:fs, no disk, no module registry. `golden.ts`
// reads files and is therefore kept out of testkit/index.ts's barrel; this file
// is its schema half, split out so the walker can be tested against synthetic
// schemas rather than only through eleven frozen corpora.
//
// WHY IT EXISTS. `uncoveredTierTypes` reasons about event TYPES, and one
// recorded event of a type satisfies it. That is enough to red a new REQUIRED
// field (the recorded payload stops parsing) and nothing else: a rename, a
// reshape or a narrowing of an OPTIONAL field reds only if some recorded
// payload actually carries it. After the W4a `at` wave that gap was total —
// 0 of 274 football events and 0 of 148 icehockey events carried `at`, so
// renaming it, reshaping `GameTime` or narrowing `DurationSeconds` would have
// reddened nothing, in eleven corpora whose entire purpose is to notice.
import type { z } from "zod";

/** A zod schema whose generics are the caller's business — we only introspect. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySchema = z.ZodType<any, any>;

/** Zod v4 keeps the node's definition on `_zod.def`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function defOf(schema: unknown): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (schema as any)?._zod?.def;
}

export function optionalFieldPaths(_schema: AnySchema): string[] {
  return [];
}

export function fieldPresent(_payload: unknown, _path: string): boolean {
  return false;
}

// Referenced so the stub type-checks; the walker lands next.
void defOf;
