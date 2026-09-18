import { defineConfig } from "drizzle-kit";

/** Generator only; ordered hand-written migrations own applied DDL. */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/storage/decision-fact-schema.ts",
  out: "./drizzle",
  casing: "snake_case",
});
