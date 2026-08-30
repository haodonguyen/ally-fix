import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the `@/*` path mapping in apps/web/tsconfig.json, so route
      // handlers can be imported under test exactly as Next imports them.
      "@": fileURLToPath(new URL("./apps/web", import.meta.url)),
    },
  },
  test: {
    // Co-located unit tests across the monorepo. node_modules is ignored by default.
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html", "lcov"],
      reportsDirectory: "./coverage",

      // Measured explicitly rather than "everything minus exclusions", so a new
      // directory has to be opted in and cannot silently dilute the numbers.
      include: [
        "packages/*/src/**/*.ts",
        "apps/worker/src/**/*.ts",
        // Opted in once the eval grew real logic: scoring, arm statistics, and
        // config validation are as load-bearing as anything in src/.
        "apps/worker/eval/**/*.ts",
        "apps/web/lib/**/*.ts",
        "apps/web/app/api/**/*.ts",
      ],

      exclude: [
        "**/*.test.ts",
        // Test scaffolding, not shipped behaviour.
        "**/testing/**",
        // Barrel files: re-exports with no behaviour to cover.
        "packages/*/src/index.ts",
        // Table and column declarations, not logic.
        "packages/db/src/schema.ts",
        // Process wiring only. Importing it opens Redis connections, a Postgres
        // pool, and a BullMQ worker; the logic it used to hold now lives in
        // process-audit.ts, which is tested.
        "apps/worker/src/index.ts",
        // Needs a real Chromium to exercise. Its security-critical half is
        // `assertUrlIsSafe`, which is covered in packages/shared.
        "apps/worker/src/scanner.ts",
        // The golden set is data, not logic; `eval:validate` is what checks it.
        "apps/worker/eval/cases.ts",
        // Script wiring: these import env and open a browser at module load.
        "apps/worker/eval/index.ts",
        "apps/worker/eval/compare.ts",
        "apps/worker/eval/compare-models.ts",
        "apps/worker/eval/validate.ts",
        // Drives a real Chromium; the harness that uses it is tested with fakes.
        "apps/worker/eval/verify.ts",
      ],

      // Ratchet, not aspiration: set at the level the suite actually reaches, so
      // a drop fails CI. Raise them when coverage rises; never lower them to make
      // a red build green.
      thresholds: {
        statements: 90,
        branches: 88,
        functions: 88,
        lines: 90,
      },
    },
  },
});
