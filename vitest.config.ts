import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    include: ["tests/**/*.test.ts", "app/**/*.test.ts", "server/**/*.test.ts", "shared/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/helpers/clean-git-env.ts"],
    // Assertions read the German texts; the English ones are covered by their own tests.
    env: { FLEET_LANG: "de" },
    // Integration tests start the real server and the real hook as child processes.
    testTimeout: 20_000,
  },
});
