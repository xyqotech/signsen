import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Checks TEST_DATABASE_URL before the first test and drops leftover test databases after the last.
    globalSetup: ["./vitest.global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
