import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    silent: "passed-only",
    name: "bb-plugin-gitea",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**"],
  },
});
