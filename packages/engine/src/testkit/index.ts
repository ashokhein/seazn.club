// @seazn/engine/testkit — conformance suite factories for module authors —
// spec 03 §2 (kernel guarantees), §6 (determinism & simulation), spec 04 §9
// (cross-sport invariants) — plus the tournament simulation harness
// (PROMPT-14): full-division property simulation across every stage-graph
// template, with seeded exact replay (sim:replay).

export * from "./helpers.ts";
export * from "./conformance.ts";
export * from "./simulation.ts";
// W4 (#407) — stoppage-bearing stream generation. Pure: no node:fs, so unlike
// the two disk-reading testkit modules it belongs in the published barrel.
export * from "./stoppages.ts";
