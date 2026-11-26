/**
 * types.ts — Day 33 多租户公平队列：共享类型定义（零第三方依赖）
 * 溯源：Day 33 任务——500 并发多租户公平队列与压测看板。
 * 红线：本模块只做调度与仿真压测（纯只读计算 + 内存态），物理不存在任何
 *      打款 / 写业务数据 / 直连老 ERP 的函数；页面与脚本共用本类型，PII 不入台账。
 */

/** 调度模式：fair = 加权轮询公平队列；fifo = 先来先服务（洪峰对照实验组） */
export type SchedMode = "fair" | "fifo";

/** 租户队列策略（公平调度的唯一真源） */
export interface TenantQueuePolicy {
  tenantId: string;
  /** 页面展示名（中文大白话） */
  displayName: string;
  /** 调度权重（按流量档位：星辰 9 : 瑞康 1） */
  weight: number;
  /**
   * 保底带宽占比（0,1]——两租户同时积压（争抢期）时，每轮调度周期
   * 该租户最少分到的派发容量份额；小租户零饿死的结构性保证。
   */
  minShareFloor: number;
  /** 令牌桶容量（允许的瞬时突发准入量，削峰不拒单） */
  bucketCapacity: number;
  /** 令牌补充速率（个/秒） */
  refillPerSec: number;
}

/** 租户到达计划（仿真压测的请求注入节奏） */
export interface TenantArrivalPlan {
  tenantId: string;
  /** 请求数 */
  count: number;
  /** 首笔到达时刻（相对开跑，毫秒） */
  startMs: number;
  /** 到达窗口跨度（毫秒，窗口内均匀撒点 + 微抖动） */
  windowMs: number;
}

/** 进入调度器的最小请求单元 */
export interface SchedulableRequest {
  reqId: string;
  tenantId: string;
  /** 到达时刻（毫秒时间戳） */
  arriveAt: number;
}

/** 每个调度周期（cycle）的槽位规划（页面展示 + 测试断言用） */
export interface CycleSlotPlan {
  tenantId: string;
  displayName: string;
  /** 纯权重应得槽数 */
  weightSlots: number;
  /** 保底要求槽数 */
  floorSlots: number;
  /** 最终槽数 = max(权重槽, 保底槽) + 不动点补齐 */
  slots: number;
  /** 保底是否生效补了槽数（floorSlots > weightSlots 或被不动点追加） */
  floorBumped: boolean;
  /** 最终槽数占周期比例（= 争抢期实测容量份额） */
  share: number;
}

/** 快照里的单租户实时指标 */
export interface TenantSample {
  tenantId: string;
  displayName: string;
  /** 调度队列中等待数 */
  waiting: number;
  /** 令牌桶前排队（已到达、待准入）数 */
  admissionWaiting: number;
  /** 正在处理数 */
  running: number;
  /** 已完成数 */
  done: number;
  /** 失败数（仿真中恒为 0：削峰不拒单，只排队不丢弃） */
  failed: number;
  /** 当前令牌余量 */
  tokens: number;
  bucketCapacity: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

/** 某一调度模式在某一时刻的全局快照（压测曲线的数据点） */
export interface SnapshotSample {
  /** 相对开跑秒数 */
  tSec: number;
  mode: SchedMode;
  /** 全局调度队列深度（两租户等待之和） */
  queueDepth: number;
  /** 全局在处理数 */
  running: number;
  /** 全局完成数 */
  doneCount: number;
  tenants: TenantSample[];
}

/** 单租户终局统计 */
export interface TenantFinalStats {
  tenantId: string;
  displayName: string;
  total: number;
  done: number;
  failed: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  avgMs: number;
  /** 最长调度排队等待（dispatchAt − admittedAt） */
  maxWaitMs: number;
  /** 争抢期派发占比（仅在两租户同时有积压时派发的请求口径） */
  contendedShare: number;
  contendedDispatches: number;
  /** 争抢期全部派发笔数（两引擎合计口径，用于计算占比） */
  contendedTotal: number;
}

/** 单个调度模式的终局战报 */
export interface ModeReport {
  mode: SchedMode;
  /** 该模式总耗时 */
  wallMs: number;
  /** 吞吐（笔/秒） */
  throughputPerSec: number;
  tenants: TenantFinalStats[];
}

/** 护栏自检项（沿用 Day 24 演习口径：失败绝不硬凑 PASS） */
export interface GuardCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** Day 33 压测终局报告（页面战报卡 + 台账 + 脚本共用） */
export interface QueueLabReport {
  runId: string;
  startedAt: string;
  wallMs: number;
  planSummary: {
    totalRequests: number;
    poolCapacity: number;
    serviceMinMs: number;
    serviceMaxMs: number;
    seed: number;
    cycleLen: number;
    cycle: CycleSlotPlan[];
  };
  fair: ModeReport;
  fifo: ModeReport;
  comparison: {
    ruikangP95FairMs: number;
    ruikangP95FifoMs: number;
    /** 公平队列把瑞康 P95 压低了多少倍 */
    improvementX: number;
    ruikangMaxWaitFairMs: number;
    ruikangMaxWaitFifoMs: number;
  };
  /** 失败率（百分比，期望恒为 0） */
  failureRatePct: number;
  checks: GuardCheck[];
  allPass: boolean;
}

/** SSE / 回调事件流（页面与脚本共用同一事件契约） */
export type QueueLabEvent =
  | {
      type: "run_started";
      runId: string;
      totalRequests: number;
      poolCapacity: number;
      cycle: CycleSlotPlan[];
      tenants: { tenantId: string; displayName: string; count: number; floorShare: number }[];
    }
  | { type: "snapshot"; elapsedMs: number; fair: SnapshotSample; fifo: SnapshotSample }
  | { type: "report"; report: QueueLabReport }
  | { type: "done"; runId: string; wallMs: number }
  | { type: "error"; message: string };
