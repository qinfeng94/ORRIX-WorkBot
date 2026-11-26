/**
 * fleet-scheduler.mjs — Day 22 并发代理军团调度器（零第三方依赖，纯 Node 内置模块）
 *
 * 红线落地（承接 AGENTS.md + .fde/04 权限边界单）：
 * - 初审代理全程只读：读每日定时只读快照、产出初审结论文本，不写任何业务数据；
 * - FIN-001 强制人工审批：财务部单笔金额 > ¥50,000（「超过」才触发，等于不触发）
 *   一律拦截并转具名审批人；疑似拆单按合并口径处理并上报；
 * - 注册表物理无打款工具：本模块只含「调度 + 只读初审」，不存在任何付款动作；
 * - 客户姓名一律脱敏（王* / 李*），PII 不进日志、不进报告全文；
 * - 计费口径复用 Day 6 llm-client 的 estimateCostUsd（离线高仿真，--live 由调用方接入）。
 *
 * 并发设计：
 * - 固定容量工作池（默认 10 路并行），队列拉取式分发，跑完即收；
 * - 瞬时故障按指数退避重试（300ms → 600ms → 1200ms，默认最多 3 次）；
 * - 事件回调贯穿全程（fleet_start / ticket_start / ticket_retry / ticket_done / fleet_done），
 *   CLI 渲染终端进度条，网页端走 SSE 实时刷新，两侧共用同一份核心逻辑。
 */

import { estimateCostUsd, MODEL_REGISTRY } from '../llm/llm-client.mjs';

/** 主力初审模型（离线高仿真；真实 Key 由调用方以 --live 接入） */
const PRIMARY_MODEL = 'claude';

/* ================================================================
 * 一、确定性伪随机（mulberry32）：同 seed 重跑结果完全可复现
 * ================================================================ */

/**
 * @param {number} seed
 * @returns {() => number} [0, 1) 均匀分布
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ================================================================
 * 二、异常单据批量构造器（虚构演示数据，姓名已脱敏）
 * ================================================================ */

const DEPTS = /** @type {const} */ ({
  finance: '财务部',
  service: '客服部',
  logistics: '物流部',
});

const ISSUES = [
  '明细相加与合计不符（疑似错账）',
  '重复扣款申诉',
  '发票抬头与合同主体不一致',
  '付款金额超出合同约定上限',
  '附件缺失：增值税发票未上传',
  '供应商账户变更未留痕',
];

const SURNAME_POOL = ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴'];

/**
 * 构造一笔异常单据（确定性与 seed 绑定）
 * @param {number} idx
 * @param {'finance' | 'service' | 'logistics'} dept
 * @param {number} amountCny
 * @param {number} rng01 0~1 随机数（由调用方按序取数，保证可复现）
 * @param {string | null} [splitGroup]
 * @param {number} [customerIdSeq]
 * @returns {FleetTicket}
 */
function buildTicket(idx, dept, amountCny, rng01, splitGroup = null, customerIdSeq = idx) {
  const surname = SURNAME_POOL[idx % SURNAME_POOL.length];
  return {
    ticketId: `TCK-${2200 + idx}`,
    customerId: `CUST-${4100 + (customerIdSeq % 25)}`,
    customerName: `${surname}*`, // PII 脱敏：只留姓
    dept,
    deptLabel: DEPTS[dept],
    amountCny,
    issue: ISSUES[Math.floor(rng01 * ISSUES.length)],
    issueDate: '2026-11-25',
    splitGroup,
  };
}

/**
 * 生成整批异常单据（默认 50 笔）
 * 桶位设计（按「成对」决策，保证拆单组两笔必然同客户同日）：
 * - 约 8% 的对 → 拆单疑似组：两笔均 < ¥50,000 但合并超过红线（合并口径考点）；
 * - 约 8% 的对 → 边界样本：一笔恰好 ¥50,000（「等于不触发」考点）；
 * - 其余单笔独立随机（约 1/5 财务大额直接触发 FIN-001，其余客服/物流普通异常）。
 * @param {number} [total]
 * @param {number} [seed]
 * @returns {FleetTicket[]}
 */
export function buildFleetBatch(total = 50, seed = 20221122) {
  const rng = mulberry32(seed);
  /** @type {FleetTicket[]} */
  const tickets = [];
  let idx = 0;
  let splitSeq = 0;
  const pairCount = Math.ceil(total / 2);
  for (let p = 0; p < pairCount && tickets.length < total; p++) {
    const pairRoll = rng();
    const solo = total - tickets.length === 1;
    if (!solo && pairRoll < 0.16) {
      // 拆单疑似组：同客户同日两笔拼单，单笔均 < 50,000，合并必然「超过」
      const merged = 50_500 + Math.floor(rng() * 12) * 300; // ¥50,500 ~ ¥53,800
      const first = 20_000 + Math.floor(rng() * 4_000);
      tickets.push(buildTicket(idx++, 'finance', first, rng(), `SPLIT-${++splitSeq}`, p));
      tickets.push(buildTicket(idx++, 'finance', merged - first, rng(), `SPLIT-${splitSeq}`, p));
      continue;
    }
    if (!solo && pairRoll < 0.24) {
      // 边界样本：一笔恰好 ¥50,000（FIN-001 不触发）+ 一笔普通财务单
      tickets.push(buildTicket(idx++, 'finance', 50_000, rng()));
      tickets.push(buildTicket(idx++, 'finance', 8_000 + Math.floor(rng() * 10_000), rng()));
      continue;
    }
    // 普通两笔：各自独立随机（财务大额 / 客服 / 物流）
    for (let k = 0; k < 2 && tickets.length < total; k++) {
      const roll = rng();
      let dept = /** @type {'finance' | 'service' | 'logistics'} */ ('service');
      let amountCny;
      if (roll < 0.22) {
        dept = 'finance';
        amountCny = 50_001 + Math.floor(rng() * 30) * 500; // 必然「超过」红线
      } else if (roll < 0.56) {
        amountCny = 800 + Math.floor(rng() * 40) * 250;
      } else {
        dept = 'logistics';
        amountCny = 1_200 + Math.floor(rng() * 30) * 180;
      }
      tickets.push(buildTicket(idx++, dept, amountCny, rng()));
    }
  }
  return tickets;
}

/* ================================================================
 * 三、FIN-001 判定（确定性规则，与大模型无关，防算术幻觉）
 * ================================================================ */

/** 红线金额：单笔「超过」¥50,000 才触发（等于不触发） */
const FIN001_THRESHOLD_CNY = 50_000;

/**
 * 预计算拆单组：同客户同日多笔、合并金额超过红线的，整组按合并口径上报
 * @param {FleetTicket[]} tickets
 * @returns {Map<string, number>} groupKey → 合并金额
 */
export function buildSplitGroups(tickets) {
  /** @type {Map<string, {sum: number, count: number}>} */
  const groups = new Map();
  for (const t of tickets) {
    if (!t.splitGroup) continue;
    const key = `${t.customerId}|${t.issueDate}|${t.splitGroup}`;
    const g = groups.get(key) ?? { sum: 0, count: 0 };
    g.sum += t.amountCny;
    g.count += 1;
    groups.set(key, g);
  }
  /** @type {Map<string, number>} */
  const merged = new Map();
  for (const [key, g] of groups) {
    if (g.count >= 2 && g.sum > FIN001_THRESHOLD_CNY) merged.set(key, g.sum);
  }
  return merged;
}

/**
 * FIN-001 判定：直接大额 或 疑似拆单合并超限
 * @param {FleetTicket} t
 * @param {Map<string, number>} splitGroups
 * @returns {{ triggered: boolean, reason: string, mergedAmountCny: number | null }}
 */
export function checkFin001(t, splitGroups) {
  const splitKey = `${t.customerId}|${t.issueDate}|${t.splitGroup}`;
  const mergedAmount = splitGroups.get(splitKey);
  if (t.dept === 'finance' && t.amountCny > FIN001_THRESHOLD_CNY) {
    return {
      triggered: true,
      reason: `单笔 ¥${t.amountCny.toLocaleString('zh-CN')} 超过红线 ¥50,000（FIN-001 强制人工审批）`,
      mergedAmountCny: null,
    };
  }
  if (mergedAmount !== undefined) {
    return {
      triggered: true,
      reason: `疑似拆单（同客户同日 ${mergedAmount.toLocaleString('zh-CN')} 拼单），按合并口径 ¥${mergedAmount.toLocaleString('zh-CN')} 超过红线，整组上报`,
      mergedAmountCny: mergedAmount,
    };
  }
  return { triggered: false, reason: '', mergedAmountCny: null };
}

/* ================================================================
 * 四、初审代理离线高仿真（瞬时故障 + 退避重试都由这里注入）
 * ================================================================ */

/** 瞬时故障（上游限流 / 读快照抖动），指数退避可恢复 */
class TransientUpstreamFault extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'TransientUpstreamFault';
  }
}

/** 单次重试退避基期（毫秒）：300 → 600 → 1200 */
const BACKOFF_BASE_MS = 300;

/** 单次初审调用瞬时故障概率（演示注入，离线仿真） */
const TRANSIENT_FAULT_RATE = 0.16;

/**
 * 单次初审 LLM 调用（离线高仿真：确定性延迟 + 确定性故障注入）
 * @param {FleetTicket} t
 * @param {number} rng01 0~1 随机数（由调用方按序取数，保证可复现）
 * @param {{ triggered: boolean, reason: string }} fin001
 * @returns {Promise<{ text: string, durationMs: number, costUsd: number }>}
 */
async function simulateReviewCall(t, rng01, fin001) {
  const startedAt = Date.now();
  await sleep(260 + Math.floor(rng01 * 420)); // 模拟网络 + 读快照 + 推理
  if (rng01 < TRANSIENT_FAULT_RATE) {
    throw new TransientUpstreamFault('上游快照服务瞬时抖动（429/503，可退避恢复）');
  }
  const reply = fin001.triggered
    ? `${t.ticketId} 初审：${t.issue}，涉及 ${t.customerName}（${t.customerId}）。${fin001.reason}。已生成琥珀色预警卡片并挂「FIN-001 强制人工审批」徽章，等待具名审批人签字；我方不会执行任何付款动作。`
    : `${t.ticketId} 初审完成：${t.issue}，涉及 ${t.customerName}（${t.customerId}），金额 ¥${t.amountCny.toLocaleString('zh-CN')}。已起草处理建议放入草稿区（AI 只读 + 起草），等待 ${t.deptLabel}人工确认，不执行任何写操作。`;
  const inputTokens = Math.ceil((t.issue.length + 90) / 1.5);
  const outputTokens = Math.ceil(reply.length / 1.5);
  const costUsd = estimateCostUsd(PRIMARY_MODEL, inputTokens, outputTokens);
  return {
    text: reply,
    durationMs: Date.now() - startedAt,
    costUsd,
    inputTokens,
    outputTokens,
    model: MODEL_REGISTRY[PRIMARY_MODEL].model,
  };
}

/* ================================================================
 * 五、并发池调度主入口
 * ================================================================ */

/**
 * @typedef {Object} FleetTicket
 * @property {string} ticketId
 * @property {string} customerId
 * @property {string} customerName  已脱敏（王*）
 * @property {'finance' | 'service' | 'logistics'} dept
 * @property {string} deptLabel
 * @property {number} amountCny
 * @property {string} issue
 * @property {string} issueDate
 * @property {string | null} splitGroup
 */

/** @typedef {'done' | 'fin001_intercepted' | 'failed'} FleetTicketStatus */

/**
 * @typedef {Object} FleetTicketResult
 * @property {string} ticketId
 * @property {string} customerId
 * @property {string} customerName
 * @property {string} deptLabel
 * @property {number} amountCny
 * @property {string} issue
 * @property {'done' | 'fin001_intercepted' | 'failed'} status
 * @property {boolean} fin001Triggered
 * @property {string} fin001Reason
 * @property {number | null} mergedAmountCny
 * @property {number} attempts
 * @property {number} retries
 * @property {number} durationMs  单笔端到端耗时（含重试退避）
 * @property {number} costUsd     含失败尝试的累计费用
 * @property {string} note
 */

/**
 * @typedef {Object} FleetReport
 * @property {string} runId
 * @property {'cli' | 'web'} runBy
 * @property {string} startedAt
 * @property {string} finishedAt
 * @property {{ total: number, concurrency: number, maxAttempts: number, seed: number }} config
 * @property {{ totalElapsedMs: number, avgPerTicketMs: number, p95PerTicketMs: number, maxPerTicketMs: number, totalCostUsd: number, fin001Intercepted: number, succeeded: number, failed: number, totalRetries: number, throughputPerMinute: number }} stats
 * @property {FleetTicketResult[]} tickets
 */

/**
 * @typedef {Object} FleetEvent
 * @property {'fleet_start' | 'ticket_start' | 'ticket_retry' | 'ticket_done' | 'fleet_done'} type
 * @property {number} [total]
 * @property {number} [concurrency]
 * @property {string} [ticketId]
 * @property {number} [done]
 * @property {number} [attempt]
 * @property {number} [waitMs]
 * @property {string} [reason]
 * @property {'done' | 'fin001_intercepted' | 'failed'} [status]
 * @property {boolean} [fin001Triggered]
 * @property {number} [durationMs]
 * @property {number} [costUsd]
 * @property {FleetReport} [report]
 * @property {string} [fatal] 调度器异常熔断原因（正常跑批不出现，网页端如实上报）
 */

/**
 * 跑一批异常单据初审（并发池 + 指数退避重试 + FIN-001 拦截 + 用量统计）
 * @param {Object} opts
 * @param {number} [opts.total=50]
 * @param {number} [opts.concurrency=10]
 * @param {number} [opts.maxAttempts=3]
 * @param {number} [opts.seed]
 * @param {'cli' | 'web'} [opts.runBy]
 * @param {(event: FleetEvent) => void} [opts.onEvent]
 * @returns {Promise<FleetReport>}
 */
export async function runFleet(opts = {}) {
  const total = Math.max(1, Math.min(opts.total ?? 50, 500));
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 10, total));
  const maxAttempts = Math.max(1, Math.min(opts.maxAttempts ?? 3, 6));
  const seed = opts.seed ?? 20221122;
  const runBy = opts.runBy === 'web' ? 'web' : 'cli';
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};

  const tickets = buildFleetBatch(total, seed);
  const splitGroups = buildSplitGroups(tickets);

  const startedAt = Date.now();
  onEvent({ type: 'fleet_start', total, concurrency });

  /** @type {FleetTicketResult[]} */
  const results = [];
  let nextIndex = 0;
  let doneCount = 0;

  /**
   * 单笔初审全流程（含退避重试），由工作池拉取执行
   * @param {FleetTicket} t
   * @returns {Promise<FleetTicketResult>}
   */
  async function reviewOne(t) {
    const ticketStart = Date.now();
    const fin001 = checkFin001(t, splitGroups);
    /** @type {FleetTicketResult} */
    const result = {
      ticketId: t.ticketId,
      customerId: t.customerId,
      customerName: t.customerName,
      deptLabel: t.deptLabel,
      amountCny: t.amountCny,
      issue: t.issue,
      status: 'done',
      fin001Triggered: fin001.triggered,
      fin001Reason: fin001.reason,
      mergedAmountCny: fin001.mergedAmountCny,
      attempts: 0,
      retries: 0,
      durationMs: 0,
      costUsd: 0,
      note: '',
    };
    onEvent({ type: 'ticket_start', ticketId: t.ticketId });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      result.attempts = attempt;
      try {
        const call = await simulateReviewCall(t, rng(), fin001);
        result.costUsd = Number((result.costUsd + call.costUsd).toFixed(6));
        result.durationMs = Date.now() - ticketStart;
        result.status = fin001.triggered ? 'fin001_intercepted' : 'done';
        result.note = fin001.triggered
          ? '已拦截转人工，具名审批人放行前不推进'
          : '草稿区待人工确认';
        onEvent({
          type: 'ticket_done',
          ticketId: t.ticketId,
          status: result.status,
          fin001Triggered: fin001.triggered,
          attempt,
          durationMs: result.durationMs,
          costUsd: result.costUsd,
        });
        return result;
      } catch (err) {
        result.costUsd = Number((result.costUsd + 0.000012).toFixed(6)); // 失败尝试也产生少量输入费用
        if (attempt < maxAttempts) {
          const waitMs = BACKOFF_BASE_MS * 2 ** (attempt - 1);
          result.retries = attempt;
          onEvent({
            type: 'ticket_retry',
            ticketId: t.ticketId,
            attempt,
            waitMs,
            reason: err instanceof Error ? err.message : '未知瞬时故障',
          });
          await sleep(waitMs);
        }
      }
    }
    // 全部重试耗尽：如实标记失败，宁缺毋滥，绝不硬凑结论
    result.status = 'failed';
    result.durationMs = Date.now() - ticketStart;
    result.note = `重试 ${maxAttempts} 次仍未恢复，已转人工兜底`;
    onEvent({
      type: 'ticket_done',
      ticketId: t.ticketId,
      status: 'failed',
      fin001Triggered: false,
      attempt: maxAttempts,
      durationMs: result.durationMs,
      costUsd: result.costUsd,
    });
    return result;
  }

  /** 固定容量工作池：每路 worker 从队列拉单，跑完即收 */
  async function worker() {
    while (nextIndex < tickets.length) {
      const idx = nextIndex++;
      const res = await reviewOne(tickets[idx]);
      results.push(res);
      doneCount += 1;
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, tickets.length) }, () => worker()),
  );

  const totalElapsedMs = Date.now() - startedAt;
  const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
  const p95 = durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))];
  const stats = {
    totalElapsedMs,
    avgPerTicketMs: Math.round(durations.reduce((s, d) => s + d, 0) / (durations.length || 1)),
    p95PerTicketMs: p95 ?? 0,
    maxPerTicketMs: durations[durations.length - 1] ?? 0,
    totalCostUsd: Number(results.reduce((s, r) => s + r.costUsd, 0).toFixed(6)),
    fin001Intercepted: results.filter((r) => r.status === 'fin001_intercepted').length,
    succeeded: results.filter((r) => r.status === 'done').length,
    failed: results.filter((r) => r.status === 'failed').length,
    totalRetries: results.reduce((s, r) => s + r.retries, 0),
    throughputPerMinute: Number(((results.length / totalElapsedMs) * 60_000).toFixed(1)),
  };

  /** @type {FleetReport} */
  const report = {
    runId: `fleet-${startedAt}`,
    runBy,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    config: { total, concurrency, maxAttempts, seed },
    stats,
    tickets: results,
  };
  onEvent({ type: 'fleet_done', report });
  return report;
}
