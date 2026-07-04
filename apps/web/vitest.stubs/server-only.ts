// Empty stub for the `server-only` marker package. Next resolves `server-only`
// via a build-time condition; under vitest (plain node) it isn't installed, so
// we alias it to this no-op so server modules can be unit-tested.
export {};
