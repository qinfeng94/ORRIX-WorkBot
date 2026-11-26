/**
 * queue-lab.test.ts —— Day 33 多租户公平队列单元测试（Node 内置 test runner，零第三方依赖）
 * 运行：pnpm test（与既有测试同链路）
 * 覆盖：令牌桶假时钟边界（不透支 / 容量封顶 / 构造 fail-closed）、
 *      周期槽位规划的保底不动点与 fail-closed、平滑加权轮询交错性、
 *      公平调度器争抢期份额与闲置借槽、FIFO 对照组饿死现场复现、
 *      百分位边界，以及小规模对照压测端到端（0 失败 + 保底兑现 + 公平优于 FIFO）。
 * 边界：被测对象是确定性纯逻辑；端到端用小剧本（ledger 关闭），测试不写台账、不联网。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TokenBucket } from "../src/lib/queue/token-bucket.ts";
import {
  FairShareScheduler,
  FifoScheduler,
  buildCycle,
  computeSlotPlan,
} from "../src/lib/queue/fair-scheduler.ts";
import {
  DAY33_PLAN,
  beginQueueLabRun,
  getQueueLabRun,
  percentileOf,
  QueueLabConflictError,
  runQueueStress,
} from "../src/lib/queue/load-test.ts";
import type { QueueLabEvent, TenantQueuePolicy } from "../src/lib/queue/types.ts";

/** 与 DAY33_PLAN 一致的租户策略（星辰 9 : 瑞康 1，保底 5% / 15%） */
const DAY33_POLICIES: TenantQueuePolicy[] = DAY33_PLAN.tenants;

function req(tenantId: string, seq: number) {
  return { reqId: `${tenantId}-${seq}`, tenantId, arriveAt: 0 };
}

describe("① 令牌桶（假时钟，削峰不拒单）", () => {
  it("初始满桶，取走后余量精确扣减", () => {
    let clock = 0;
    const bucket = new TokenBucket(10, 5, () => clock);
    assert.equal(bucket.peek(), 10);
    assert.equal(bucket.tryTake(3), true);
    assert.equal(bucket.peek(), 7);
  });

  it("令牌不足时拒绝取走，且绝不透支为负数", () => {
    let clock = 0;
    const bucket = new TokenBucket(10, 5, () => clock);
    assert.equal(bucket.tryTake(3), true);
    assert.equal(bucket.tryTake(8), false);
    assert.equal(bucket.peek(), 7);
    assert.ok(bucket.peek() >= 0);
  });

  it("时间流逝按速率补令牌，且容量封顶不超发", () => {
    let clock = 0;
    const bucket = new TokenBucket(10, 5, () => clock);
    bucket.tryTake(3);
    clock = 2000; // 2 秒 × 5/s = +10 → 7+10=17 封顶回 10
    assert.equal(bucket.peek(), 10);
  });

  it("半速率补令牌：够 2 不够 3（浮点边界）", () => {
    let clock = 0;
    const bucket = new TokenBucket(10, 5, () => clock);
    for (let i = 0; i < 10; i += 1) bucket.tryTake(1);
    clock = 500; // +2.5 个
    assert.equal(bucket.tryTake(3), false);
    assert.equal(bucket.tryTake(2), true);
  });

  it("时钟不走就不补令牌（无时间流逝零增量）", () => {
    let clock = 0;
    const bucket = new TokenBucket(10, 5, () => clock);
    for (let i = 0; i < 10; i += 1) bucket.tryTake(1);
    assert.equal(bucket.tryTake(1), false);
    assert.equal(bucket.peek(), 0);
  });

  it("构造参数 fail-closed：容量与速率必须 > 0", () => {
    assert.throws(() => new TokenBucket(0, 5, () => 0));
    assert.throws(() => new TokenBucket(10, 0, () => 0));
  });
});

describe("② 周期槽位规划（保底不动点 + fail-closed）", () => {
  it("Day 33 配置：星辰 18 槽 / 瑞康 4 槽，保底把瑞康从权重 2 槽顶到 4 槽", () => {
    const plan = computeSlotPlan(DAY33_POLICIES, 20);
    assert.equal(plan.length, 2);
    const xc = plan.find((p) => p.tenantId === "xingchen");
    const rk = plan.find((p) => p.tenantId === "ruikang");
    assert.ok(xc && rk);
    assert.equal(xc.weightSlots, 18);
    assert.equal(xc.slots, 18);
    assert.equal(rk.weightSlots, 2);
    assert.equal(rk.floorSlots, 3);
    assert.equal(rk.slots, 4); // 不动点补齐：ceil(0.15 × 22) = 4
    assert.equal(rk.floorBumped, true);
    assert.equal(xc.floorBumped, false);
    const total = plan.reduce((acc, p) => acc + p.slots, 0);
    assert.equal(total, 22);
    assert.ok(Math.abs(rk.share - 4 / 22) < 1e-9);
    assert.ok(rk.share >= 0.15 - 1e-9, "瑞康保底 15% 必须兑现");
  });

  it("每租户每周期至少 1 槽（结构性零饿死下界）", () => {
    const plan = computeSlotPlan(DAY33_POLICIES, 20);
    for (const entry of plan) assert.ok(entry.slots >= 1);
  });

  it("fail-closed：空策略 / 周期过短 / 保底超和 / 非法权重与保底全部拒启动", () => {
    assert.throws(() => computeSlotPlan([], 20));
    assert.throws(() => computeSlotPlan(DAY33_POLICIES, 1)); // 周期 < 租户数
    assert.throws(() =>
      computeSlotPlan(
        [
          { ...DAY33_POLICIES[0], minShareFloor: 0.6 },
          { ...DAY33_POLICIES[1], minShareFloor: 0.6 },
        ],
        20,
      ),
    );
    assert.throws(() => computeSlotPlan([{ ...DAY33_POLICIES[0], weight: 0 }], 4));
    assert.throws(() => computeSlotPlan([{ ...DAY33_POLICIES[0], minShareFloor: 0 }], 4));
    assert.throws(() => computeSlotPlan([{ ...DAY33_POLICIES[0], minShareFloor: 1.5 }], 4));
  });

  it("单租户场景：保底不高于权重时直接取权重槽", () => {
    const plan = computeSlotPlan(
      [{ ...DAY33_POLICIES[0], minShareFloor: 0.5 }],
      4,
    );
    assert.equal(plan.length, 1);
    assert.equal(plan[0].slots, 4);
    assert.equal(plan[0].share, 1);
    assert.equal(plan[0].floorBumped, false);
  });
});

describe("③ 平滑加权轮询周期交错", () => {
  it("周期长度与槽位数严格一致，且前后半周期各至少轮到瑞康一次（不整周期垫底）", () => {
    const plan = computeSlotPlan(DAY33_POLICIES, 20);
    const cycle = buildCycle(plan);
    assert.equal(cycle.length, 22);
    const countRk = cycle.filter((t) => t === "ruikang").length;
    const countXc = cycle.filter((t) => t === "xingchen").length;
    assert.equal(countRk, 4);
    assert.equal(countXc, 18);
    const firstHalf = cycle.slice(0, 11);
    const secondHalf = cycle.slice(11);
    assert.ok(firstHalf.includes("ruikang"), "前半周期必须轮到瑞康");
    assert.ok(secondHalf.includes("ruikang"), "后半周期必须轮到瑞康");
  });
});

describe("④ 公平调度器：争抢期份额 / 闲置借槽 / FIFO 饿死对照", () => {
  it("两租户同时积压（争抢期）：连续取满一个周期，瑞康恰好分到保底 4 槽", () => {
    const sched = new FairShareScheduler(DAY33_POLICIES, 20);
    for (let i = 0; i < 50; i += 1) sched.enqueue(req("xingchen", i));
    for (let i = 0; i < 10; i += 1) sched.enqueue(req("ruikang", i));
    assert.equal(sched.backlogTenantCount(), 2);
    let rk = 0;
    let xc = 0;
    for (let i = 0; i < 22; i += 1) {
      const picked = sched.pickNext();
      assert.ok(picked);
      if (picked.tenantId === "ruikang") rk += 1;
      else xc += 1;
    }
    assert.equal(rk, 4, "争抢期瑞康每周期必须恰好拿到保底 4 槽");
    assert.equal(xc, 18);
    assert.equal(sched.depthOf("ruikang"), 6);
    assert.equal(sched.totalDepth(), 60 - 22);
  });

  it("小租户闲置时份额被大租户借走（work-conserving，不欠新账）", () => {
    const sched = new FairShareScheduler(DAY33_POLICIES, 20);
    for (let i = 0; i < 50; i += 1) sched.enqueue(req("xingchen", i));
    assert.equal(sched.backlogTenantCount(), 1);
    for (let i = 0; i < 22; i += 1) {
      const picked = sched.pickNext();
      assert.ok(picked);
      assert.equal(picked.tenantId, "xingchen", "瑞康队列空，星辰应借走全部闲置份额");
    }
  });

  it("FIFO 对照组复现饿死现场：瑞康排在 100 笔洪峰之后，前 50 取全是星辰", () => {
    const sched = new FifoScheduler();
    for (let i = 0; i < 100; i += 1) sched.enqueue(req("xingchen", i));
    for (let i = 0; i < 5; i += 1) sched.enqueue(req("ruikang", i));
    assert.equal(sched.backlogTenantCount(), 2);
    for (let i = 0; i < 50; i += 1) {
      const picked = sched.pickNext();
      assert.ok(picked);
      assert.equal(picked.tenantId, "xingchen", `第 ${i + 1} 取仍被洪峰霸占，小租户饿死`);
    }
    assert.equal(sched.depthOf("ruikang"), 5);
  });
});

describe("⑤ 百分位边界（最近邻秩）", () => {
  it("空集返回 0，不抛错", () => {
    assert.equal(percentileOf([], 95), 0);
  });

  it("单元素：任意分位都等于该元素", () => {
    assert.equal(percentileOf([42], 50), 42);
    assert.equal(percentileOf([42], 95), 42);
    assert.equal(percentileOf([42], 99), 42);
  });

  it("1..100：P50=50，P95=95，P99=99", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(percentileOf(values, 50), 50);
    assert.equal(percentileOf(values, 95), 95);
    assert.equal(percentileOf(values, 99), 99);
  });

  it("乱序输入自动排序；P0 夹取到最小值", () => {
    assert.equal(percentileOf([10, 1, 5, 3], 50), 3);
    assert.equal(percentileOf([7, 2, 9], 0), 2);
  });
});

describe("⑥ 小规模对照压测端到端（0 失败 + 保底兑现 + 公平优于 FIFO）", () => {
  /**
   * 小剧本：星辰 80 笔 50ms 突发 vs 瑞康 20 笔 1.2s 常态。
   * 星辰桶容量取 80（= 笔数）：洪峰全部真进调度队列、复现 FIFO 排长队饿死现场；
   * （桶过小会把洪峰削在准入层，调度队列过浅 → 两引擎瑞康排队无差别，maxWait 失去区分度）
   */
  const smallPlan = {
    poolCapacity: 2,
    serviceMinMs: 12,
    serviceMaxMs: 18,
    tickEveryMs: 20,
    snapshotEveryMs: 100,
    hardCapMs: 30_000,
    cycleBase: 20,
    seed: 20331126,
    tenants: [
      {
        tenantId: "xingchen",
        displayName: "星辰（小剧本）",
        weight: 9,
        minShareFloor: 0.05,
        bucketCapacity: 80,
        refillPerSec: 100,
      },
      {
        tenantId: "ruikang",
        displayName: "瑞康（小剧本）",
        weight: 1,
        minShareFloor: 0.15,
        bucketCapacity: 10,
        refillPerSec: 20,
      },
    ],
    arrivals: [
      { tenantId: "xingchen", count: 80, startMs: 0, windowMs: 50 },
      { tenantId: "ruikang", count: 20, startMs: 0, windowMs: 1200 },
    ],
  };

  it("runQueueStress：两引擎全部跑完 100 笔、零失败，公平组瑞康显著优于 FIFO", async () => {
    const events: QueueLabEvent[] = [];
    const report = await runQueueStress({ plan: smallPlan, ledger: false, onEvent: (e) => events.push(e) });

    assert.equal(report.failureRatePct, 0);
    const fairRk = report.fair.tenants.find((t) => t.tenantId === "ruikang");
    const fairXc = report.fair.tenants.find((t) => t.tenantId === "xingchen");
    const fifoRk = report.fifo.tenants.find((t) => t.tenantId === "ruikang");
    const fifoXc = report.fifo.tenants.find((t) => t.tenantId === "xingchen");
    assert.ok(fairRk && fairXc && fifoRk && fifoXc);
    assert.equal(fairXc.done, 80);
    assert.equal(fairXc.failed, 0);
    assert.equal(fairRk.done, 20);
    assert.equal(fairRk.failed, 0);
    assert.equal(fifoXc.done, 80);
    assert.equal(fifoRk.done, 20);
    assert.equal(fifoRk.failed, 0);

    assert.ok(
      fairRk.p95Ms < fifoRk.p95Ms,
      `公平组瑞康 P95 ${fairRk.p95Ms}ms 应严格小于 FIFO ${fifoRk.p95Ms}ms`,
    );
    assert.ok(fairRk.maxWaitMs < fifoRk.maxWaitMs);
    assert.ok(
      fairRk.contendedDispatches > 0 && fairRk.contendedShare >= 0.15 - 1e-6,
      `争抢期瑞康份额 ${(fairRk.contendedShare * 100).toFixed(1)}% 必须兑现保底 15%`,
    );
    assert.ok(report.comparison.ruikangP95FairMs < report.comparison.ruikangP95FifoMs);
    assert.ok(report.comparison.improvementX > 1);
    assert.equal(report.allPass, true, report.checks.filter((c) => !c.ok).map((c) => c.name).join("、"));

    // 事件契约：run_started → snapshot×N → report → done
    const types = events.map((e) => e.type);
    assert.equal(types[0], "run_started");
    assert.ok(types.includes("snapshot"));
    assert.ok(types.includes("report"));
    assert.ok(types.includes("done"));
    assert.ok(!types.includes("error"));
    const firstSnapshot = events.find((e): e is Extract<QueueLabEvent, { type: "snapshot" }> => e.type === "snapshot");
    assert.ok(firstSnapshot);
    assert.ok(firstSnapshot.fair.tenants.length === 2);
    assert.ok(firstSnapshot.fifo.queueDepth >= 0);
  });

  it("beginQueueLabRun：运行中重复启动抛冲突，跑完后单例状态可恢复", async () => {
    const { state, promise } = beginQueueLabRun({ plan: smallPlan, ledger: false });
    assert.throws(() => beginQueueLabRun({ plan: smallPlan, ledger: false }), QueueLabConflictError);
    const report = await promise;
    assert.equal(state.status, "done");
    assert.equal(state.report?.failureRatePct ?? 1, 0);
    assert.ok(state.samples.fair.length > 0);
    assert.equal(getQueueLabRun()?.runId, state.runId);
    assert.equal(report.fair.tenants.reduce((acc, t) => acc + t.done, 0), 100);
  });
});
