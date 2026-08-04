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

/** Wrapper nodes that stand between a key and the schema that describes it.
 *  Peeling them is how `z.number().optional().readonly()` still reads as a
 *  number, and how `.optional()` is found however it was stacked. */
const WRAPPERS = new Set(["optional", "nullable", "default", "prefault", "readonly", "nonoptional", "catch"]);

/** Wrappers that make the key OMISSIBLE from the written payload. `nullable` is
 *  deliberately absent: a nullable key must still be written, so every recorded
 *  payload already pins it and it needs no corpus coverage. A `default` IS
 *  omissible — the recorded payload is the scorer's INPUT, not the parse
 *  result — which is also why this wave's hard invariant is `.optional()` with
 *  no default: a default lands in the cfg serialised into every frozen state. */
const OMISSIBLE = new Set(["optional", "default", "prefault"]);

/** Peel wrappers until a structural node (object / union / array / leaf). */
function unwrap(schema: unknown): unknown {
  let node = schema;
  for (let hop = 0; hop < 32; hop++) {
    const def = defOf(node);
    if (!def) return node;
    if (WRAPPERS.has(def.type)) {
      node = def.innerType;
      continue;
    }
    if (def.type === "lazy") {
      node = def.getter();
      continue;
    }
    if (def.type === "pipe") {
      node = def.out ?? def.in;
      continue;
    }
    return node;
  }
  return node;
}

/** Whether a shape entry may be left out of a written payload. */
function isOmissible(schema: unknown): boolean {
  let node = schema;
  for (let hop = 0; hop < 32; hop++) {
    const def = defOf(node);
    if (!def) return false;
    if (OMISSIBLE.has(def.type)) return true;
    if (WRAPPERS.has(def.type)) {
      node = def.innerType;
      continue;
    }
    if (def.type === "lazy") {
      node = def.getter();
      continue;
    }
    if (def.type === "pipe") {
      node = def.out ?? def.in;
      continue;
    }
    return false;
  }
  return false;
}

function walk(schema: unknown, prefix: string, out: Set<string>, depth: number): void {
  if (depth > 12) return; // no engine payload nests anywhere near this deep
  const def = defOf(unwrap(schema));
  if (!def) return;
  switch (def.type) {
    case "object": {
      for (const [key, field] of Object.entries<unknown>(def.shape ?? {})) {
        const path = prefix === "" ? key : `${prefix}.${key}`;
        if (isOmissible(field)) out.add(path);
        walk(field, path, out, depth + 1);
      }
      return;
    }
    // A union contributes every branch's fields at the SAME path prefix — the
    // branches carry no discriminator (the envelope's `type` is the engine's,
    // read by `apply`), so there is no per-branch path to key them under.
    case "union":
      for (const option of def.options ?? []) walk(option, prefix, out, depth + 1);
      return;
    case "intersection":
      walk(def.left, prefix, out, depth + 1);
      walk(def.right, prefix, out, depth + 1);
      return;
    case "array":
      walk(def.element, `${prefix}[]`, out, depth + 1);
      return;
    case "tuple":
      for (const item of def.items ?? []) walk(item, `${prefix}[]`, out, depth + 1);
      return;
    case "record":
      walk(def.valueType, `${prefix}[]`, out, depth + 1);
      return;
    default:
      return; // a leaf: string / number / boolean / enum / literal
  }
}

/** Every OMISSIBLE field the schema declares, as a sorted list of dotted paths.
 *  An `[]` suffix on a segment means "descend into the elements of this array".
 *  A required leaf inside an optional object is NOT listed: it is required
 *  whenever the parent is written, so covering the parent pins its shape. */
export function optionalFieldPaths(schema: AnySchema): string[] {
  const out = new Set<string>();
  walk(schema, "", out, 0);
  return [...out].sort();
}

function segmentsOf(path: string): string[] {
  return path.split(".").flatMap((seg) => (seg.endsWith("[]") ? [seg.slice(0, -2), "[]"] : [seg]));
}

function presentAt(value: unknown, segments: readonly string[]): boolean {
  if (segments.length === 0) return value !== undefined;
  const [head, ...rest] = segments as [string, ...string[]];
  // `[]` means "descend into the members". `walk` emits it for arrays, tuples
  // AND records — and a record is WRITTEN as an object, so testing only
  // `Array.isArray` made every record path unreachable by construction. That is
  // not a hypothetical: `suspensions.classes` is a `z.record` on the period
  // kernel, so `suspensions.classes[].pim` reported uncovered for ice hockey
  // and hockey while the frozen cfg pinned all three of its leaves.
  if (head === "[]") {
    if (Array.isArray(value)) return value.some((item) => presentAt(item, rest));
    if (typeof value !== "object" || value === null) return false;
    return Object.values(value as Record<string, unknown>).some((item) => presentAt(item, rest));
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (!Object.hasOwn(value, head)) return false;
  return presentAt((value as Record<string, unknown>)[head], rest);
}

/** Whether `payload` actually WRITES `path`. `false` and `0` count — they are
 *  recorded facts, not absences — but an explicit `undefined` does not, because
 *  a JSON round-trip through the corpus would drop the key. */
export function fieldPresent(payload: unknown, path: string): boolean {
  return presentAt(payload, segmentsOf(path));
}

// ------------------------------------------------------------ value walking
//
// T2 (#425 follow-up) — the STATE half of the additive tripwire.
//
// `SportModule<Cfg, Ev, State>` declares `configSchema` and `eventSchema` but
// NO `stateSchema`: every state shape is a plain TS interface, built by `init`
// and `apply` and never validated at runtime. So `optionalFieldPaths` has
// nothing to walk for state, and the declared-vs-written comparison the payload
// half runs cannot be reproduced from a schema. What the corpus DOES have is
// the state itself — `GoldenStream.states` is `JSON.stringify` of the fold
// after every event — so the paths come from the recorded VALUES instead.
//
// The grammar is deliberately the same as `optionalFieldPaths`: dotted keys,
// `[]` for "descend into the members". A caller that walks both can compare
// them without a translation step.

export interface ValueWalkOptions {
  /** Object keys rendered as `[]` instead of as themselves. A recorded state
   *  cannot say which of its objects are RECORDS (person id → runs) and which
   *  are structs (`{home, away}`), and keying a record by its ids turns lineup
   *  data into schema paths: cricket's `innings[].fine.batterRuns` alone
   *  contributed 22 person-keyed paths that say nothing about any field. */
  collapse?: ReadonlySet<string>;
  /** Keys dropped at the ROOT of the walk. The state walk drops `cfg`, which
   *  the config half of the tripwire owns and which would otherwise double-count
   *  every declared knob as a state path. */
  omit?: ReadonlySet<string>;
}

function walkValue(
  value: unknown,
  prefix: string,
  out: Set<string>,
  collapse: ReadonlySet<string>,
  depth: number,
): void {
  if (depth > 12) return; // no engine state nests anywhere near this deep
  if (Array.isArray(value)) {
    for (const item of value) walkValue(item, `${prefix}[]`, out, collapse, depth + 1);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (member === undefined) continue; // a JSON round-trip drops the key
    const path = collapse.has(key) ? `${prefix}[]` : prefix === "" ? key : `${prefix}.${key}`;
    out.add(path);
    walkValue(member, path, out, collapse, depth + 1);
  }
}

/** Every dotted path a VALUE writes, sorted. A leaf counts however falsy it is
 *  — `null`, `0` and `false` are recorded facts about the shape — and an empty
 *  array contributes only its own key, because no element wrote anything. */
export function valueFieldPaths(value: unknown, options: ValueWalkOptions = {}): string[] {
  const collapse = options.collapse ?? new Set<string>();
  const out = new Set<string>();
  const omit = options.omit;
  const root =
    omit === undefined || typeof value !== "object" || value === null || Array.isArray(value)
      ? value
      : Object.fromEntries(
          Object.entries(value as Record<string, unknown>).filter(([key]) => !omit.has(key)),
        );
  walkValue(root, "", out, collapse, 0);
  return [...out].sort();
}
