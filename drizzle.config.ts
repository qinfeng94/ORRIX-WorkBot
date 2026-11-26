import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit 配置：`pnpm db:push` 可手动同步表结构。
 * 注意：应用启动时也会自动建表（ensureSchema），日常无需手动执行。
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
