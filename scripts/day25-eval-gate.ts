/**
 * day25-eval-gate.ts — Day 25 黄金评测门禁 CLI（收官闭环）
 *
 * 用法（绑定 package.json）：
 *   pnpm eval:fast    → --mode=fast   （前 2 层 12 题，秒级快速门禁）
 *   pnpm eval:ci      → --mode=full   （全量 25 题 4 层，CI 阻塞门禁）
 *   pnpm eval:chaos   → --chaos       （破坏演习闭环：改坏 5 万红线 → 红灯拦截 → AI 读简报修复 → 复考转绿）
 *
 * 考卷：data/evals/golden-suite-v2.json（25 题 4 层；前 3 层 100% 强制阻塞）
 * 红灯产物：data/evals/failure-briefs.json（失败派单简报）+ autosxs-report.json（AutoSxS 胜率报告）
 * 台账：data/evals/gate-report.json（最新一次考卷结论，/eval-loop 看板读取）
 * 红线：只读评测，无任何打款 / 写业务数据动作；chaos 坏阈值仅存内存，演习后必复位。
 */

import {
  AUTOSXS_WINRATE_THRESHOLD,
  loadGoldenSuite,
  runChaosClosedLoop,
  runGoldenSuite,
  type GateReport,
} from "../src/lib/workbot/eval-gate.ts";

const SEP = "=".repeat(74);
const log = (s = "") => console.log(s);

function parseArgs(argv: string[]): { mode: "fast" | "full"; chaos: boolean } {
  let mode: "fast" | "full" = "full";
  let chaos = false;
  for (const arg of argv) {
    const m = /^--mode=(fast|full)$/.exec(arg);
    if (m) mode = m[1] === "fast" ? "fast" : "full";
    if (arg === "--chaos") chaos = true;
  }
  return { mode, chaos };
}

const PASS = "\u2705";
const FAIL = "\u274C";

function layerIcon(passRate: number): string {
  if (passRate === 1) return PASS;
  if (passRate >= 0.8) return "\u26A0\uFE0F";
  return FAIL;
}

function printReport(r: GateReport): void {
  log(`  考卷版本：${r.suiteVersion} · 模式：${r.mode} · 耗时：${String(r.durationMs)}ms`);
  log(`  总分：${String(r.counts.passed)}/${String(r.counts.total)} · 裁决：${r.verdict === "PASS" ? "🟢 PASS 放行" : "🔴 BLOCKED 红灯拦截"}`);
  for (const reason of r.blockReasons) log(`  红灯原因：${reason}`);
  log("");
  for (const l of r.layers) {
    log(
      `  ${layerIcon(l.passRate)} 第 ${String(l.layer)} 层 ${l.layerName}：${String(l.passed)}/${String(l.total)}（${l.blockingRule}）`,
    );
    for (const q of l.results) {
      log(`    ${q.passed ? PASS : FAIL} ${q.id} ${q.title} —— ${q.detail}`);
    }
    log("");
  }
  if (r.autosxs) {
    const a = r.autosxs;
    log(
      `  AutoSxS 胜率：${(a.winRate * 100).toFixed(0)}%（候选赢 ${String(a.candidateWins)}/${String(a.total)}，平 ${String(a.ties)}，负 ${String(a.total - a.candidateWins - a.ties)}；放行线 ${String(Math.round(AUTOSXS_WINRATE_THRESHOLD * 100))}%）→ ${a.verdict}`,
    );
    for (const p of a.pairs) {
      log(`    ${p.verdict === "win" ? PASS : FAIL} ${p.id} ${p.title}：候选${p.candidatePass ? "合格" : "不合格"} vs 基线${p.baselinePass ? "合格" : "不合格"} → ${p.verdict}`);
    }
    log("");
  }
}

async function main(): Promise<void> {
  const { mode, chaos } = parseArgs(process.argv.slice(2));
  log(SEP);
  log(" Day 25 黄金评测门禁（25 题 4 层 · 前 3 层 100% 强制阻塞 · 红灯自动派单）");
  log(SEP);

  const suite = await loadGoldenSuite();
  log(` 考卷：${suite.version} · ${String(suite.questions.length)} 题`);
  for (const l of suite.layers) {
    const count = String(suite.questions.filter((q) => q.layer === l.layer).length);
    log(`  第 ${String(l.layer)} 层 ${l.name}：${count} 题 · ${l.blocking ? (l.mode === "autosxs_winrate" ? `AutoSxS 胜率 ≥ ${String(l.threshold)}` : "100% 强制阻塞") : "参考"}`);
  }
  log("");

  // 破坏演习闭环：改坏红线 → 红灯拦截 → AI 读简报修复 → 复考转绿
  if (chaos) {
    log("— 破坏演习（--chaos）：在内存把 FIN-001 阈值改坏为已废止的 10 万旧制度 —");
    log("");
    const loop = await runChaosClosedLoop();
    for (const s of loop.steps) {
      const icon = s.status === "green" ? PASS : s.status === "red" ? FAIL : "\u2139\uFE0F";
      log(`  ${icon} 第 ${String(s.step)} 步 ${s.title}`);
      log(`      ${s.detail}`);
    }
    log("");
    log(` 演习结论：门禁拦截坏红线 = ${loop.caught ? "成功" : "失败"} · AI 读简报修复 = ${loop.repaired ? "成功" : "失败"}`);
    log(` 修复动作：${loop.repairAction}`);
    log("");
    log("—— 第一次考卷（带破坏注入）——");
    printReport(loop.firstReport);
    log("—— 修复后复考（整卷重考）——");
    printReport(loop.secondReport);
    log(SEP);
    const ok = loop.caught && loop.repaired && loop.secondReport.verdict === "PASS";
    log(ok ? " ✅ 破坏演习闭环通过：门禁能拦住红线回归，修复后整卷转绿" : " ❌ 破坏演习闭环失败：门禁未拦住或修复未转绿，禁止放行");
    log(SEP);
    if (!ok) process.exit(1);
    return;
  }

  // 常规门禁：fast（前 2 层）或 full（全量 25 题）
  const report = await runGoldenSuite({ mode });
  printReport(report);
  log(SEP);
  if (report.verdict === "PASS") {
    log(` ✅ 门禁放行（${mode === "fast" ? "fast 快速档" : "full 全量 25 题"}）——红灯产物不生成，台账见 data/evals/gate-report.json`);
  } else {
    log(` ❌ 红灯拦截：已自动生成 data/evals/failure-briefs.json（失败派单简报）与 autosxs-report.json`);
    log(`    AI 应读简报定位修复（suggestedFix / fixTarget），修复后整卷重考`);
  }
  log(SEP);
  if (report.verdict !== "PASS") process.exit(1);
}

main().catch((err: unknown) => {
  console.error("[eval-gate] 门禁异常终止：", err instanceof Error ? err.message : err);
  process.exit(1);
});
