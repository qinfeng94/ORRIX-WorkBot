/**
 * react-agent.test.ts —— Day 11 自主调查引擎单元测试（Node 内置 test runner，零第三方依赖）
 * 运行：pnpm test
 * 覆盖：① 只读探针（注册表红线自检 + 三把探针返回值与过滤边界）；
 *      ② maxSteps=8 熔断护栏（注入永不收尾的规划器，验证物理切断且不丢证据）；
 *      ③ 证据链生成（CUST-8842 演练全链路 + FIN-001 拆单合并口径 + 证据不足不编造）。
 * 边界：被测对象 src/lib/ai/react-agent.ts 是确定性纯函数，测试不联网、不读库、不依赖 dev 服务器。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_STEPS,
  PROBE_REGISTRY,
  runInvestigation,
  runReActLoop,
  type InvestigationConclusion,
  type InvestigateSseEvent,
} from "../src/lib/ai/react-agent.ts";

/* ---------------- 测试辅助：跑一轮调查并收集全部 SSE 事件 ---------------- */

interface Collected {
  events: InvestigateSseEvent[];
  conclusion: InvestigationConclusion | null;
  circuitBreakCount: number;
  done: { traceId: string; stepsUsed: number; elapsedMs: number } | null;
}

function collect(
  question: string,
  planner?: Parameters<typeof runReActLoop>[2],
): Collected {
  const events: InvestigateSseEvent[] = [];
  const emit = (e: InvestigateSseEvent): void => {
    events.push(e);
  };
  if (planner) {
    runReActLoop(question, emit, planner);
  } else {
    runInvestigation(question, emit);
  }
  let conclusion: InvestigationConclusion | null = null;
  let circuitBreakCount = 0;
  let done: Collected["done"] = null;
  for (const e of events) {
    if (e.type === "conclusion") conclusion = e.conclusion;
    if (e.type === "circuit_break") circuitBreakCount += 1;
    if (e.type === "done") {
      done = { traceId: e.traceId, stepsUsed: e.stepsUsed, elapsedMs: e.elapsedMs };
    }
  }
  return { events, conclusion, circuitBreakCount, done };
}

/** 事件类型序列（不含 done），供顺序断言用 */
function typeSeq(events: readonly InvestigateSseEvent[]): string[] {
  return events.filter((e) => e.type !== "done").map((e) => e.type);
}

/** 红区禁用词（与引擎注册表自检同一份语义，测试侧独立持有作双保险） */
const RED_ZONE_BANNED_WORDS = ["打款", "付款", "放款", "转账", "payout", "auto_pay"] as const;

/* ================================================================
 * ① 只读探针
 * ================================================================ */

describe("① 只读探针：注册表红线与返回值", () => {
  it("注册表恰好 3 把探针，全部为绿区只读（zone=green）", () => {
    const names = Object.keys(PROBE_REGISTRY);
    assert.deepEqual(names.sort(), ["query_billing_history", "query_tickets", "search_policy"]);
    for (const tool of Object.values(PROBE_REGISTRY)) {
      assert.equal(tool.zone, "green");
    }
  });

  it("注册表无任何红区语义（打款/付款/放款类工具物理不存在）", () => {
    for (const [name, tool] of Object.entries(PROBE_REGISTRY)) {
      const text = `${name} ${tool.label}`.toLowerCase();
      for (const word of RED_ZONE_BANNED_WORDS) {
        assert.ok(
          !text.includes(word.toLowerCase()),
          `探针「${name}」不应命中红区语义「${word}」`,
        );
      }
    }
  });

  it("query_tickets：按 customerId 过滤命中 CUST-8842 两月两条工单", () => {
    const raw = PROBE_REGISTRY.query_tickets.run({ customerId: "CUST-8842" }) as {
      tickets: { ticketId: string; amountCny: number; status: string }[];
    };
    assert.equal(raw.tickets.length, 2);
    assert.deepEqual(
      raw.tickets.map((t) => t.ticketId).sort(),
      ["TCK-2984", "TCK-3117"],
    );
    // 11 月工单涉诉金额 52,800（FIN-001 判定的事实基础）
    const nov = raw.tickets.find((t) => t.ticketId === "TCK-3117");
    assert.equal(nov?.amountCny, 52800);
    assert.equal(nov?.status, "open");
  });

  it("query_tickets：空参返回全量快照，未知客户返回空数组（不编造）", () => {
    const all = PROBE_REGISTRY.query_tickets.run({}) as { tickets: unknown[] };
    assert.equal(all.tickets.length, 6);
    const none = PROBE_REGISTRY.query_tickets.run({ customerId: "CUST-9999" }) as {
      tickets: unknown[];
    };
    assert.equal(none.tickets.length, 0);
  });

  it("query_billing_history：CUST-8842 五笔流水，两笔疑似重复出账", () => {
    const raw = PROBE_REGISTRY.query_billing_history.run({ customerId: "CUST-8842" }) as {
      customerId: string;
      entries: {
        date: string;
        direction: string;
        amountCny: number;
        batchId: string;
        duplicateSuspect: boolean;
      }[];
    };
    assert.equal(raw.customerId, "CUST-8842");
    assert.equal(raw.entries.length, 5);
    const suspects = raw.entries.filter((e) => e.duplicateSuspect);
    assert.equal(suspects.length, 2);
    // 两笔疑似重复：10 月 13,200 + 11 月 26,400（同批次重放）
    assert.ok(suspects.some((e) => e.amountCny === 13200 && e.date.startsWith("2026-10")));
    assert.ok(suspects.some((e) => e.amountCny === 26400 && e.date.startsWith("2026-11")));
    // 11 月重复笔与正常笔同批次（重放路径的事实基础）
    const novBatchIds = new Set(
      raw.entries
        .filter((e) => e.date.startsWith("2026-11") && e.direction === "debit")
        .map((e) => e.batchId),
    );
    assert.equal(novBatchIds.size, 1);
  });

  it("query_billing_history：未知客户与空参均返回空流水（不编造）", () => {
    const none = PROBE_REGISTRY.query_billing_history.run({ customerId: "CUST-9999" }) as {
      entries: unknown[];
    };
    assert.equal(none.entries.length, 0);
    const empty = PROBE_REGISTRY.query_billing_history.run({}) as { entries: unknown[] };
    assert.equal(empty.entries.length, 0);
  });

  it("search_policy：关键词命中现行制度，空参返回全量，生僻词返回空", () => {
    const hit = PROBE_REGISTRY.search_policy.run({ keywords: "重复扣款" }) as {
      hits: { docId: string; section: string }[];
    };
    assert.equal(hit.hits.length, 1);
    assert.equal(hit.hits[0].docId, "DOC-02");
    assert.equal(hit.hits[0].section, "3.1");

    const all = PROBE_REGISTRY.search_policy.run({ keywords: "" }) as {
      hits: { docId: string }[];
    };
    assert.equal(all.hits.length, 5);

    const miss = PROBE_REGISTRY.search_policy.run({ keywords: "恢复旧版10万额度" }) as {
      hits: unknown[];
    };
    assert.equal(miss.hits.length, 0);
  });

  it("search_policy：可检索到现行 FIN-001 条款（含拆单合并口径），且无已废止的 10 万制度", () => {
    const all = PROBE_REGISTRY.search_policy.run({ keywords: "" }) as {
      hits: { docId: string; title: string; snippet: string }[];
    };
    const fin001 = all.hits.find((d) => d.docId === "DOC-01");
    assert.ok(fin001, "现行 FIN-001 条款必须在制度库中");
    assert.ok(fin001.snippet.includes("¥50,000"));
    assert.ok(fin001.snippet.includes("拆单"), "FIN-001 条款应含拆单合并口径");
    for (const d of all.hits) {
      assert.ok(!`${d.title}${d.snippet}`.includes("10 万"), "不得出现已废止的旧版 10 万制度");
    }
  });
});

/* ================================================================
 * ② 熔断护栏（maxSteps = 8）
 * ================================================================ */

describe("② 熔断护栏：maxSteps = 8 物理切断", () => {
  it("熔断上限常量为 8", () => {
    assert.equal(MAX_STEPS, 8);
  });

  it("正常演练 4 步收尾：不触发熔断，步数在上限内", () => {
    const r = collect("深挖 CUST-8842 连续两月异常扣款根因");
    assert.equal(r.circuitBreakCount, 0);
    assert.ok(r.done !== null);
    assert.equal(r.done.stepsUsed, 4);
    assert.ok(r.done.stepsUsed <= MAX_STEPS);
    assert.ok(r.conclusion !== null);
  });

  it("注入永不收尾的规划器：第 9 步被强制切断，事件总数有界（防死循环）", () => {
    // 永远返回行动、永不 finish 的恶意规划器（模拟死循环）
    const infinitePlanner = () => ({
      thought: "继续查（测试注入的死循环规划器）",
      tool: "query_tickets",
      args: { customerId: "" },
    });
    const r = collect("压力测试", infinitePlanner);
    assert.equal(r.circuitBreakCount, 1, "必须触发一次熔断");
    // 每步 thought/action/observation 共 8 步 × 3 + 熔断 1 + 结论 1 + done 1 = 27 个事件，绝不能无限膨胀
    assert.ok(r.events.length <= 100, `事件总数应有界，实际 ${String(r.events.length)}`);
    assert.ok(r.done !== null && r.done.stepsUsed === MAX_STEPS);
  });

  it("熔断不丢证据：切断后仍产出结论（已收集证据照常进入）", () => {
    const infinitePlanner = () => ({
      thought: "继续查（测试注入的死循环规划器）",
      tool: "query_tickets",
      args: { customerId: "CUST-8842" },
    });
    const r = collect("熔断不丢证据", infinitePlanner);
    const cb = r.events.find((e) => e.type === "circuit_break");
    assert.ok(cb && cb.type === "circuit_break");
    assert.equal(cb.maxSteps, MAX_STEPS);
    assert.equal(cb.step, MAX_STEPS + 1, "熔断事件的步数应为上限 +1（第 9 步被拒）");
    assert.ok(cb.message.includes("熔断"));
    assert.ok(r.conclusion !== null, "切断后必须仍有结论");
    assert.ok(
      r.conclusion.evidenceChain.length > 0,
      "切断前收集的证据必须保留进结论",
    );
  });

  it("熔断后循环确实终止（done 是最后一个事件，不再有新推理）", () => {
    const infinitePlanner = () => ({
      thought: "继续查（测试注入的死循环规划器）",
      tool: "query_tickets",
      args: { customerId: "" },
    });
    const r = collect("终止性验证", infinitePlanner);
    const last = r.events[r.events.length - 1];
    assert.equal(last.type, "done");
    const doneIdx = r.events.length - 1;
    assert.ok(
      r.events.slice(0, doneIdx).every((e) => e.type !== "done"),
      "done 只能出现一次且在最后",
    );
  });
});

/* ================================================================
 * ③ 证据链生成
 * ================================================================ */

describe("③ 证据链生成：先证据后结论，强制可溯源", () => {
  it("CUST-8842 演练：事件顺序严格为 thought → action → observation 循环，done 收尾", () => {
    const r = collect("深挖 CUST-8842 连续两月异常扣款根因");
    const seq = typeSeq(r.events);
    // 4 步：前 3 步各三事件，第 4 步只有 thought（收尾），随后 conclusion
    assert.deepEqual(seq, [
      "thought",
      "action",
      "observation",
      "thought",
      "action",
      "observation",
      "thought",
      "action",
      "observation",
      "thought",
      "conclusion",
    ]);
    const last = r.events[r.events.length - 1];
    assert.equal(last.type, "done");
  });

  it("CUST-8842 演练：证据链恰好 3 条且来源顺序为 工单 → 账单 → 制度", () => {
    const r = collect("深挖 CUST-8842 连续两月异常扣款根因");
    const chain = r.conclusion?.evidenceChain ?? [];
    assert.equal(chain.length, 3);
    assert.deepEqual(
      chain.map((e) => e.id),
      ["E1", "E2", "E3"],
    );
    assert.deepEqual(
      chain.map((e) => e.source),
      ["query_tickets", "query_billing_history", "search_policy"],
    );
    // E1 工单发现必须含两月两张工单号
    assert.ok(chain[0].finding.includes("TCK-3117"));
    assert.ok(chain[0].finding.includes("TCK-2984"));
    // E2 账单发现必须含批次重放机制
    assert.ok(chain[1].finding.includes("BATCH-1124"));
    assert.ok(chain[1].finding.includes("重放"));
    // E3 制度发现必须带可溯源的条款出处
    assert.deepEqual(chain[2].docRefs, ["DOC-02 §3.1"]);
  });

  it("CUST-8842 演练：FIN-001 拆单合并口径判定正确（¥52,800 > ¥50,000）", () => {
    const r = collect("深挖 CUST-8842 连续两月异常扣款根因");
    const c = r.conclusion;
    assert.ok(c !== null);
    assert.equal(c.fin001Triggered, true, "11 月同批次两笔各 26,400 合并 52,800 必须触发 FIN-001");
    assert.ok(
      c.body.includes("¥52,800 > ¥50,000"),
      "结论正文必须使用正确的合并口径金额（而非两月累计 39,600）",
    );
    assert.ok(c.body.includes("疑似拆单"));
    assert.ok(c.body.includes("AI 不审批、不打款"), "结论必须重申红区纪律");
    assert.ok(c.body.includes("[DOC-01 §4.2]"));
    assert.ok(c.headline.includes("幂等"), "根因必须落在幂等键缺失上");
    assert.ok(c.rootCause.includes("同批次"));
    assert.equal(c.stepsUsed, 4);
    assert.equal(c.maxSteps, MAX_STEPS);
  });

  it("CUST-8842 演练：下一步建议全部归人且无任何 AI 打款承诺", () => {
    const r = collect("深挖 CUST-8842 连续两月异常扣款根因");
    const actions = r.conclusion?.nextActions ?? [];
    assert.ok(actions.length > 0);
    for (const a of actions) {
      assert.ok(!a.includes("AI 自动打款"), "严禁出现 AI 打款承诺");
      assert.ok(!a.includes("自动付款"));
      assert.ok(!a.includes("秒到账"));
    }
    // 退款建议必须挂在人工审批语境下
    assert.ok(
      actions.some((a) => a.includes("具名财务审批人") || a.includes("人工审批")),
      "退款建议必须要求具名审批人",
    );
  });

  it("未知客户（CUST-9999）：证据不足时如实报告，不编造、证据链为空", () => {
    const r = collect("调查 CUST-9999 的异常情况");
    const c = r.conclusion;
    assert.ok(c !== null);
    assert.ok(c.headline.includes("证据不足"));
    assert.equal(c.evidenceChain.length, 0, "没有证据就不能虚构证据链");
    assert.equal(c.fin001Triggered, false);
    assert.ok(c.body.includes("不编造"));
    assert.ok(c.body.includes("CUST-9999"), "正文应如实引用调查对象");
    assert.ok(c.nextActions.length > 0, "即使证据不足也要给出人工核实路径");
    assert.ok(r.done !== null && r.done.stepsUsed === 3, "工单 + 账单两步探查后即收尾");
  });

  it("证据链编号连续：每条证据 id 唯一且按 E1、E2… 递增", () => {
    const r = collect("深挖 CUST-8842 连续两月异常扣款根因");
    const chain = r.conclusion?.evidenceChain ?? [];
    chain.forEach((e, i) => {
      assert.equal(e.id, `E${String(i + 1)}`);
      assert.ok(e.query.length > 0, "每条证据必须记录查询入参，保证可复现");
      assert.ok(e.finding.length > 0, "每条证据必须有具体发现");
    });
  });
});
