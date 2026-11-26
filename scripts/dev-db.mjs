/**
 * 本地零配置开发数据库（可选方案 B）
 * 用法：pnpm db:start 后台常驻；连接串固定为
 *   postgresql://workbot:workbot@localhost:5433/workbot
 * 数据落在项目根 .pgdata/（已 gitignore）；接入 Neon/Supabase 云库后本脚本可停用。
 */

import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import path from "node:path";

const dataDir = path.join(process.cwd(), ".pgdata");
const PORT = 5433;

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "workbot",
  password: "workbot",
  port: PORT,
  persistent: true,
});

// 首次运行才初始化数据目录；已初始化则直接启动（数据保留）
if (!existsSync(path.join(dataDir, "PG_VERSION"))) {
  await pg.initialise();
  console.log("[dev-db] 数据目录已初始化：", dataDir);
}

await pg.start();
// 数据库已存在时报错是正常的，吞掉即可
await pg.createDatabase("workbot").catch(() => {});

console.log(`[dev-db] 本地开发数据库已就绪：postgresql://workbot:workbot@localhost:${PORT}/workbot`);
console.log("[dev-db] 按 Ctrl+C 停止（数据保留，下次直接启动）");

const shutdown = async () => {
  try {
    await pg.stop();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
