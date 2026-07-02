// Injected time — spec 03 §1/§6. The ONLY module allowed to touch wall-clock
// time; `Date.now()` / `new Date()` anywhere else in packages/engine/src fails
// the boundary gate (scripts/engine-boundary.ts). Implemented in PROMPT-02.

export {};
