#!/usr/bin/env node
/**
 * fleet-runner.mjs — Day 22 并发代理军团调度器 CLI 演示（零第三方依赖，纯 Node 内置模块）
 *
 * 能力：
 * - 10 路并发跑完 50 笔异常单据初审（固定容量工作池，队列拉取式分发）；
 * - 瞬时故障指数退避自动重试（300ms → 600ms → 1200ms，默认最多 3 次）；
 * - 终端进度条实时刷新（stderr，含完成数 / FIN-001 拦截 / 重试 / 失败 / 耗时）；
 * - 统计总耗时、平均单笔延迟、总花费、FIN-001 红线拦截数，导出 data/day22/fleet-report.json。
 *
 * 红线（承接 AGENTS.md）：
 * - 初审代理全程只读 + 起草，注册表物理不存在打款工具；
 * - FIN-001：财务部单笔「超过」¥50,000 强制拦截转人工（等于 50,000 不触发）；
 *   疑似拆单按合并口径处理并上报；
 * - 客户姓名全部脱敏（王* / 李*），报告不含任何明文 PII。
 *
 * 用法：
 *   node scripts/day22-lab/fleet-runner.mjs                    # 标准演示：50 单 × 10 路
 *   node scripts/day22-lab/fleet-runner.mjs --concurrency 20   # 调整并发上限
 *   node scripts/day22-lab/fleet-runner.mjs --total 30 --seed 7
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFleet } from '../../lib/day22/fleet-scheduler.mjs';

/* ---------------- 参数解析 ---------------- */

const argv = process.argv.slice(2);
function readNumFlag(name, fallback) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const TOTAL = readNumFlag('--total', 50);
const CONCURRENCY = readNumFlag('--concurrency', 10);
const SEED = readNumFlag('--seed', 20221122);

const REPORT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/day22');
const REPORT_PATH = path.join(REPORT_DIR, 'fleet-report.json');

/* ---------------- 终端进度条（stderr，不污染 stdout 报告输出） ---------------- */

const BAR_WIDTH = 26;
let retryCount = 0;
let failCount = 0;
let interceptCount = 0;
let doneCount = 0;
let startedWall = Date.now();

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  amber: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

function renderBar(done, total) {
  const pct = total === 0 ? 0 : done / total;
  const filled = Math.round(pct * BAR_WIDTH);
  const bar = `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`;
  const elapsed = ((Date.now() - startedWall) / 1000).toFixed(1);
  process.stderr.write(
    `\r  ${c.cyan}${bar}${c.reset} ${String(done).padStart(2)}/${total}` +
      `  ${c.amber}FIN-001 拦截 ${interceptCount}${c.reset}` +
      `  ${c.dim}重试 ${retryCount}${c.reset}` +
      (failCount > 0 ? `  ${c.red}失败 ${failCount}${c.reset}` : '') +
      `  ${c.dim}${elapsed}s${c.reset}   `,
  );
}

/* ---------------- 红线自检横幅 ---------------- */

console.log('');
console.log(`${c.bold}星辰 WorkBot · Day 22 并发代理军团调度器${c.reset}`);
console.log(`${c.dim}红线口径：初审全程只读 + 起草｜FIN-001 财务部单笔超过 ¥50,000 强制转人工｜疑似拆单按合并口径上报${c.reset}`);
console.log(`${c.dim}本次编队：${TOTAL} 笔异常单据 × ${CONCURRENCY} 路并发上限 × 退避重试 ≤ 3 次（seed=${SEED}，离线高仿真）${c.reset}`);
console.log('');

/* ---------------- 跑批 ---------------- */

const report = await runFleet({
  total: TOTAL,
  concurrency: CONCURRENCY,
  seed: SEED,
  runBy: 'cli',
  onEvent(event) {
    switch (event.type) {
      case 'fleet_start':
        startedWall = Date.now();
        break;
      case 'ticket_retry':
        retryCount += 1;
        break;
      case 'ticket_done':
        if (event.status === 'fin001_intercepted') interceptCount += 1;
        if (event.status === 'failed') failCount += 1;
        doneCount += 1;
        renderBar(doneCount, TOTAL);
        break;
      case 'ticket_start':
      case 'fleet_done':
      default:
        break;
    }
  },
});

process.stderr.write('\n\n');

/* ---------------- 报告导出（数据落盘，JSON 只写报告文件，不改任何历史记录） ---------------- */

await mkdir(REPORT_DIR, { recursive: true });
await writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');

/* ---------------- 汇总输出 ---------------- */

const s = report.stats;
console.log(`${c.bold}─── 军团战报 ───────────────────────────────${c.reset}`);
console.log(`  编队规模     ${s.succeeded + s.fin001Intercepted + s.failed} 笔（成功 ${c.green}${s.succeeded}${c.reset} · FIN-001 拦截 ${c.amber}${s.fin001Intercepted}${c.reset} · 失败 ${s.failed}）`);
console.log(`  总耗时       ${(s.totalElapsedMs / 1000).toFixed(2)}s（吞吐 ${s.throughputPerMinute} 笔/分钟）`);
console.log(`  平均单笔延迟 ${s.avgPerTicketMs}ms（P95 ${s.p95PerTicketMs}ms / 峰值 ${s.maxPerTicketMs}ms）`);
console.log(`  总花费       $${s.totalCostUsd.toFixed(4)}（离线高仿真计费，复用 Day 6 单价口径）`);
console.log(`  自动重试     ${s.totalRetries} 次（指数退避 300/600/1200ms）`);
console.log(`  红线拦截     ${c.bold}${c.amber}${s.fin001Intercepted}${c.reset} 笔全部转具名审批人，AI 未触碰任何放行动作`);
console.log('');
console.log(`${c.dim}报告已导出：${REPORT_PATH}${c.reset}`);
console.log('');

// 失败样本如实列出（宁缺毋滥，绝不硬凑初审结论）
for (const t of report.tickets.filter((x) => x.status === 'failed')) {
  console.log(`${c.red}  [失败] ${t.ticketId} ${t.issue} → ${t.note}${c.reset}`);
}
