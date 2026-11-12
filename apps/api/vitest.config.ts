import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Test against the engine source so a rebuild is not needed between changes.
      "@sitemate/engine": fileURLToPath(new URL("../../packages/engine/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    testTimeout: 20_000,
    // Every test file starts its own embedded Postgres; a few at a time keeps memory use predictable.
    pool: "forks",
    maxWorkers: 3,
  },
});
