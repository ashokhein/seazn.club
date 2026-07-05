import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    pool: "threads",
    isolate: false,
    // @seazn/engine ships TS source (workspace symlink) — inline it so vitest
    // transforms it instead of treating it as an opaque external dep.
    server: { deps: { inline: [/@seazn\/engine/] } },
    coverage: {
      provider: "v8",
      // The v1 engine (pairing/standings/engine) was deleted at the PROMPT-15
      // cutover; engine math coverage lives in packages/engine. What remains
      // here is the pure migration mapping.
      include: ["src/server/migration/v1-map.ts"],
      thresholds: { lines: 95, functions: 95, branches: 90 },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // `server-only` is a Next build-time marker, absent under vitest.
      "server-only": path.resolve(__dirname, "vitest.stubs/server-only.ts"),
    },
  },
});
