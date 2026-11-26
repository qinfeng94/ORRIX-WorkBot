/**
 * load-test.ts — Day 33 500 并发多租户仿真压测编排引擎（零第三方依赖）
 *
 * 演习设计（对照实验）：
 *   · 同一批 500 笔请求（星辰 450 洪峰 + 瑞康 50 常态）、同一组配对随机服务耗时，
 *     分别灌入「公平队列（加权轮询 + 保底带宽）」与「先来先服务 FIFO」两个引擎；
 *   · 唯一变量是派发顺序，其余完全一致——瑞康 P95 差异即公平队列的净收益；
 *   · 令牌桶按租户准入削峰（削峰不拒单，物理无丢弃路径 → 0 失败率）；
 *   · 全程实时快照（队列深度 / 令牌余量 / P95），供 SSE 看板逐帧播放。
 *
 * 红线：纯内存仿真 + 只读统计；台账 JSONL 只增不改；无任何打款 / 写业务数据能力。
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { FairShareScheduler, FifoScheduler, computeSlotPlan, type Scheduler } from "./fair-scheduler";
import { TokenBucket } from "./token-bucket";
import type {
  CycleSlotPlan,
  GuardCheck,
  ModeReport,
  QueueLabEvent,
  QueueLabReport,
  SchedMode,
  SnapshotSample,
  SchedulableRequest,
  TenantFinalStats,
  TenantQueuePolicy,
} from "./types";

/* ---------------- 演习计划（默认 500 并发剧本） ---------------- */

export interface QueueLabPlan {
  poolCapacity: number;
  serviceMinMs: number;
  serviceMaxMs: number;
  tickEveryMs: number;
  snapshotEveryMs: number;
  /** 硬上限：超时熔断，绝不无限挂起（后台任务约束） */
  hardCapMs: number;
  cycleBase: number;
  seed: number;
  tenants: TenantQueuePolicy[];
  arrivals: { tenantId: string; count: number; startMs: number; windowMs: number }[];
}

/** Day 33 默认剧本：星辰 450 笔洪峰（1.5 秒内灌入） vs 瑞康 50 笔常态（10 秒匀速） */
export const DAY33_PLAN: QueueLabPlan = {
  poolCapacity: 10,
  serviceMinMs: 150,
  serviceMaxMs: 250,
  tickEveryMs: 40,
  snapshotEveryMs: 250,
  hardCapMs: 90_000,
  cycleBase: 20,
  seed: 20331126,
  tenants: [
    {
      tenantId: "xingchen",
      displayName: "星辰跨境企服集团",
      weight: 9,
      minShareFloor: 0.05,
      bucketCapacity: 200,
      refillPerSec: 100,
    },
    {
      tenantId: "ruikang",
      displayName: "瑞康医疗器械集团",
      weight: 1,
      minShareFloor: 0.15,
      bucketCapacity: 30,
      refillPerSec: 10,
    },
  ],
  arrivals: [
    { tenantId: "xingchen", count: 450, startMs: 200, windowMs: 1500 },
    { tenantId: "ruikang", count: 50, startMs: 0, windowMs: 10_000 },
  ],
};

/* ---------------- 工具：种子随机 + 百分位 ---------------- */

/** mulberry32 种子随机（配对实验：两引擎共享同一组服务耗时） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 最近邻秩百分位（毫秒取整；空集返回 0，绝不产生 NaN） */
export function percentileOf(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

/* ---------------- 引擎内部结构 ---------------- */

interface RequestRecord {
  req: SchedulableRequest;
  serviceMs: number;
  admittedAt: number | null;
  dispatchAt: number | null;
  completeAt: number | null;
}

interface ModeEngine {
  mode: SchedMode;
  scheduler: Scheduler;
  buckets: Map<string, TokenBucket>;
  arrivals: { req: SchedulableRequest; serviceMs: number }[];
  arrivalIdx: number;
  admissionBuffer: SchedulableRequest[];
  admissionWaitingByTenant: Map<string, number>;
  peakAdmissionByTenant: Map<string, number>;
  records: Map<string, RequestRecord>;
  running: Map<string, ReturnType<typeof setTimeout>>;
  runningByTenant: Map<string, number>;
  doneByTenant: Map<string, number>;
  failed: number;
  latenciesByTenant: Map<string, number[]>;
  samples: SnapshotSample[];
  contendedDispatchesByTenant: Map<string, number>;
  contendedTotal: number;
}

const nowMs = (): number => Date.now();

function buildEngine(
  mode: SchedMode,
  plan: QueueLabPlan,
  sharedArrivals: readonly { req: SchedulableRequest; serviceMs: number }[],
): ModeEngine {
  const scheduler: Scheduler =
    mode === "fair" ? new FairShareScheduler(plan.tenants, plan.cycleBase) : new FifoScheduler();
  const buckets = new Map<string, TokenBucket>();
  for (const t of plan.tenants) {
    buckets.set(t.tenantId, new TokenBucket(t.bucketCapacity, t.refillPerSec, nowMs));
  }
  const engine: ModeEngine = {
    mode,
    scheduler,
    buckets,
    arrivals: sharedArrivals.map((a) => ({ req: { ...a.req }, serviceMs: a.serviceMs })),
    arrivalIdx: 0,
    admissionBuffer: [],
    admissionWaitingByTenant: new Map(plan.tenants.map((t) => [t.tenantId, 0] as const)),
    peakAdmissionByTenant: new Map(plan.tenants.map((t) => [t.tenantId, 0] as const)),
    records: new Map(),
    running: new Map(),
    runningByTenant: new Map(plan.tenants.map((t) => [t.tenantId, 0] as const)),
    doneByTenant: new Map(plan.tenants.map((t) => [t.tenantId, 0] as const)),
    failed: 0,
    latenciesByTenant: new Map(plan.tenants.map((t) => [t.tenantId, [] as number[]] as const)),
    samples: [],
    contendedDispatchesByTenant: new Map(plan.tenants.map((t) => [t.tenantId, 0] as const)),
    contendedTotal: 0,
  };
  for (const a of engine.arrivals) {
    engine.records.set(a.req.reqId, {
      req: a.req,
      serviceMs: a.serviceMs,
      admittedAt: null,
      dispatchAt: null,
      completeAt: null,
    });
  }
  return engine;
}

/* ---------------- 引擎节拍：到达 → 令牌准入 → 满池派发 ---------------- */

function tickEngine(engine: ModeEngine, plan: QueueLabPlan, now: number): void {
  // 1) 到期到达 → 准入缓冲（令牌桶前排队）
  while (engine.arrivalIdx < engine.arrivals.length) {
    const next = engine.arrivals[engine.arrivalIdx];
    if (next.req.arriveAt > now) break;
    engine.arrivalIdx += 1;
    engine.admissionBuffer.push(next.req);
    engine.admissionWaitingByTenant.set(
      next.req.tenantId,
      (engine.admissionWaitingByTenant.get(next.req.tenantId) ?? 0) + 1,
    );
    const tenantPeak = engine.peakAdmissionByTenant.get(next.req.tenantId) ?? 0;
    const bufLen = engine.admissionBuffer.filter((r) => r.tenantId === next.req.tenantId).length;
    if (bufLen > tenantPeak) engine.peakAdmissionByTenant.set(next.req.tenantId, bufLen);
  }
  // 2) 令牌桶准入：有令牌才进调度队列（削峰不拒单，等令牌 = 排队而非丢弃）
  while (engine.admissionBuffer.length > 0) {
    const head = engine.admissionBuffer[0];
    const bucket = engine.buckets.get(head.tenantId);
    if (!bucket || !bucket.tryTake(1)) break;
    engine.admissionBuffer.shift();
    engine.admissionWaitingByTenant.set(
      head.tenantId,
      Math.max(0, (engine.admissionWaitingByTenant.get(head.tenantId) ?? 0) - 1),
    );
    const rec = engine.records.get(head.reqId);
    if (rec) rec.admittedAt = now;
    engine.scheduler.enqueue(head);
  }
  // 3) 尽量填满处理池（争抢期口径：派发瞬间 ≥2 租户积压）
  fillPool(engine, plan, now);
}

function fillPool(engine: ModeEngine, plan: QueueLabPlan, now: number): void {
  while (engine.running.size < plan.poolCapacity) {
    const contended = engine.scheduler.backlogTenantCount() >= 2;
    const req = engine.scheduler.pickNext();
    if (!req) break;
    const rec = engine.records.get(req.reqId);
    if (!rec) {
      engine.failed += 1;
      continue;
    }
    rec.dispatchAt = now;
    if (engine.mode === "fair" && contended) {
      engine.contendedDispatchesByTenant.set(
        req.tenantId,
        (engine.contendedDispatchesByTenant.get(req.tenantId) ?? 0) + 1,
      );
      engine.contendedTotal += 1;
    }
    const tenantId = req.tenantId;
    engine.runningByTenant.set(tenantId, (engine.runningByTenant.get(tenantId) ?? 0) + 1);
    const timer = setTimeout(() => {
      engine.running.delete(req.reqId);
      engine.runningByTenant.set(tenantId, Math.max(0, (engine.runningByTenant.get(tenantId) ?? 0) - 1));
      rec.completeAt = nowMs();
      engine.doneByTenant.set(tenantId, (engine.doneByTenant.get(tenantId) ?? 0) + 1);
      const lat = engine.latenciesByTenant.get(tenantId);
      if (lat && rec.completeAt !== null) lat.push(rec.completeAt - req.arriveAt);
      // 完工即补位，保持处理池满载（避免 tick 间隙空转）
      fillPool(engine, plan, nowMs());
    }, rec.serviceMs);
    engine.running.set(req.reqId, timer);
  }
}

function engineFinished(engine: ModeEngine): boolean {
  return (
    engine.arrivalIdx >= engine.arrivals.length &&
    engine.admissionBuffer.length === 0 &&
    engine.scheduler.totalDepth() === 0 &&
    engine.running.size === 0
  );
}

/* ---------------- 快照 ---------------- */

function buildSample(engine: ModeEngine, plan: QueueLabPlan, elapsedMs: number): SnapshotSample {
  const tenants: TenantSampleLike[] = plan.tenants.map((p) => {
    const lat = engine.latenciesByTenant.get(p.tenantId) ?? [];
    return {
      tenantId: p.tenantId,
      displayName: p.displayName,
      waiting: engine.scheduler.depthOf(p.tenantId),
      admissionWaiting: engine.admissionWaitingByTenant.get(p.tenantId) ?? 0,
      running: engine.runningByTenant.get(p.tenantId) ?? 0,
      done: engine.doneByTenant.get(p.tenantId) ?? 0,
      failed: 0,
      tokens: Math.floor(engine.buckets.get(p.tenantId)?.peek() ?? 0),
      bucketCapacity: p.bucketCapacity,
      p50Ms: percentileOf(lat, 50),
      p95Ms: percentileOf(lat, 95),
      p99Ms: percentileOf(lat, 99),
    };
  });
  return {
    tSec: Math.round(elapsedMs / 100) / 10,
    mode: engine.mode,
    queueDepth: engine.scheduler.totalDepth(),
    running: engine.running.size,
    doneCount: tenants.reduce((acc, t) => acc + t.done, 0),
    tenants,
  };
}

type TenantSampleLike = SnapshotSample["tenants"][number];

/* ---------------- 终局统计与战报 ---------------- */

function finalizeEngine(engine: ModeEngine, plan: QueueLabPlan, wallMs: number): ModeReport {
  const tenants: TenantFinalStats[] = plan.tenants.map((p) => {
    const lat = engine.latenciesByTenant.get(p.tenantId) ?? [];
    let maxWaitMs = 0;
    for (const rec of engine.records.values()) {
      if (rec.req.tenantId !== p.tenantId) continue;
      if (rec.admittedAt !== null && rec.dispatchAt !== null) {
        maxWaitMs = Math.max(maxWaitMs, rec.dispatchAt - rec.admittedAt);
      }
    }
    const total = engine.arrivals.filter((a) => a.req.tenantId === p.tenantId).length;
    const done = engine.doneByTenant.get(p.tenantId) ?? 0;
    const contendedDispatches = engine.contendedDispatchesByTenant.get(p.tenantId) ?? 0;
    return {
      tenantId: p.tenantId,
      displayName: p.displayName,
      total,
      done,
      failed: 0,
      p50Ms: percentileOf(lat, 50),
      p95Ms: percentileOf(lat, 95),
      p99Ms: percentileOf(lat, 99),
      maxMs: lat.length > 0 ? Math.round(Math.max(...lat)) : 0,
      avgMs: lat.length > 0 ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0,
      maxWaitMs,
      contendedDispatches,
      contendedShare: engine.contendedTotal > 0 ? contendedDispatches / engine.contendedTotal : 0,
      contendedTotal: engine.contendedTotal,
    };
  });
  const totalDone = tenants.reduce((acc, t) => acc + t.done, 0);
  return {
    mode: engine.mode,
    wallMs,
    throughputPerSec: wallMs > 0 ? Math.round((totalDone / (wallMs / 1000)) * 10) / 10 : 0,
    tenants,
  };
}

function tenantOf(report: ModeReport, tenantId: string): TenantFinalStats {
  const t = report.tenants.find((x) => x.tenantId === tenantId);
  if (!t) throw new Error(`战报缺少租户 ${tenantId}`);
  return t;
}

function buildChecks(
  plan: QueueLabPlan,
  report: QueueLabReport,
  cycle: readonly CycleSlotPlan[],
  peakAdmission: ReadonlyMap<string, number>,
): GuardCheck[] {
  const ruikang = plan.tenants.find((t) => t.tenantId === "ruikang");
  const ruikangFloor = ruikang?.minShareFloor ?? 0.15;
  const fairRk = tenantOf(report.fair, "ruikang");
  const fifoRk = tenantOf(report.fifo, "ruikang");
  const fairXc = tenantOf(report.fair, "xingchen");
  const totalRequests = plan.arrivals.reduce((acc, a) => acc + a.count, 0);
  const xcPeak = peakAdmission.get("xingchen") ?? 0;
  return [
    {
      name: "零失败率（削峰不拒单）",
      ok:
        report.fair.tenants.every((t) => t.failed === 0 && t.done === t.total) &&
        report.fifo.tenants.every((t) => t.failed === 0 && t.done === t.total) &&
        report.fair.tenants.reduce((a, t) => a + t.done, 0) === totalRequests,
      detail: `公平组 ${report.fair.tenants.map((t) => `${t.displayName} ${t.done}/${t.total}`).join(" · ")}，FIFO 对照组同样 0 丢弃`,
    },
    {
      name: "瑞康零饿死（公平队列显著优于 FIFO）",
      ok: fairRk.p95Ms < fifoRk.p95Ms && fairRk.maxWaitMs < fifoRk.maxWaitMs,
      detail: `瑞康 P95 公平 ${fairRk.p95Ms}ms < FIFO ${fifoRk.p95Ms}ms；最长排队 ${fairRk.maxWaitMs}ms < ${fifoRk.maxWaitMs}ms`,
    },
    {
      name: `保底带宽兑现（争抢期 ≥ ${Math.round(ruikangFloor * 100)}%）`,
      ok: fairRk.contendedTotal > 0 && fairRk.contendedShare >= ruikangFloor - 1e-6,
      detail: `瑞康争抢期实测派发占比 ${(fairRk.contendedShare * 100).toFixed(1)}%（保底 ${Math.round(
        ruikangFloor * 100,
      )}%，争抢期派发 ${fairRk.contendedDispatches} 笔 / 共 ${fairRk.contendedTotal} 笔）`,
    },
    {
      name: "洪峰不拖垮瑞康常态流量",
      ok: fairRk.p95Ms > 0 && fairRk.p95Ms < 2000,
      detail: `瑞康公平模式 P95 ${fairRk.p95Ms}ms，洪峰期间常态请求照常秒级完成`,
    },
    {
      name: "星辰洪峰被令牌桶削峰（且零拒绝）",
      ok: xcPeak > 0 && fairXc.done === fairXc.total,
      detail: `星辰准入峰值排队 ${xcPeak} 笔被削峰吸收，${fairXc.done}/${fairXc.total} 全部完成，无一笔拒绝`,
    },
    {
      name: "调度周期结构性零饿死（每租户每周期 ≥1 槽）",
      ok:
        cycle.every((e) => e.slots >= 1) &&
        cycle.every((e) => e.share + 1e-9 >= (plan.tenants.find((t) => t.tenantId === e.tenantId)?.minShareFloor ?? 0)),
      detail: `周期 ${cycle.reduce((a, e) => a + e.slots, 0)} 槽：${cycle
        .map((e) => `${e.displayName.slice(0, 2)} ${e.slots} 槽 / ${(e.share * 100).toFixed(1)}%`)
        .join(" · ")}`,
    },
  ];
}

/* ---------------- 单例运行状态（API 路由共用，HMR 安全） ---------------- */

export interface QueueLabRunState {
  runId: string;
  startedAt: string;
  status: "running" | "done" | "error";
  totalRequests: number;
  poolCapacity: number;
  cycle: CycleSlotPlan[];
  tenants: { tenantId: string; displayName: string; count: number; floorShare: number }[];
  elapsedMs: number;
  latest: { fair: SnapshotSample; fifo: SnapshotSample } | null;
  report: QueueLabReport | null;
  samples: { fair: SnapshotSample[]; fifo: SnapshotSample[] };
  error: string | null;
}

interface RunStore {
  run: QueueLabRunState | null;
}

const STORE_KEY = Symbol.for("workbot.queueLab.runStore");

function readStore(): RunStore {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: RunStore };
  if (!g[STORE_KEY]) g[STORE_KEY] = { run: null };
  return g[STORE_KEY];
}

export function getQueueLabRun(): QueueLabRunState | null {
  return readStore().run;
}

/** 占用冲突信号：已有压测在跑时抛出（路由层转 409） */
export class QueueLabConflictError extends Error {
  constructor(runId: string) {
    super(`已有压测任务进行中：${runId}`);
    this.name = "QueueLabConflictError";
  }
}

export interface StartRunOptions extends RunQueueStressOptions {}

/**
 * 立即登记一轮回合并返回句柄（不阻塞）——SSE 路由据此把事件流实时中继给看板；
 * 单例状态同步写回 store（state / latest / samples / report），供 GET 恢复与多端轮询。
 */
export function beginQueueLabRun(options: StartRunOptions = {}): {
  state: QueueLabRunState;
  promise: Promise<QueueLabReport>;
} {
  const store = readStore();
  if (store.run && store.run.status === "running") {
    throw new QueueLabConflictError(store.run.runId);
  }
  const plan = options.plan ?? DAY33_PLAN;
  const t0 = new Date();
  const state: QueueLabRunState = {
    runId: `QL-${t0.getTime()}`,
    startedAt: t0.toISOString(),
    status: "running",
    totalRequests: plan.arrivals.reduce((acc, a) => acc + a.count, 0),
    poolCapacity: plan.poolCapacity,
    cycle: computeSlotPlan(plan.tenants, plan.cycleBase),
    tenants: plan.tenants.map((t) => ({
      tenantId: t.tenantId,
      displayName: t.displayName,
      count: plan.arrivals.find((a) => a.tenantId === t.tenantId)?.count ?? 0,
      floorShare: t.minShareFloor,
    })),
    elapsedMs: 0,
    latest: null,
    report: null,
    samples: { fair: [], fifo: [] },
    error: null,
  };
  store.run = state;
  const promise = runQueueStress({
    ...options,
    onEvent: (event) => {
      options.onEvent?.(event);
      if (event.type === "run_started") {
        state.runId = event.runId;
      } else if (event.type === "snapshot") {
        state.elapsedMs = event.elapsedMs;
        state.latest = { fair: event.fair, fifo: event.fifo };
        state.samples.fair.push(event.fair);
        state.samples.fifo.push(event.fifo);
      } else if (event.type === "report") {
        state.report = event.report;
      } else if (event.type === "error") {
        state.error = event.message;
      }
    },
  }).then(
    (report) => {
      state.status = "done";
      state.elapsedMs = report.wallMs;
      return report;
    },
    (err: unknown) => {
      state.status = "error";
      state.error = err instanceof Error ? err.message : String(err);
      throw err;
    },
  );
  return { state, promise };
}

/* ---------------- 主流程 ---------------- */

export interface RunQueueStressOptions {
  plan?: QueueLabPlan;
  seed?: number;
  ledger?: boolean;
  onEvent?: (event: QueueLabEvent) => void;
}

export const QUEUE_LEDGER_REL_PATH = "data/day33/queue_runs.jsonl";

export async function runQueueStress(options: RunQueueStressOptions = {}): Promise<QueueLabReport> {
  const plan = options.plan ?? DAY33_PLAN;
  const seed = options.seed ?? plan.seed;
  const emit = (event: QueueLabEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // 回调异常绝不中断演习本体
    }
  };

  const rng = mulberry32(seed);
  const t0 = nowMs();
  const totalRequests = plan.arrivals.reduce((acc, a) => acc + a.count, 0);
  const runId = `QL-${t0}`;

  // 预生成到达时刻 + 配对服务耗时（两引擎逐笔相同 → 严格对照实验）
  const sharedArrivals: { req: SchedulableRequest; serviceMs: number }[] = [];
  const counters = new Map<string, number>();
  for (const a of plan.arrivals) {
    const span = a.windowMs > 0 ? a.windowMs : 1;
    for (let i = 0; i < a.count; i += 1) {
      const seq = (counters.get(a.tenantId) ?? 0) + 1;
      counters.set(a.tenantId, seq);
      const jitter = (rng() - 0.5) * 0.2; // ±10% 到达抖动
      const arriveAt = t0 + a.startMs + Math.round(span * ((i + 0.5) / a.count + jitter / a.count));
      const serviceMs = Math.round(plan.serviceMinMs + rng() * (plan.serviceMaxMs - plan.serviceMinMs));
      const prefix = a.tenantId === "xingchen" ? "XC" : a.tenantId === "ruikang" ? "RK" : "TQ";
      sharedArrivals.push({
        req: { reqId: `${prefix}-${String(seq).padStart(3, "0")}`, tenantId: a.tenantId, arriveAt },
        serviceMs,
      });
    }
  }
  sharedArrivals.sort((a, b) => a.req.arriveAt - b.req.arriveAt || a.req.reqId.localeCompare(b.req.reqId));

  const fair = buildEngine("fair", plan, sharedArrivals);
  const fifo = buildEngine("fifo", plan, sharedArrivals);
  const engines: ModeEngine[] = [fair, fifo];
  const cycle = computeSlotPlan(plan.tenants, plan.cycleBase);

  emit({
    type: "run_started",
    runId,
    totalRequests,
    poolCapacity: plan.poolCapacity,
    cycle,
    tenants: plan.tenants.map((t) => ({
      tenantId: t.tenantId,
      displayName: t.displayName,
      count: plan.arrivals.find((a) => a.tenantId === t.tenantId)?.count ?? 0,
      floorShare: t.minShareFloor,
    })),
  });

  return await new Promise<QueueLabReport>((resolveRun, rejectRun) => {
    const intervals: ReturnType<typeof setInterval>[] = [];
    let finished = false;

    const stopTicking = () => {
      for (const id of intervals) clearInterval(id);
      intervals.length = 0;
      for (const engine of engines) {
        for (const timer of engine.running.values()) clearTimeout(timer);
        engine.running.clear();
      }
    };

    const hardCapTimer = setTimeout(() => {
      if (finished) return;
      finished = true;
      stopTicking();
      emit({ type: "error", message: `压测超过硬上限 ${plan.hardCapMs}ms，已熔断切断（不丢日志）` });
      rejectRun(new Error(`压测超过硬上限 ${plan.hardCapMs}ms，已熔断切断`));
    }, plan.hardCapMs);

    // 全局节拍：到达 → 准入 → 派发（两引擎同拍推进）
    intervals.push(
      setInterval(() => {
        const now = nowMs();
        for (const engine of engines) tickEngine(engine, plan, now);
      }, plan.tickEveryMs),
    );

    // 快照节拍：看板曲线逐帧推进
    intervals.push(
      setInterval(() => {
        const elapsedMs = nowMs() - t0;
        const fairSample = buildSample(fair, plan, elapsedMs);
        const fifoSample = buildSample(fifo, plan, elapsedMs);
        fair.samples.push(fairSample);
        fifo.samples.push(fifoSample);
        emit({ type: "snapshot", elapsedMs, fair: fairSample, fifo: fifoSample });
      }, plan.snapshotEveryMs),
    );

    // 终局轮询：两引擎全部跑完即出报告
    intervals.push(
      setInterval(() => {
        if (finished || !engines.every(engineFinished)) return;
        finished = true;
        stopTicking();
        const wallMs = nowMs() - t0;
        const fairReport = finalizeEngine(fair, plan, wallMs);
        const fifoReport = finalizeEngine(fifo, plan, wallMs);
        const rkFair = tenantOf(fairReport, "ruikang");
        const rkFifo = tenantOf(fifoReport, "ruikang");

        const peakAdmission = new Map<string, number>();
        for (const engine of engines) {
          for (const [tenantId, peak] of engine.peakAdmissionByTenant) {
            peakAdmission.set(tenantId, Math.max(peakAdmission.get(tenantId) ?? 0, peak));
          }
        }

        const report: QueueLabReport = {
          runId,
          startedAt: new Date(t0).toISOString(),
          wallMs,
          planSummary: {
            totalRequests,
            poolCapacity: plan.poolCapacity,
            serviceMinMs: plan.serviceMinMs,
            serviceMaxMs: plan.serviceMaxMs,
            seed,
            cycleLen: cycle.reduce((acc, e) => acc + e.slots, 0),
            cycle,
          },
          fair: fairReport,
          fifo: fifoReport,
          comparison: {
            ruikangP95FairMs: rkFair.p95Ms,
            ruikangP95FifoMs: rkFifo.p95Ms,
            improvementX: rkFair.p95Ms > 0 ? Math.round((rkFifo.p95Ms / rkFair.p95Ms) * 10) / 10 : 0,
            ruikangMaxWaitFairMs: rkFair.maxWaitMs,
            ruikangMaxWaitFifoMs: rkFifo.maxWaitMs,
          },
          failureRatePct: 0, // 仿真无丢弃路径，失败率恒为 0（战报口径）
          checks: [],
          allPass: false,
        };
        report.checks = buildChecks(plan, report, cycle, peakAdmission);
        report.allPass = report.checks.every((c) => c.ok);

        emit({ type: "report", report });
        emit({ type: "done", runId, wallMs });

        // 台账：JSONL 只增不改（纯统计口径，无任何 PII / 提问原文）
        const finish = async () => {
          if (options.ledger === false) return;
          try {
            const line =
              JSON.stringify({
                ts: new Date().toISOString(),
                runId: report.runId,
                wallMs: report.wallMs,
                failureRatePct: report.failureRatePct,
                allPass: report.allPass,
                fair: Object.fromEntries(report.fair.tenants.map((t) => [t.tenantId, t.p95Ms])),
                fifo: Object.fromEntries(report.fifo.tenants.map((t) => [t.tenantId, t.p95Ms])),
                improvementX: report.comparison.improvementX,
                ruikangContendedSharePct: Math.round(rkFair.contendedShare * 1000) / 10,
                peakAdmission: Object.fromEntries(peakAdmission),
                seed: report.planSummary.seed,
              }) + "\n";
            const abs = resolve(process.cwd(), QUEUE_LEDGER_REL_PATH);
            await mkdir(dirname(abs), { recursive: true });
            await appendFile(abs, line, "utf8");
          } catch {
            // 台账写入失败不影响演习结论（本地演示环境），绝不中断主流程
          }
        };
        void finish().finally(() => resolveRun(report));
      }, 100),
    );
  });
}
