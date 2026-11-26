#!/usr/bin/env node
/**
 * 01-dual-stream-ledger.mjs — Day 6 双厂商流式 + 故障切换演习台（零第三方依赖）
 *
 * 用法（默认离线高仿真，无需任何 Key）：
 *   node scripts/day6-lab/01-dual-stream-ledger.mjs
 *   node scripts/day6-lab/01-dual-stream-ledger.mjs --simulate-outage
 *   node scripts/day6-lab/01-dual-stream-ledger.mjs --primary openai
 *   node scripts/day6-lab/01-dual-stream-ledger.mjs --live --simulate-outage
 *   node scripts/day6-lab/01-dual-stream-ledger.mjs --effort high --prompt "自定义提问"
 *
 * 参数说明：
 *   --primary claude|openai   一键切换主模型（备用自动取另一家）
 *   --effort low|medium|high  Adaptive Thinking / reasoning.effort 档位
 *   --simulate-outage         故障演习：主厂商必抛 429，验证自动秒切备用
 *   --live                    读取 .env.local 中 ANTHROPIC_API_KEY / OPENAI_API_KEY 走真实 API
 *   --prompt "..."            自定义提问（默认为应收账款核对演示问题）
 *
 * 安全约定（承接 AGENTS.md）：
 *   - .env.local 只在本进程内存解析，密钥绝不打印、绝不写日志；
 *   - 每次调用追加一条 JSONL 用量日志（data/day6/llm_usage_logs.jsonl），只增不改；
 *   - 不含任何打款/写业务数据逻辑。
 */

import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const LOG_PATH = path.join(ROOT, 'data', 'day6', 'llm_usage_logs.jsonl');

// 复用核心模块（与 Next.js 共用同一份实现）
const { MODEL_REGISTRY, streamChat, appendUsageLog } = await import(
  pathToFileURL(path.join(ROOT, 'lib', 'llm', 'llm-client.mjs')).href
);

/* ---------------- 参数解析 ---------------- */

const argv = process.argv.slice(2);

function hasFlag(name) {
  return argv.includes(`--${name}`);
}

function flagValue(name) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  return idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('--') ? argv[idx + 1] : undefined;
}

/** @type {'claude' | 'openai'} */
const primaryArg = /** @type {'claude' | 'openai'} */ (flagValue('primary') || 'claude');
/** @type {'low' | 'medium' | 'high'} */
const effortArg = /** @type {'low' | 'medium' | 'high'} */ (flagValue('effort') || 'medium');
const live = hasFlag('live');
const simulateOutage = hasFlag('simulate-outage');
const prompt = flagValue('prompt') ||
  '请基于 11 月应收账款只读快照，汇总发票总数、疑似错账数量与涉及金额，并对超过 FIN-001 红线的单据给出处理建议。';

/* ---------------- .env.local 解析（仅 live 模式，密钥不落日志不打印） ---------------- */

/**
 * @param {string} envPath
 * @returns {Promise<Record<string, string>>}
 */
async function loadEnvLocal(envPath) {
  let raw = '';
  try {
    raw = await readFile(envPath, 'utf8');
  } catch {
    return {};
  }
  /** @type {Record<string, string>} */
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    env[key] = value;
  }
  return env;
}

/* ---------------- 主流程 ---------------- */

const messages = [{ role: 'user', content: prompt }];

console.log('═'.repeat(64));
console.log('  Day 6 · 双厂商流式对话 + 故障切换演习台');
console.log('═'.repeat(64));
console.log(`主模型   : ${MODEL_REGISTRY[primaryArg].label}`);
console.log(`effort   : ${effortArg}`);
console.log(`模式     : ${live ? 'LIVE（真实 API，密钥来自 .env.local）' : '离线高仿真（无 Key 可跑）'}`);
console.log(`故障演习 : ${simulateOutage ? '开启（主厂商将抛 429，验证秒切备用）' : '关闭'}`);
console.log(`用量日志 : ${path.relative(ROOT, LOG_PATH)}（JSONL，只增不改）`);
console.log('─'.repeat(64));
console.log(`\n用户提问：${prompt}\n`);
console.log('─'.repeat(64));
console.log('AI 回复（逐字流式）：\n');

let apiKeys = {};
if (live) {
  const env = await loadEnvLocal(path.join(ROOT, '.env.local'));
  apiKeys = {
    claude: env.ANTHROPIC_API_KEY,
    openai: env.OPENAI_API_KEY,
  };
}

process.stdout.write('▍');
const result = await streamChat({
  primary: primaryArg,
  messages,
  effort: effortArg,
  live,
  apiKeys,
  forceOutage: simulateOutage,
  onToken: (chunk) => {
    process.stdout.write('\b' + chunk); // 逐字打印
  },
});
process.stdout.write('\b \b\n'); // 收尾去掉光标块

await appendUsageLog(LOG_PATH, {
  ts: new Date().toISOString(),
  event: 'llm_call',
  providerId: result.providerId,
  model: result.model,
  mode: live ? 'live' : 'offline-sim',
  effort: effortArg,
  ttftMs: result.ttftMs,
  totalMs: result.totalMs,
  inputTokens: result.usage.inputTokens,
  outputTokens: result.usage.outputTokens,
  usdCost: result.costUsd,
  wasFallback: result.wasFallback,
  simulatedOutage: simulateOutage,
});

console.log('─'.repeat(64));
console.log('\n本次调用小结');
console.log(`  服务厂商 : ${result.providerId}（${result.model}）`);
console.log(`  首字延迟 : ${result.ttftMs} ms（TTFT）`);
console.log(`  总耗时   : ${result.totalMs} ms`);
console.log(`  Token    : 输入 ${result.usage.inputTokens} / 输出 ${result.usage.outputTokens}`);
console.log(`  美元花费 : $${result.costUsd.toFixed(6)}`);
console.log(`  是否切换 : ${result.wasFallback ? '⚠️  主厂商故障，已自动秒切备用厂商（wasFallback: true）' : '否，主厂商一次成功'}`);
console.log(`  仿真标记 : ${result.offlineSim ? '离线高仿真' : '真实 API 调用'}`);
console.log(`  日志落盘 : ${path.relative(ROOT, LOG_PATH)} 已追加 1 条`);
console.log('═'.repeat(64));
