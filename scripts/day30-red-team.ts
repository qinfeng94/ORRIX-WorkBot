/**
 * day30-red-team.ts — Day 30 红队攻防靶场 CLI（收官闭环）
 *
 * 用法（绑定 package.json）：
 *   pnpm eval:security → 20 项经典 Prompt 注入与越权套话攻击全部拦截（20/20 绿灯）才放行
 *
 * 考卷：data/evals/red-team-suite.json（5 大类 × 4 项：直接注入 / 单据夹带 / 越权套话 / 规则与电闸 / 输出红线）
 * 台账：data/evals/red-team-report.json（最新一次演习结论，/security-range 靶场面板读取）
 * 红线：只读评测；电闸演习用内存开关（用后必复位）；无任何打款 / 写业务数据动作。
 */

import { runRedTeamDrill } from "../src/lib/security/red-team.ts";

const SEP = "=".repeat(74);
const log = (s = "") => console.log(s);
const PASS = "\u2705"; // ✅
const FAIL = "\u274C"; // ❌

async function main(): Promise<void> {
  log(SEP);
  log("🛡️  WorkBot Day 30 · 红队攻防靶场（20 项经典注入与越权攻击演习）");
  log(SEP);

  const report = await runRedTeamDrill();

  log(`  考卷版本：red-team-suite-v1 · 耗时：${String(report.durationMs)}ms`);
  log(
    `  总判：${String(report.counts.blocked)}/${String(report.counts.total)} 拦截 · 裁决：` +
      `${report.verdict === "PASS" ? "🟢 PASS 全部拦截，放行" : "🔴 BLOCKED 存在攻击得手，红灯拦截"}`,
  );
  log("");
  for (const cat of report.categories) {
    log(
      `  ${cat.blocked === cat.total ? PASS : FAIL} ${cat.label}：${String(cat.blocked)}/${String(cat.total)} 拦截`,
    );
    for (const r of report.results.filter((x) => x.category === cat.key)) {
      log(`    ${r.passed ? PASS : FAIL} ${r.id} ${r.title}`);
      for (const p of r.probes) {
        log(`        ${p.passed ? "·" : "!"} [${p.probe}] ${p.detail}`);
      }
    }
    log("");
  }
  if (report.blockReasons.length > 0) {
    log("  红灯原因：");
    for (const reason of report.blockReasons) log(`    - ${reason}`);
    log("");
  }
  log(`  台账：data/evals/red-team-report.json（/security-range 靶场面板读取）`);
  log(SEP);

  if (report.verdict !== "PASS") {
    process.exitCode = 1;
    log("🔴 结论：存在攻击得手，禁止放行。按红灯原因修复防线后重考。");
  } else {
    log("🟢 结论：20/20 全部拦截亮绿灯，四道防线（包裹 → 剥离 → 合规路径 → 输出扫描）+ RBAC + 电闸全数生效。");
  }
}

await main();
