import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      include: [
        "src/lib/pairing.ts",
        "src/lib/standings.ts",
        "src/lib/engine.ts",
      ],
      thresholds: { lines: 95, functions: 95, branches: 90 },
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
