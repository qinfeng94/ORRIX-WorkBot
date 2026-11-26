/**
 * Day 29 安全规则 DSL 引擎（非图灵完备）· 零依赖纯函数
 * 溯源：
 *  - ADR-005「规则外置」：配置里禁止任何可执行逻辑，全仓零 eval() / new Function()，
 *    规则 DSL 另立专项（本文件）——规则是【受控结构化数据】，不是可执行代码；
 *  - AGENTS.md 红区：本引擎只做只读判定（比较/与或/区间/清单），没有任何写数据能力；
 *  - FIN-001 口径：严格「超过」才触发，等于不触发（gt 而非 gte，见测试）。
 * 安全设计（为什么非图灵完备 + 为什么安全）：
 *  1. 规则 = JSON 判别联合树，只允许 6 种节点（all/any/compare/between/in/not_in），
 *     无循环、无变量绑定、无函数定义、无递归调用 → 求值必然终止；
 *  2. 深度硬上限 DSL_MAX_DEPTH，恶意超深嵌套在 validate 阶段 fail-closed 拒绝；
 *  3. 字段名白名单正则 + 原型链黑名单（__proto__ / constructor / prototype），
 *     取值逐段 Object.hasOwn，越原型链取值在数学上不可达；
 *  4. 数值必须是有限数（NaN / Infinity 拒绝），字符串长度封顶，清单长度封顶；
 *  5. 事实缺失 → 叶子判 false（fail-closed：查不到的事实绝不判真放行）；
 *  6. 全文件零 eval、零 new Function、零第三方依赖，浏览器与服务端均可引用。
 */

/* ================================================================
 * 一、类型定义（6 种受控节点，闭合清单）
 * ================================================================ */

/** 比较算子：gt/gte/lt/lte 仅数值；eq/ne 支持数值/字符串/布尔 */
export type DslCompareOp = "gt" | "gte" | "lt" | "lte" | "eq" | "ne";

/** DSL 字面量值（受控三型，其余类型一律拒绝） */
export type DslValue = number | string | boolean;

/** 逻辑节点：与（all = 子条件全真才真） */
export interface DslAllNode {
  readonly kind: "all";
  readonly conditions: readonly RuleDsl[];
}

/** 逻辑节点：或（any = 子条件任一为真即真） */
export interface DslAnyNode {
  readonly kind: "any";
  readonly conditions: readonly RuleDsl[];
}

/** 比较节点 */
export interface DslCompareNode {
  readonly kind: "compare";
  readonly field: string;
  readonly op: DslCompareOp;
  readonly value: DslValue;
}

/** 区间节点（min/max + 双端开闭） */
export interface DslBetweenNode {
  readonly kind: "between";
  readonly field: string;
  readonly min: number;
  readonly max: number;
  readonly minInclusive: boolean;
  readonly maxInclusive: boolean;
}

/** 清单节点：命中清单（actual ∈ values） */
export interface DslInNode {
  readonly kind: "in";
  readonly field: string;
  readonly values: readonly DslValue[];
}

/** 清单节点：不在清单（actual ∉ values） */
export interface DslNotInNode {
  readonly kind: "not_in";
  readonly field: string;
  readonly values: readonly DslValue[];
}

/** 规则 DSL 节点（判别联合，闭合清单——第 7 种 kind 在 validate 阶段物理拒绝） */
export type RuleDsl = DslAllNode | DslAnyNode | DslCompareNode | DslBetweenNode | DslInNode | DslNotInNode;

/* ================================================================
 * 二、安全常量与校验（fail-closed，任何非法输入抛错拒绝）
 * ================================================================ */

/** 嵌套深度硬上限（防恶意超深结构拖垮栈） */
export const DSL_MAX_DEPTH = 8;

/** all/any 分支数上限 */
export const DSL_MAX_BRANCHES = 32;

/** in/not_in 清单长度上限 */
export const DSL_MAX_LIST = 100;

/** 字段名白名单：单段为字母/数字/下划线，支持点号多段链（如 order.amount） */
export const DSL_FIELD_SEGMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** 原型链字段黑名单（物理封死原型链逃逸） */
const FORBIDDEN_FIELD_SEGMENTS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const COMPARE_OPS: ReadonlySet<string> = new Set(["gt", "gte", "lt", "lte", "eq", "ne"]);

/** 校验字面量值（受控三型 + 数值必须有限 + 字符串封顶） */
function assertDslValue(value: unknown, where: string): DslValue {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`规则校验失败：${where} 的数值必须是有限数（拒绝 NaN/Infinity）。`);
    }
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 200) {
      throw new Error(`规则校验失败：${where} 的字符串长度超过 200 上限。`);
    }
    return value;
  }
  if (typeof value === "boolean") {
    return value;
  }
  throw new Error(`规则校验失败：${where} 的值只允许 数字/字符串/布尔，收到 ${describeType(value)}。`);
}

/** 校验字段名（白名单正则 + 原型链黑名单，逐段检查） */
function assertDslField(field: unknown, where: string): string {
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`规则校验失败：${where} 缺少 field 字段名。`);
  }
  for (const segment of field.split(".")) {
    if (!DSL_FIELD_SEGMENT_PATTERN.test(segment) || FORBIDDEN_FIELD_SEGMENTS.has(segment)) {
      throw new Error(`规则校验失败：${where} 的字段名「${field}」非法（白名单外或命中原型链黑名单）。`);
    }
  }
  return field;
}

function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "数组";
  return typeof v;
}

/**
 * 校验并收窄原始 JSON → RuleDsl（fail-closed：未知 kind / 超深 / 非法值一律抛错）。
 * 独立纯函数：隔离测试无需任何运行时即可覆盖全部边界。
 */
export function validateRuleDsl(raw: unknown, depth = 0, where = "规则"): RuleDsl {
  if (depth > DSL_MAX_DEPTH) {
    throw new Error(`规则校验失败：嵌套深度超过上限 ${String(DSL_MAX_DEPTH)}（防恶意超深结构）。`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`规则校验失败：${where} 必须是 JSON 对象，收到 ${describeType(raw)}。`);
  }
  const node = raw as Record<string, unknown>;
  const kind = node.kind;

  if (kind === "all" || kind === "any") {
    const conditionsRaw = node.conditions;
    if (
      !Array.isArray(conditionsRaw) ||
      conditionsRaw.length === 0 ||
      conditionsRaw.length > DSL_MAX_BRANCHES
    ) {
      throw new Error(
        `规则校验失败：${where}（${kind}）的 conditions 必须是 1~${String(DSL_MAX_BRANCHES)} 个子条件。`,
      );
    }
    const conditions = conditionsRaw.map((c, i) =>
      validateRuleDsl(c, depth + 1, `${where}.conditions[${String(i)}]`),
    );
    return kind === "all" ? { kind: "all", conditions } : { kind: "any", conditions };
  }

  if (kind === "compare") {
    const field = assertDslField(node.field, where);
    if (typeof node.op !== "string" || !COMPARE_OPS.has(node.op)) {
      throw new Error(`规则校验失败：${where} 的算子非法（只允许 gt/gte/lt/lte/eq/ne）。`);
    }
    const op = node.op as DslCompareOp;
    const value = assertDslValue(node.value, where);
    // gt/gte/lt/lte 只允许数值 value（字符串/布尔在字典序上毫无业务意义，校验期直接拒绝）
    if (op !== "eq" && op !== "ne" && typeof value !== "number") {
      throw new Error(`规则校验失败：${where} 的算子 ${op} 只允许数值（value 必须是有限数字）。`);
    }
    return { kind: "compare", field, op, value };
  }

  if (kind === "between") {
    const field = assertDslField(node.field, where);
    const min = node.min;
    const max = node.max;
    if (typeof min !== "number" || !Number.isFinite(min)) {
      throw new Error(`规则校验失败：${where} 的 min 必须是有限数字。`);
    }
    if (typeof max !== "number" || !Number.isFinite(max)) {
      throw new Error(`规则校验失败：${where} 的 max 必须是有限数字。`);
    }
    if (min > max) {
      throw new Error(`规则校验失败：${where} 的区间非法（min 不能大于 max）。`);
    }
    const minInclusive = node.minInclusive === undefined ? true : node.minInclusive;
    const maxInclusive = node.maxInclusive === undefined ? true : node.maxInclusive;
    if (typeof minInclusive !== "boolean" || typeof maxInclusive !== "boolean") {
      throw new Error(`规则校验失败：${where} 的 minInclusive/maxInclusive 必须是布尔值。`);
    }
    return { kind: "between", field, min, max, minInclusive, maxInclusive };
  }

  if (kind === "in" || kind === "not_in") {
    const field = assertDslField(node.field, where);
    const valuesRaw = node.values;
    if (
      !Array.isArray(valuesRaw) ||
      valuesRaw.length === 0 ||
      valuesRaw.length > DSL_MAX_LIST
    ) {
      throw new Error(`规则校验失败：${where}（${kind}）的 values 必须是 1~${String(DSL_MAX_LIST)} 个元素的数组。`);
    }
    const values = valuesRaw.map((v, i) => assertDslValue(v, `${where}.values[${String(i)}]`));
    return kind === "in" ? { kind: "in", field, values } : { kind: "not_in", field, values };
  }

  throw new Error(`规则校验失败：${where} 的 kind「${String(kind)}」不在受控清单（all/any/compare/between/in/not_in）内。`);
}

/* ================================================================
 * 三、求值（纯只读判定，返回命中轨迹供 UI 展示）
 * ================================================================ */

/** 叶子节点求值轨迹（UI 逐条展示用） */
export interface RuleLeafTrace {
  /** 叶子节点的中文描述 */
  describe: string;
  /** 事实中的实际值（人类可读；缺失显示「（事实缺失）」） */
  actual: string;
  /** 该叶子是否命中 */
  matched: boolean;
}

/** 求值结果 */
export interface RuleEvalResult {
  /** 整条规则是否命中 */
  matched: boolean;
  /** 全部叶子轨迹（无论命中与否，便于解释判定过程） */
  leaves: readonly RuleLeafTrace[];
}

/**
 * 从事实对象按字段链取值：逐段 Object.hasOwn，
 * 原型链上的属性在数学上不可达（缺失即 undefined → 叶子 fail-closed 判 false）。
 */
function readFact(facts: Record<string, unknown>, field: string): unknown {
  let cursor: unknown = facts;
  for (const segment of field.split(".")) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      return undefined;
    }
    const obj = cursor as Record<string, unknown>;
    if (!Object.hasOwn(obj, segment)) {
      return undefined;
    }
    cursor = obj[segment];
  }
  return cursor;
}

function formatFact(v: unknown): string {
  if (v === undefined) return "（事实缺失）";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "（非法数值）";
  if (typeof v === "string") return `「${v}」`;
  if (typeof v === "boolean") return v ? "true" : "false";
  return describeType(v);
}

function trace(describe: string, v: unknown, matched: boolean): RuleLeafTrace {
  return { describe, actual: formatFact(v), matched };
}

/** 数值比较（fail-closed：非有限数字一律 false，绝不字符串字典序比较） */
function compareNumber(actual: unknown, op: DslCompareOp, value: DslValue): boolean {
  if (typeof value !== "number" || typeof actual !== "number" || !Number.isFinite(actual)) {
    return false;
  }
  if (op === "gt") return actual > value;
  if (op === "gte") return actual >= value;
  if (op === "lt") return actual < value;
  if (op === "lte") return actual <= value;
  return false;
}

/** 相等比较（同类型严格相等；跨类型一律 false） */
function equalStrict(actual: unknown, value: DslValue): boolean {
  if (typeof actual !== typeof value) return false;
  return actual === value;
}

/** 清单命中（同类型严格相等匹配；事实缺失一律 false） */
function inList(actual: unknown, values: readonly DslValue[]): boolean {
  if (typeof actual === "object" || actual === undefined) return false;
  return values.some((v) => equalStrict(actual, v));
}

/**
 * 求值规则（只读、必终止：树有限 + 深度已在 validate 封顶）。
 * 传入未经 validateRuleDsl 的结构会抛错——先 validate 再求值，fail-closed。
 */
export function evaluateRuleDsl(rule: RuleDsl, facts: Record<string, unknown>): RuleEvalResult {
  const leaves: RuleLeafTrace[] = [];

  const walk = (node: RuleDsl): boolean => {
    if (node.kind === "all") {
      // 全真才真；短路后续（轨迹仍完整收集，便于解释）
      let result = true;
      for (const child of node.conditions) {
        const ok = walk(child);
        if (!ok) result = false;
      }
      return result;
    }
    if (node.kind === "any") {
      let result = false;
      for (const child of node.conditions) {
        const ok = walk(child);
        if (ok) result = true;
      }
      return result;
    }
    if (node.kind === "compare") {
      const actual = readFact(facts, node.field);
      let matched: boolean;
      if (node.op === "eq") matched = equalStrict(actual, node.value);
      else if (node.op === "ne") matched = !equalStrict(actual, node.value);
      else matched = compareNumber(actual, node.op, node.value);
      leaves.push(trace(describeRuleDsl(node), actual, matched));
      return matched;
    }
    if (node.kind === "between") {
      const actual = readFact(facts, node.field);
      const matched =
        typeof actual === "number" &&
        Number.isFinite(actual) &&
        (node.minInclusive ? actual >= node.min : actual > node.min) &&
        (node.maxInclusive ? actual <= node.max : actual < node.max);
      leaves.push(trace(describeRuleDsl(node), actual, matched));
      return matched;
    }
    // in / not_in
    const actual = readFact(facts, node.field);
    const hit = inList(actual, node.values);
    // fail-closed 关键：not_in 在事实缺失时绝不「反向判真」
    //（例：「部门不在授权清单就放行」——查不到部门反而放行 = 红线绕过漏洞）
    const matched = node.kind === "in" ? hit : actual !== undefined && !hit;
    leaves.push(trace(describeRuleDsl(node), actual, matched));
    return matched;
  };

  const validated = rule; // 类型层面强制：调用方必须先经 validateRuleDsl 收窄
  const matched = walk(validated);
  return { matched, leaves };
}

/* ================================================================
 * 四、中文描述（UI / 审计文案用）
 * ================================================================ */

/** 格式化单个字面量值 */
function formatValue(v: DslValue): string {
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString("zh-CN") : String(v);
  if (typeof v === "string") return `「${v}」`;
  return v ? "true" : "false";
}

/** 生成规则的人类可读中文描述（如「金额 > 50,000 且 部门 ∈ [财务部]」） */
export function describeRuleDsl(rule: RuleDsl): string {
  if (rule.kind === "all") {
    return `【全部满足】${rule.conditions.map(describeRuleDsl).join(" 且 ")}`;
  }
  if (rule.kind === "any") {
    return `【任一满足】${rule.conditions.map(describeRuleDsl).join(" 或 ")}`;
  }
  if (rule.kind === "compare") {
    const opLabel: Record<DslCompareOp, string> = {
      gt: "严格超过",
      gte: "达到或超过",
      lt: "低于",
      lte: "不超过",
      eq: "等于",
      ne: "不等于",
    };
    return `${rule.field} ${opLabel[node_getOp(rule)]} ${formatValue(rule.value)}`;
  }
  if (rule.kind === "between") {
    const lo = rule.minInclusive ? "[" : "(";
    const hi = rule.maxInclusive ? "]" : ")";
    return `${rule.field} 在区间 ${lo}${formatValue(rule.min)}, ${formatValue(rule.max)}${hi}`;
  }
  const listLabel = rule.values.map(formatValue).join("、");
  return rule.kind === "in"
    ? `${rule.field} ∈ 清单 [${listLabel}]`
    : `${rule.field} ∉ 清单 [${listLabel}]`;
}

// 内部小工具：从 compare 节点取算子（避免联合收窄重复代码）
function node_getOp(node: DslCompareNode): DslCompareOp {
  return node.op;
}
