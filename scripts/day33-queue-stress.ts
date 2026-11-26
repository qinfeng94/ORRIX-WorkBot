/**
 * day33-queue-stress.ts — Day 33 500 并发多租户公平队列压测 CLI（与 /queue-lab 看板共用同一引擎）
 *
 * 用法（绑定 package.json）：
 *   pnpm day33:stress
 *
 * 剧本：同一批 500 笔请求（星辰 450 笔 1.5 秒洪峰 + 瑞康 50 笔 10 秒常态）、同一组配对随机
 *      服务耗时，分别灌入「加权轮询公平队列」与「先来先服务 FIFO」两个引擎对照跑；
 *      唯一变量是派发顺序——瑞康 P95 差距即公平队列的净收益。
 * 台账：data/day33/queue_runs.jsonl（只增不改，纯统计无 PII）
 * 红线：纯内存仿真只读统计，无任何打款 / 写业务数据动作；护栏 FAIL 退出码 1。
 */

import { runQueueStress, QUEUE_LEDGER_REL_PATH } from "../src/lib/queue/load-test.ts";
import type { QueueLabReport } from "../src/lib/queue/types.ts";

const SEP = "=".repeat(74);
const log = (s = "") => console.log(s);
const PASS = "\u2705";
const FAIL = "\u274C";

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function printReport(r: QueueLabReport): void {
  log(`  战报编号：${r.runId} · 开跑：${r.startedAt}`);
  log(
    `  剧本：${r.planSummary.totalRequests} 笔（星辰 450 洪峰 + 瑞康 50 常态） · 处理池 ${r.planSummary.poolCapacity} 路 · 单笔 ${r.planSummary.serviceMinMs}~${r.planSummary.serviceMaxMs}ms · seed=${r.planSummary.seed}`,
  );
  log(
    `  调度周期：${r.planSummary.cycleLen} 槽 —— ${r.planSummary.cycle
      .map((c) => `${c.displayName.slice(0, 2)} ${c.slots} 槽 / ${(c.share * 100).toFixed(1)}%`)
      .join(" · ")}`,
  );
  log("");
  for (const mode of [r.fair, r.fifo] as const) {
    const tag = mode.mode === "fair" ? "公平队列（加权轮询 + 保底带宽）" : "FIFO 对照（先来先服务）";
    log(`  【${tag}】总耗时 ${fmtMs(mode.wallMs)} · 吞吐 ${mode.throughputPerSec.toFixed(1)} 笔/秒`);
    for (const t of mode.tenants) {
      log(
        `    ${t.displayName}：${t.done}/${t.total} 完成 · 失败 ${t.failed} · P50 ${fmtMs(t.p50Ms)} · P95 ${fmtMs(t.p95Ms)} · P99 ${fmtMs(t.p99Ms)} · 最长排队 ${fmtMs(t.maxWaitMs)} · 争抢期份额 ${(t.contendedShare * 100).toFixed(1)}%`,
      );
    }
    log("");
  }
  log(
    `  结论：瑞康 P95 公平 ${fmtMs(r.comparison.ruikangP95FairMs)} vs FIFO ${fmtMs(r.comparison.ruikangP95FifoMs)} —— 提升 ${r.comparison.improvementX.toFixed(1)} 倍`,
  );
  log(`  失败率：${r.failureRatePct}%（削峰不拒单，物理无丢弃路径）`);
  log("");
  log("  六项护栏自检：");
  for (const c of r.checks) {
    log(`    ${c.ok ? PASS : FAIL} ${c.name}`);
    log(`       ${c.detail}`);
  }
  log(SEP);
}

async function main(): Promise<void> {
  log(SEP);
  log("  Day 33 · 500 并发多租户公平队列压测（Fair-Share Queue + 令牌桶限流）");
  log(SEP);
  log("  开跑：星辰 450 笔 1.5 秒洪峰 + 瑞康 50 笔 10 秒常态，公平 vs FIFO 对照……");
  log("");

  const report = await runQueueStress();
  printReport(report);

  if (!report.allPass) {
    log("  裁决：\u{1F534} BLOCKED —— 存在护栏未达标，禁止放行（详见上方 FAIL 项）");
    process.exitCode = 1;
    return;
  }
  log(`  裁决：\u{1F7E2} PASS —— 六项护栏全部达标，台账已追加 ${QUEUE_LEDGER_REL_PATH}（只增不改）`);
}

void main().catch((err: unknown) => {
  console.error("压测执行异常：", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
