/**
 * analytics.test.ts —— Day 39 五重死锁只读 SQL 分析代理单元测试（Node 内置 test runner）
 * 运行：pnpm test
 * 覆盖：① 五重校验器：5 类攻击样本逐层拦截（非 SELECT / 分号串写 / 缺租户隔离 / 巨型 LIMIT / 危险函数）；
 *      ② 第④重钳制与追加：LIMIT 999999 → 钳制 100、无 LIMIT → 追加、子查询多 LIMIT → 拦截；
 *      ③ 词法剥离：字符串/注释藏毒视为数据放行、未闭合引号 fail-closed、FOR UPDATE / WITH 拦截；
 *      ④ 表白名单：越权触达非白名单表直接拒绝；
 *      ⑤ 规划器路由：3 个老板预设问题命中正确模板、无关问题诚实拒答、时间口径与 forceMode；
 *      ⑥ ROI 账单公式确定性：固定输入 → 精确输出（人工省 − 机器费 = 净收益）。
 * 边界：全部为确定性纯函数测试，不连数据库、不跑 LLM。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildRoiBill, fmtCny, planFromQuestion } from "../src/lib/analytics/planner.ts";
import { scrubLexical, validateSecureSql } from "../src/lib/analytics/secure-sql.ts";

const SCOPED_CTX = { tenantId: "xingchen", scoped: true } as const;
const PLAIN_CTX = { tenantId: "xingchen", scoped: false } as const;

describe("Day 39 五重死锁校验器", () => {
  it("攻击① 非 SELECT 开头（DROP 写动词裸奔）→ 第①重拦截", () => {
    const v = validateSecureSql("DROP TABLE intake_requests", PLAIN_CTX);
    assert.equal(v.ok, false);
    assert.equal(v.blockedLayer, 1);
  });

  it("攻击② 分号串接 DELETE → 第②重拦截（死锁即止）", () => {
    const v = validateSecureSql(
      "SELECT ticket_no FROM intake_requests; DELETE FROM intake_requests WHERE ticket_no = 'T-2026-1101'",
      SCOPED_CTX,
    );
    assert.equal(v.ok, false);
    assert.equal(v.blockedLayer, 2);
    // 第②重拦截后，后续层应标注「未进入」而不是放行
    const later = v.audits.filter((a) => a.layer > 2);
    assert.ok(later.every((a) => a.detail.includes("未进入")));
  });

  it("攻击③ 触碰租户表但缺 tenant_id → 第③重 fail-closed", () => {
    const v = validateSecureSql(
      "SELECT ticket_no, amount FROM intake_requests WHERE amount > 50000",
      SCOPED_CTX,
    );
    assert.equal(v.ok, false);
    assert.equal(v.blockedLayer, 3);
  });

  it("攻击④ LIMIT 999999 → 第④重钳制为 100", () => {
    const v = validateSecureSql(
      "SELECT department, SUM(amount) AS total FROM intake_requests WHERE tenant_id = $1 GROUP BY department LIMIT 999999",
      SCOPED_CTX,
    );
    assert.equal(v.ok, true);
    assert.equal(v.blockedLayer, null);
    assert.match(v.finalSql, /LIMIT 100$/);
    assert.ok(v.audits.some((a) => a.verdict === "clamped" && a.layer === 4));
  });

  it("攻击⑤ pg_sleep 危险函数 → 第①重拦截", () => {
    const v = validateSecureSql("SELECT pg_sleep(10)", PLAIN_CTX);
    assert.equal(v.ok, false);
    assert.equal(v.blockedLayer, 1);
  });

  it("合法模板 SQL → 五层全过", () => {
    const v = validateSecureSql(
      "SELECT department, COUNT(*) AS ticket_count FROM intake_requests WHERE tenant_id = $1 AND amount > $2 GROUP BY department",
      SCOPED_CTX,
    );
    assert.equal(v.ok, true);
    assert.equal(v.audits.length, 5);
    assert.ok(v.audits.every((a) => a.verdict !== "blocked"));
  });
});

describe("Day 39 第④重 LIMIT 细则", () => {
  it("无 LIMIT → 自动追加 LIMIT 100", () => {
    const v = validateSecureSql("SELECT provider_id FROM llm_usage_logs", PLAIN_CTX);
    assert.equal(v.ok, true);
    assert.equal(v.finalSql, "SELECT provider_id FROM llm_usage_logs LIMIT 100");
  });

  it("LIMIT 50（≤100）→ 原样放行", () => {
    const v = validateSecureSql("SELECT provider_id FROM llm_usage_logs LIMIT 50", PLAIN_CTX);
    assert.equal(v.ok, true);
    assert.match(v.finalSql, /LIMIT 50$/);
  });

  it("子查询多段 LIMIT → 第④重拦截", () => {
    const v = validateSecureSql(
      "SELECT * FROM (SELECT provider_id FROM llm_usage_logs LIMIT 90) t LIMIT 90",
      PLAIN_CTX,
    );
    assert.equal(v.ok, false);
    assert.equal(v.blockedLayer, 4);
  });
});

describe("Day 39 词法剥离（scrubLexical）", () => {
  it("字符串字面量里的写动词被剥离（是数据不是代码）", () => {
    const { scrubbed } = scrubLexical("SELECT note FROM agent_traces WHERE note = 'DELETE FROM x'");
    assert.doesNotMatch(scrubbed, /\bDELETE\b/);
    assert.doesNotMatch(scrubbed, /;/);
  });

  it("注释里的写动词被剥离", () => {
    const { scrubbed } = scrubLexical("SELECT 1 /* DROP TABLE */ FROM agent_traces");
    assert.doesNotMatch(scrubbed, /\bDROP\b/);
  });

  it("未闭合引号 → malformed（fail-closed）", () => {
    const { malformed } = scrubLexical("SELECT '未闭合 FROM intake_requests");
    assert.equal(malformed, true);
    const v = validateSecureSql("SELECT '未闭合 FROM intake_requests", PLAIN_CTX);
    assert.equal(v.ok, false);
    assert.equal(v.blockedLayer, 1);
  });

  it("FOR UPDATE 行锁写意图 → 第②重拦截", () => {
    const v = validateSecureSql("SELECT ticket_no FROM intake_requests WHERE tenant_id = $1 FOR UPDATE", SCOPED_CTX);
    assert.equal(v.ok, false);
    assert.equal(v.blockedLayer, 2);
  });

  it("WITH CTE（写动词黑名单词）→ 第①重拦截", () => {
    const v = validateSecureSql("WITH t AS (SELECT 1) SELECT * FROM t", PLAIN_CTX);
    assert.equal(v.ok, false);
    assert.equal(v.blockedLayer, 1);
  });

  it("越权触达非白名单表 → 第①重拦截", () => {
    const v = validateSecureSql("SELECT * FROM users", PLAIN_CTX);
    assert.equal(v.ok, false);
    assert.equal(v.blockedLayer, 1);
  });

  it("系统目录 information_schema 不可见 → 第①重拦截", () => {
    const v = validateSecureSql("SELECT table_name FROM information_schema.tables", PLAIN_CTX);
    assert.equal(v.ok, false);
    assert.equal(v.blockedLayer, 1);
  });
});

describe("Day 39 确定性规划器", () => {
  it("预设① ROI 提问 → roi_bill 模板（3 条 SQL 步骤）", () => {
    const plan = planFromQuestion("对比 Day 2 预估 ROI 与本月真实省了多少钱？");
    assert.ok(plan);
    assert.equal(plan.templateId, "roi_bill");
    assert.equal(plan.mode, "month");
    assert.equal(plan.steps.length, 3);
    // 三条 SQL 全部触碰白名单表且占位符参数化
    assert.ok(plan.steps.every((s) => /\$\d+/.test(s.sql) || s.params.length === 0));
  });

  it("预设② 部门超 5 万提问 → dept_fin001 模板（含租户隔离条件）", () => {
    const plan = planFromQuestion("统计各部门超 5 万拦截总金额");
    assert.ok(plan);
    assert.equal(plan.templateId, "dept_fin001");
    assert.ok(plan.steps[0].scoped);
    assert.match(plan.steps[0].sql, /tenant_id = \$1/);
    // 金额阈值参数与 fin001 真源一致（50000）
    assert.equal(plan.steps[0].params[1], 50000);
  });

  it("预设③ 返工原因提问 → rework_reason 模板", () => {
    const plan = planFromQuestion("列出本月返工率最高的原因");
    assert.ok(plan);
    assert.equal(plan.templateId, "rework_reason");
    assert.match(plan.steps[0].sql, /ORDER BY rework_rate DESC/);
  });

  it("无关问题 → null（诚实拒答，不硬凑 SQL）", () => {
    assert.equal(planFromQuestion("帮我给供应商转一笔货款"), null);
    assert.equal(planFromQuestion("今天天气怎么样"), null);
  });

  it("「全部/累计」措辞 → all 口径；forceMode 可强制覆盖", () => {
    const all = planFromQuestion("累计省了多少钱？");
    assert.ok(all);
    assert.equal(all.mode, "all");
    const forced = planFromQuestion("累计省了多少钱？", "month");
    assert.ok(forced);
    assert.equal(forced.mode, "month");
  });

  it("规划产出的每条 SQL 都能过五重校验器（模板白名单自洽）", () => {
    for (const q of ["对比 Day 2 预估 ROI 与本月真实省了多少钱？", "统计各部门超 5 万拦截总金额", "列出本月返工率最高的原因"]) {
      const plan = planFromQuestion(q, "month");
      assert.ok(plan, q);
      for (const step of plan.steps) {
        const v = validateSecureSql(step.sql, { tenantId: "xingchen", scoped: step.scoped });
        assert.equal(v.ok, true, `${q} → ${step.sql}`);
      }
    }
  });
});

describe("Day 39 ROI 账单公式（确定性）", () => {
  const measured = {
    ticketCount: 100,
    fin001Count: 3,
    fin001Amount: 180000,
    reworkTotal: 2,
    avgTriageSavings: 50,
    llmCalls: 10,
    llmCostUsd: 1,
  };

  it("固定输入 → 精确输出：净收益 = 人工省 − 机器费", () => {
    const bill = buildRoiBill(measured, "month");
    // hoursSaved = 100 × (12−3)/60 = 15h；laborSaving = 15 × 75 = 1125；llmCost = 1 × 7.2 = 7.2
    assert.equal(bill.laborSavingCny, 1125);
    assert.equal(bill.llmCostCny, 7.2);
    assert.equal(bill.netGainCny, 1117.8);
    assert.equal(bill.interceptCny, 180000);
    // 账单 6 行 + 风险敞口单列不计入收益
    assert.equal(bill.rows.length, 6);
    assert.match(bill.rows[3].day39, /风险规避敞口/);
  });

  it("口径标签随 mode 切换", () => {
    const bill = buildRoiBill(measured, "all");
    assert.match(bill.rows[0].item, /全部累计/);
    assert.match(bill.disclaimer, /全部累计/);
  });

  it("fmtCny 千分位与两位小数", () => {
    assert.equal(fmtCny(1117.8), "¥1,117.8");
    assert.equal(fmtCny(279200), "¥279,200");
  });
});
