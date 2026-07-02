import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Scaffold phase (PROMPT-01): suites land with PROMPT-02+.
    passWithNoTests: true,
  },
});
