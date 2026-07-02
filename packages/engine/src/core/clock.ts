// Injected time — spec 03 §1/§6. The ONLY module allowed to touch wall-clock
// time; `Date.now()` / `new Date()` anywhere else in packages/engine/src fails
// the boundary gate (scripts/engine-boundary.ts). Engine code never calls a
// clock during a fold — `recordedAt` arrives on the envelope; the adapter
// stamps it using one of these.
export interface Clock {
  now(): string; // ISO-8601 timestamp
}

// Deterministic clock for tests and replays: always returns the same instant.
export function fixedClock(iso: string): Clock {
  return { now: () => iso };
}

// Deterministic clock that advances a fixed step per call — for simulations
// that need distinct, ordered timestamps without wall time.
export function tickingClock(startIso: string, stepMs = 1000): Clock {
  let tick = 0;
  const start = new Date(startIso).getTime();
  return { now: () => new Date(start + stepMs * tick++).toISOString() };
}

// Wall clock — for the persistence adapter only, never inside a fold.
export const systemClock: Clock = { now: () => new Date().toISOString() };
