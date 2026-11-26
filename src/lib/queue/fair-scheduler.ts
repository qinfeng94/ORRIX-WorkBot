/**
 * fair-scheduler.ts — 多租户公平队列调度器核心（零第三方依赖，纯逻辑可单测）
 *
 * 调度模型：每租户一条 FIFO 队列 + 「平滑加权轮询」派发周期（cycle）。
 *   1. computeSlotPlan：按租户权重分配每周期槽位数，再用「保底带宽」不动点补齐——
 *      保证任何积压租户每周期至少分到 minShareFloor × 周期长度 个槽位（且 ≥1 槽），
 *      这是小租户零饿死的结构性保证（大租户洪峰灌满队列也挤不掉）。
 *   2. buildCycle：把槽位用平滑加权轮询交错展开，避免小租户整周期垫底尾延迟。
 *   3. pickNext：从游标处向后找第一个「非空队列租户」的槽位派发；空槽自然被
 *      跳过（闲置份额被在忙租户借走，工作保持 work-conserving），
 *      而积压租户的槽位每周期必然轮到——借走的是闲置份额，不欠新账。
 *
 * 对照组 FifoScheduler：单条全局先来先服务队列，用来在演习里复现
 * 「大租户洪峰挤占共享池、小租户排队尾延迟爆炸」的反面教材。
 */

import type { CycleSlotPlan, SchedMode, SchedulableRequest, TenantQueuePolicy } from "./types";

/** 计算每周期槽位规划（fail-closed：非法配置直接抛错拒启动） */
export function computeSlotPlan(
  policies: readonly TenantQueuePolicy[],
  cycleBase: number,
): CycleSlotPlan[] {
  if (policies.length === 0) throw new Error("至少需要一个租户策略");
  if (!(cycleBase >= policies.length)) throw new Error("调度周期长度必须 ≥ 租户数");
  const sumFloor = policies.reduce((acc, p) => acc + p.minShareFloor, 0);
  if (sumFloor > 1 + 1e-9) throw new Error(`保底带宽总和 ${sumFloor} 超过 100%，配置非法`);
  const sumWeight = policies.reduce((acc, p) => acc + p.weight, 0);
  if (!(sumWeight > 0)) throw new Error("租户权重之和必须 > 0");

  const plan: CycleSlotPlan[] = policies.map((p) => {
    if (!(p.weight > 0)) throw new Error(`租户 ${p.tenantId} 权重必须 > 0`);
    if (!(p.minShareFloor > 0 && p.minShareFloor <= 1)) {
      throw new Error(`租户 ${p.tenantId} 保底带宽必须是 (0,1] 区间`);
    }
    const weightSlots = Math.max(1, Math.round((cycleBase * p.weight) / sumWeight));
    const floorSlots = Math.max(1, Math.ceil(cycleBase * p.minShareFloor));
    const slots = Math.max(weightSlots, floorSlots);
    return {
      tenantId: p.tenantId,
      displayName: p.displayName,
      weightSlots,
      floorSlots,
      slots,
      floorBumped: floorSlots > weightSlots,
      share: 0,
    };
  });

  // 不动点补齐：确保每租户 slots/cycleLen ≥ minShareFloor（单调收敛，封顶防呆）
  const floors = new Map(policies.map((p) => [p.tenantId, p.minShareFloor] as const));
  for (let guard = 0; guard < 1000; guard += 1) {
    const total = plan.reduce((acc, e) => acc + e.slots, 0);
    let changed = false;
    for (const entry of plan) {
      const floor = floors.get(entry.tenantId) ?? 0;
      const need = Math.ceil(floor * total - 1e-9);
      if (entry.slots < need) {
        entry.slots = need;
        entry.floorBumped = true;
        changed = true;
      }
    }
    if (!changed) {
      const finalTotal = plan.reduce((acc, e) => acc + e.slots, 0);
      for (const entry of plan) entry.share = entry.slots / finalTotal;
      return plan;
    }
  }
  throw new Error("保底带宽槽位不动点未收敛（不应到达，请检查配置）");
}

/** 平滑加权轮询：把槽位交错展开成派发周期（经典 Smooth WRR 算法） */
export function buildCycle(plan: readonly CycleSlotPlan[]): string[] {
  const cycleLen = plan.reduce((acc, e) => acc + e.slots, 0);
  const acc = new Map<string, number>(plan.map((e) => [e.tenantId, 0] as const));
  const slotsById = new Map(plan.map((e) => [e.tenantId, e.slots] as const));
  const cycle: string[] = [];
  for (let i = 0; i < cycleLen; i += 1) {
    let best: string | null = null;
    let bestVal = Number.NEGATIVE_INFINITY;
    for (const [tenantId, slots] of slotsById) {
      const value = (acc.get(tenantId) ?? 0) + slots;
      if (value > bestVal) {
        bestVal = value;
        best = tenantId;
      }
    }
    if (best === null) throw new Error("平滑轮询周期构造失败（不应到达）");
    cycle.push(best);
    // 经典 Smooth WRR：本轮比较值 = acc + slots，被选中者的新累计值 = 比较值 - 周期总长。
    // （必须用 bestVal 回写，直接 acc - cycleLen 会把 slots 双重折扣、退化成近似交替。）
    acc.set(best, bestVal - cycleLen);
  }
  return cycle;
}

/** 调度器统一接口：压测引擎面向此接口编程，fair / fifo 可互换 */
export interface Scheduler {
  readonly mode: SchedMode;
  /** 入队，返回该租户当前排队长度（含本请求） */
  enqueue(req: SchedulableRequest): number;
  /** 取下一个待派发请求；无可派发时返回 null */
  pickNext(): SchedulableRequest | null;
  /** 指定租户当前排队长度 */
  depthOf(tenantId: string): number;
  /** 全局排队长度 */
  totalDepth(): number;
  /** 当前存在积压的租户数（≥2 即进入「争抢期」） */
  backlogTenantCount(): number;
}

/** 公平队列调度器：每租户独立 FIFO + 平滑加权轮询派发周期 */
export class FairShareScheduler implements Scheduler {
  readonly mode: SchedMode = "fair";
  private readonly cycle: string[];
  private readonly queues = new Map<string, SchedulableRequest[]>();
  private cursor = 0;

  constructor(policies: readonly TenantQueuePolicy[], cycleBase: number = 20) {
    const plan = computeSlotPlan(policies, cycleBase);
    this.cycle = buildCycle(plan);
    for (const p of policies) this.queues.set(p.tenantId, []);
  }

  enqueue(req: SchedulableRequest): number {
    const q = this.queues.get(req.tenantId);
    if (!q) throw new Error(`未注册的租户：${req.tenantId}`);
    q.push(req);
    return q.length;
  }

  pickNext(): SchedulableRequest | null {
    const len = this.cycle.length;
    for (let i = 0; i < len; i += 1) {
      const idx = (this.cursor + i) % len;
      const tenantId = this.cycle[idx];
      const q = this.queues.get(tenantId);
      if (q && q.length > 0) {
        const req = q.shift();
        if (req) {
          this.cursor = (idx + 1) % len;
          return req;
        }
      }
    }
    return null;
  }

  depthOf(tenantId: string): number {
    return this.queues.get(tenantId)?.length ?? 0;
  }

  totalDepth(): number {
    let total = 0;
    for (const q of this.queues.values()) total += q.length;
    return total;
  }

  backlogTenantCount(): number {
    let count = 0;
    for (const q of this.queues.values()) if (q.length > 0) count += 1;
    return count;
  }

  /** 派发周期快照（页面展示「星辰 18 槽 / 瑞康 4 槽」用的就是它） */
  cyclePattern(): string[] {
    return [...this.cycle];
  }
}

/** 对照组：全局先来先服务（复现洪峰挤占的饿死现场） */
export class FifoScheduler implements Scheduler {
  readonly mode: SchedMode = "fifo";
  private readonly queue: SchedulableRequest[] = [];
  private readonly depthByTenant = new Map<string, number>();

  enqueue(req: SchedulableRequest): number {
    this.queue.push(req);
    this.depthByTenant.set(req.tenantId, (this.depthByTenant.get(req.tenantId) ?? 0) + 1);
    return this.queue.length;
  }

  pickNext(): SchedulableRequest | null {
    const req = this.queue.shift() ?? null;
    if (req) {
      this.depthByTenant.set(req.tenantId, Math.max(0, (this.depthByTenant.get(req.tenantId) ?? 0) - 1));
    }
    return req;
  }

  depthOf(tenantId: string): number {
    return this.depthByTenant.get(tenantId) ?? 0;
  }

  totalDepth(): number {
    return this.queue.length;
  }

  backlogTenantCount(): number {
    let count = 0;
    for (const depth of this.depthByTenant.values()) if (depth > 0) count += 1;
    return count;
  }
}
