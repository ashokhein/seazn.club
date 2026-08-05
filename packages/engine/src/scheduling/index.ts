// @seazn/engine/scheduling — fixture generation algorithms (spec 03 §1).

export * from "./roundrobin.ts";
export * from "./swiss.ts";
export * from "./bracket.ts";
export * from "./calendar.ts";
export * from "./constraints.ts";
export * from "./report.ts";
export * from "./americano.ts";
export * from "./feedgraph.ts";
export * from "./bracket-layout.ts";
export * from "./participants.ts";
export * from "./tz.ts";
// The build solver (this plan). Pure metrics first — no z3 anywhere in here.
export * from "./build-objectives.ts";
// The repair solver (#401). All three are free to name here: `z3-load.ts`'s
// only `z3-solver` reference is `import type`, and the WASM stays behind the
// dynamic import inside `loadZ3`, so importing this barrel costs nothing.
export * from "./repair-domain.ts";
export * from "./repair.ts";
export * from "./repair-decompose.ts";
export * from "./repair-minimality.ts";
export * from "./z3-load.ts";
