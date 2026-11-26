/**
 * Day 29 规则 DSL 引擎测试（20 题，零第三方依赖，Node 内置 test runner）
 * 覆盖：安全比较 / 逻辑与或 / 区间 / 清单 / fail-closed 校验 / 原型链封死 /
 *      FIN-001 严格大于口径 / 瑞康冷链超温与患者隐私端到端。
 * 运行：pnpm test:dsl（node --experimental-strip-types + register-hooks 别名钩子）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  describeRuleDsl,
  DSL_MAX_DEPTH,
  evaluateRuleDsl,
  validateRuleDsl,
  type RuleDsl,
} from "@/lib/workbot/rule-dsl";

/** 便捷封装：校验 + 求值一步到位（测试外层统一走 fail-closed 入口） */
function run(raw: unknown, facts: Record<string, unknown>): ReturnType<typeof evaluateRuleDsl> {
  return evaluateRuleDsl(validateRuleDsl(raw), facts);
}

/** 断言抛错（fail-closed 必须抛，绝不静默兜底） */
function assertThrows(fn: () => unknown, keyword: string): void {
  assert.throws(fn, (err: unknown) => {
    return err instanceof Error && err.message.includes(keyword);
  });
}

/* ================================================================
 * 一、安全比较（FIN-001 口径）
 * ================================================================ */

test("T01 · 严格超过才触发：5 万等于不触发、5 万零 1 分触发（FIN-001 口径）", () => {
  const fin001: RuleDsl = {
    kind: "all",
    conditions: [
      { kind: "compare", field: "department", op: "eq", value: "财务部" },
      { kind: "compare", field: "amount", op: "gt", value: 50000 },
    ],
  };
  const atThreshold = run(fin001, { department: "财务部", amount: 50000 });
  assert.equal(atThreshold.matched, false, "「等于 50,000」绝不触发");

  const overThreshold = run(fin001, { department: "财务部", amount: 50000.01 });
  assert.equal(overThreshold.matched, true, "超过 50,000 触发");

  const otherDept = run(fin001, { department: "客服部", amount: 99800 });
  assert.equal(otherDept.matched, false, "非财务部同金额不触发");
});

test("T02 · gte/lte/lt 三方向边界值精确判定", () => {
  const gte = run({ kind: "compare", field: "n", op: "gte", value: 10 }, { n: 10 });
  assert.equal(gte.matched, true, "gte 含等号");
  const lt = run({ kind: "compare", field: "n", op: "lt", value: 10 }, { n: 9.99 });
  assert.equal(lt.matched, true);
  const lteAtBoundary = run({ kind: "compare", field: "n", op: "lte", value: 10 }, { n: 10 });
  assert.equal(lteAtBoundary.matched, true);
  const ltAtBoundary = run({ kind: "compare", field: "n", op: "lt", value: 10 }, { n: 10 });
  assert.equal(ltAtBoundary.matched, false, "lt 不含等号");
});

test("T03 · eq/ne 覆盖数值、字符串、布尔三型", () => {
  assert.equal(run({ kind: "compare", field: "a", op: "eq", value: 3 }, { a: 3 }).matched, true);
  assert.equal(run({ kind: "compare", field: "a", op: "ne", value: 3 }, { a: 4 }).matched, true);
  assert.equal(run({ kind: "compare", field: "s", op: "eq", value: "III类" }, { s: "III类" }).matched, true);
  assert.equal(run({ kind: "compare", field: "s", op: "ne", value: "II类" }, { s: "III类" }).matched, true);
  assert.equal(run({ kind: "compare", field: "b", op: "eq", value: true }, { b: true }).matched, true);
  assert.equal(run({ kind: "compare", field: "b", op: "ne", value: false }, { b: true }).matched, true);
});

test("T04 · 数值比较遇到字符串事实 fail-closed 判 false（绝不字典序比较）", () => {
  // "10" 若被误转数字或走字典序，"10" < "9" 这类荒谬结论就会发生——必须直接 false
  const result = run({ kind: "compare", field: "amount", op: "gt", value: 5000 }, { amount: "100000" });
  assert.equal(result.matched, false, "字符串事实不做数值比较");
  assert.equal(result.leaves.length, 1);
  assert.equal(result.leaves[0].matched, false);
});

/* ================================================================
 * 二、区间判断
 * ================================================================ */

test("T05 · 双闭区间：两端边界值都命中", () => {
  const rule: RuleDsl = { kind: "between", field: "amount", min: 1000, max: 5000, minInclusive: true, maxInclusive: true };
  assert.equal(run(rule, { amount: 1000 }).matched, true);
  assert.equal(run(rule, { amount: 5000 }).matched, true);
  assert.equal(run(rule, { amount: 999.99 }).matched, false);
  assert.equal(run(rule, { amount: 5000.01 }).matched, false);
});

test("T06 · 双开区间：边界值不命中、半开区间单边命中", () => {
  const open: RuleDsl = { kind: "between", field: "temp", min: -8, max: 8, minInclusive: false, maxInclusive: false };
  assert.equal(run(open, { temp: -8 }).matched, false);
  assert.equal(run(open, { temp: 8 }).matched, false);
  assert.equal(run(open, { temp: 0 }).matched, true);

  const halfOpen: RuleDsl = { kind: "between", field: "temp", min: 2, max: 10, minInclusive: true, maxInclusive: false };
  assert.equal(run(halfOpen, { temp: 2 }).matched, true);
  assert.equal(run(halfOpen, { temp: 10 }).matched, false);
});

test("T07 · 区间 min > max 在校验阶段抛错拒绝（fail-closed）", () => {
  assertThrows(
    () => validateRuleDsl({ kind: "between", field: "amount", min: 5000, max: 1000 }),
    "min 不能大于 max",
  );
});

/* ================================================================
 * 三、清单判断
 * ================================================================ */

test("T08 · in 清单命中：三类器械多口径写法全部识别", () => {
  const rule: RuleDsl = { kind: "in", field: "deviceClass", values: ["III", "III类", "Class III"] };
  for (const cls of ["III", "III类", "Class III"]) {
    assert.equal(run(rule, { deviceClass: cls }).matched, true, `${cls} 应命中`);
  }
  assert.equal(run(rule, { deviceClass: "II类" }).matched, false, "II 类不命中");
});

test("T09 · not_in 语义：不在授权部门清单即判真", () => {
  const rule: RuleDsl = { kind: "not_in", field: "department", values: ["合规部", "质控部"] };
  assert.equal(run(rule, { department: "客服部" }).matched, true, "清单外 → true");
  assert.equal(run(rule, { department: "质控部" }).matched, false, "清单内 → false");
  // 事实缺失时 not_in 不得「反向判真」——fail-closed 仍是 false
  const missing = run(rule, {});
  assert.equal(missing.matched, false, "事实缺失绝不判真");
});

/* ================================================================
 * 四、逻辑与 / 或
 * ================================================================ */

test("T10 · all 全真才真：一假即假且轨迹完整", () => {
  const rule: RuleDsl = {
    kind: "all",
    conditions: [
      { kind: "compare", field: "department", op: "eq", value: "财务部" },
      { kind: "compare", field: "amount", op: "gt", value: 50000 },
    ],
  };
  const allTrue = run(rule, { department: "财务部", amount: 52000 });
  assert.equal(allTrue.matched, true);
  assert.equal(allTrue.leaves.length, 2);

  const oneFalse = run(rule, { department: "客服部", amount: 52000 });
  assert.equal(oneFalse.matched, false);
  assert.equal(oneFalse.leaves.length, 2, "即使一假，全部叶子轨迹仍要收集供解释");
});

test("T11 · any 一真即真：全假才假", () => {
  const rule: RuleDsl = {
    kind: "any",
    conditions: [
      { kind: "compare", field: "a", op: "eq", value: 1 },
      { kind: "compare", field: "b", op: "eq", value: 2 },
    ],
  };
  assert.equal(run(rule, { a: 1, b: 999 }).matched, true);
  assert.equal(run(rule, { a: 999, b: 2 }).matched, true);
  assert.equal(run(rule, { a: 999, b: 999 }).matched, false);
});

test("T12 · 三层嵌套组合：all[any[...], compare] 多样本验证", () => {
  const rule: RuleDsl = {
    kind: "all",
    conditions: [
      {
        kind: "any",
        conditions: [
          { kind: "in", field: "deviceClass", values: ["III", "III类"] },
          { kind: "compare", field: "amount", op: "gt", value: 100000 },
        ],
      },
      { kind: "compare", field: "department", op: "eq", value: "采购部" },
    ],
  };
  assert.equal(run(rule, { deviceClass: "III类", amount: 5000, department: "采购部" }).matched, true);
  assert.equal(run(rule, { deviceClass: "II类", amount: 120000, department: "采购部" }).matched, true);
  assert.equal(run(rule, { deviceClass: "III类", amount: 5000, department: "客服部" }).matched, false);
  assert.equal(run(rule, { deviceClass: "II类", amount: 5000, department: "采购部" }).matched, false);
});

/* ================================================================
 * 五、fail-closed 安全校验
 * ================================================================ */

test("T13 · 嵌套深度超过上限抛错拒绝（防恶意超深结构）", () => {
  // 构造 10 层深嵌套（上限 8）
  let node: unknown = { kind: "compare", field: "n", op: "eq", value: 1 };
  for (let i = 0; i < 10; i++) {
    node = { kind: "all", conditions: [node] };
  }
  assertThrows(() => validateRuleDsl(node), `嵌套深度超过上限 ${String(DSL_MAX_DEPTH)}`);
});

test("T14 · 未知 kind / 非对象结构一律抛错拒绝", () => {
  assertThrows(() => validateRuleDsl({ kind: "eval", code: "process.exit(1)" }), "不在受控清单");
  assertThrows(() => validateRuleDsl({ kind: "while", body: "死循环" }), "不在受控清单");
  assertThrows(() => validateRuleDsl(null), "必须是 JSON 对象");
  assertThrows(() => validateRuleDsl([1, 2, 3]), "必须是 JSON 对象");
  assertThrows(() => validateRuleDsl("amount > 50000"), "必须是 JSON 对象", );
  assertThrows(() => validateRuleDsl(42), "必须是 JSON 对象");
});

test("T15 · 原型链攻击字段（__proto__/constructor/prototype）物理封死", () => {
  assertThrows(
    () => validateRuleDsl({ kind: "compare", field: "__proto__", op: "eq", value: 1 }),
    "原型链黑名单",
  );
  assertThrows(
    () => validateRuleDsl({ kind: "compare", field: "constructor", op: "eq", value: 1 }),
    "原型链黑名单",
  );
  assertThrows(
    () => validateRuleDsl({ kind: "compare", field: "a.prototype", op: "eq", value: 1 }),
    "原型链黑名单",
  );
  // 求值取值也封死：即便绕过校验手工构造，Object.hasOwn 也让原型链不可达
  const forged = { kind: "compare", field: "__proto__", op: "eq", value: 1 } as unknown as RuleDsl;
  const evil: Record<string, unknown> = JSON.parse('{"hasOwnProperty": 1}');
  assert.equal(evaluateRuleDsl(forged, evil).matched, false, "原型链取值必须失败");
});

test("T16 · 非法值封顶：NaN / Infinity / 超长字符串 / 清单越界一律拒绝", () => {
  assertThrows(() => validateRuleDsl({ kind: "compare", field: "n", op: "gt", value: Number.NaN }), "有限数");
  assertThrows(() => validateRuleDsl({ kind: "compare", field: "n", op: "gt", value: Infinity }), "有限数");
  // gt/gte/lt/lte 配字符串 value：校验期直接拒绝（字典序比较毫无业务意义）
  assertThrows(
    () => validateRuleDsl({ kind: "compare", field: "amount", op: "gt", value: "50000" }),
    "只允许数值",
  );
  assertThrows(
    () => validateRuleDsl({ kind: "compare", field: "n", op: "eq", value: "x".repeat(201) }),
    "200 上限",
  );
  assertThrows(
    () => validateRuleDsl({ kind: "in", field: "n", values: [] }),
    "1~",
  );
  assertThrows(
    () => validateRuleDsl({ kind: "in", field: "n", values: [{ evil: true }] }),
    "数字/字符串/布尔",
  );
});

test("T17 · 事实缺失字段 fail-closed 判 false：查不到的事实绝不判真放行", () => {
  const rule: RuleDsl = {
    kind: "any",
    conditions: [
      { kind: "compare", field: "amount", op: "gt", value: 50000 },
      { kind: "compare", field: "level", op: "eq", value: "VIP" },
    ],
  };
  const result = run(rule, { summary: "只有摘要，没有任何判定字段" });
  assert.equal(result.matched, false, "全部事实缺失 → any 也必须 false");
  assert.equal(result.leaves.length, 2);
  for (const leaf of result.leaves) {
    assert.equal(leaf.matched, false);
    assert.equal(leaf.actual, "（事实缺失）");
  }
});

test("T18 · all/any 空分支与超分支数拒绝 + 字段名白名单拒绝", () => {
  assertThrows(() => validateRuleDsl({ kind: "all", conditions: [] }), "1~");
  assertThrows(() => validateRuleDsl({ kind: "compare", field: "1bad", op: "eq", value: 1 }), "字段名");
  assertThrows(() => validateRuleDsl({ kind: "compare", field: "has space", op: "eq", value: 1 }), "字段名");
  assertThrows(() => validateRuleDsl({ kind: "compare", field: "", op: "eq", value: 1 }), "字段名");
  assertThrows(() => validateRuleDsl({ kind: "compare", field: "amount", op: "explode", value: 1 }), "算子非法");
});

/* ================================================================
 * 六、租户场景端到端
 * ================================================================ */

test("T19 · 瑞康冷链超温 ≥2℃ 端到端：2.0℃ 触发复核、1.9℃ 放行", () => {
  const coldChain: RuleDsl = {
    kind: "compare",
    field: "tempDeviationC",
    op: "gte",
    value: 2,
  };
  assert.equal(validateRuleDsl(coldChain).kind, "compare");
  const over = run(coldChain, { tempDeviationC: 2.0 });
  assert.equal(over.matched, true, "超温 ≥2℃（含 2.0 整）→ 强制人工复核");
  const under = run(coldChain, { tempDeviationC: 1.9 });
  assert.equal(under.matched, false, "1.9℃ 未达阈值 → 不触发");
  const missing = run(coldChain, {});
  assert.equal(missing.matched, false, "温度读数缺失 → fail-closed 不放行");
});

test("T20 · 患者隐私零泄露组合规则 + 中文描述输出端到端", () => {
  const privacy: RuleDsl = {
    kind: "all",
    conditions: [
      { kind: "compare", field: "containsPatientData", op: "eq", value: true },
      { kind: "not_in", field: "department", values: ["合规部", "质控部"] },
    ],
  };
  const leak = run(privacy, { containsPatientData: true, department: "客服部" });
  assert.equal(leak.matched, true, "患者数据离开授权部门 → 红灯拦截");

  const safe = run(privacy, { containsPatientData: true, department: "质控部" });
  assert.equal(safe.matched, false, "授权部门处理 → 放行");

  const noPatientData = run(privacy, { containsPatientData: false, department: "客服部" });
  assert.equal(noPatientData.matched, false, "不含患者数据 → 放行");

  // 中文描述可读性（审计文案用）
  const fin001: RuleDsl = {
    kind: "all",
    conditions: [
      { kind: "compare", field: "department", op: "eq", value: "财务部" },
      { kind: "compare", field: "amount", op: "gt", value: 50000 },
    ],
  };
  const describeText = describeRuleDsl(validateRuleDsl(fin001));
  assert.ok(describeText.includes("全部满足"), "描述应含【全部满足】");
  assert.ok(describeText.includes("严格超过 50,000"), `描述应含「严格超过 50,000」，实际：${describeText}`);
  assert.ok(describeText.includes("「财务部」"), "描述应含部门清单值");
});
