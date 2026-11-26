#!/usr/bin/env node
/**
 * Day 35 · 回滚演习跨平台启动器（pnpm day35:rollback）
 * 解决 Windows 坑：cmd 下 `bash` 会被解析成未装发行版的 WSL 存根（C:\Windows\System32\bash.exe），
 * 本启动器优先找 Git Bash，找不到再退回 PATH 上的 bash（macOS/Linux 天然命中）。
 * 真正的逻辑在 scripts/rollback-90s.sh，这里只负责把它交给正确的 bash 执行（参数原样透传）。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, "rollback-90s.sh");

const gitBashCandidates = [
  process.env.WORKBOT_GIT_BASH, // 允许环境变量指定
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  `${process.env.LOCALAPPDATA ?? ""}\\Programs\\Git\\bin\\bash.exe`,
].filter(Boolean);

const bashExe =
  gitBashCandidates.find((p) => existsSync(p)) ?? "bash"; // macOS/Linux / 已装 WSL 的机器

const result = spawnSync(bashExe, [scriptPath, ...process.argv.slice(2)], {
  stdio: "inherit",
});

if (result.error) {
  console.error(`启动 bash 失败（尝试过 ${bashExe}）：${result.error.message}`);
  console.error("请安装 Git for Windows（自带 Git Bash）或设置 WORKBOT_GIT_BASH 指向 bash.exe");
  process.exit(1);
}

process.exit(result.status ?? 1);
