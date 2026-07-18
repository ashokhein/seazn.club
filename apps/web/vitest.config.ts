import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    pool: "threads",
    // Each DB suite lazily creates a postgres client (cached on globalThis) and
    // ends it in afterAll. With isolate:false that client + globalThis are shared
    // across files, so one file's teardown strands another file's in-flight query
    // (CONNECTION_ENDED). Isolate per file so each owns — and ends — its own
    // connection; the teardown races vanish.
    isolate: true,
    // Playwright specs (e2e/) run under `playwright test`, not vitest. The
    // .next exclude matters: `next build` copies the whole tree (e2e specs
    // included) into .next/standalone, and vitest globbing those copies after
    // a local build segfaulted the run.
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**", "**/.next/**"],
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
