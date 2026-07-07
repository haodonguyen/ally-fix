import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Co-located unit tests across the monorepo. node_modules is ignored by default.
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    environment: "node",
  },
});
