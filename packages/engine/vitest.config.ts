import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    pool: "threads",
    isolate: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/index.ts"],
      // PROMPT-14 §4 gate: ≥90% lines across the engine; the fold kernel and
      // the tiebreaker cascade must be fully covered.
      thresholds: {
        lines: 90,
        "src/core/**/*.ts": { lines: 100 },
        "src/competition/tiebreakers.ts": { lines: 100 },
      },
    },
  },
});
