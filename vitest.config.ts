import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/entry/**"],
      reporter: ["text", "lcov"],
      // Every line, branch and function is covered today; keep it that way.
      thresholds: { 100: true },
    },
  },
});
