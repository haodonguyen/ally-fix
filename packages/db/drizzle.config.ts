import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config: generates SQL migrations from src/schema.ts.
 * Run `pnpm db:generate` to create migrations, `pnpm db:migrate` to apply them.
 */
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // process.env is Node's global, typed via @types/node.
    url: process.env.DATABASE_URL ?? "",
  },
});
