/**
 * FIN-001 判定：全站单点唯一来源
 * 溯源：AGENTS.md 业务红线 FIN-001——单笔「超过」¥50,000 才触发，「等于」不触发；
 *      2025 年旧版 10 万额度制度已废止，本文件不得出现 100000 阈值。
 * 数据真源：config/approval-policies.json（Day 26 外置化迁移）——改门槛 = 改配置 5 秒生效；
 *      本文件的 50000 字面量是「启动一致性基准」：与配置不符时 fail-closed 拒绝启动，
 *      防止配置被改坏后代码静默放行（单点锚定，非散落副本）。
 * 服务端（建单落库）与客户端（卡片高亮）共用本函数，禁止任何副本。
 * Day 27 多租户：其他租户的审批门槛从 config/tenants/<tenantId>.json 读取后
 *      经 setActiveFinanceRules 注入（缺省恒为默认租户经典口径，互不影响）。
 */

import { APPROVAL_POLICY, getFinanceApprovalThresholdCny } from "@/lib/policy/approval-policy";

/** 红线阈值（单位：元）——启动一致性基准（真源见 config/approval-policies.json） */
export const FIN001_THRESHOLD_YUAN = 50000;

// fail-closed：配置阈值与代码基准不一致时立即抛错（进程拒绝启动，绝不带病运行）
if (getFinanceApprovalThresholdCny() !== FIN001_THRESHOLD_YUAN) {
  throw new Error(
    `审批策略一致性校验失败：config/approval-policies.json 的 financeApprovalCny=` +
      `${String(getFinanceApprovalThresholdCny())} 与代码基准 FIN001_THRESHOLD_YUAN=${String(FIN001_THRESHOLD_YUAN)} 不一致。` +
      "请以财务部书面确认为准同步两处，再重新启动。",
  );
}

/* ================================================================
 * 破坏演习注入缝（Day 25 评测门禁专用）
 * 生产环境永远为 null：isLargeAmount 行为与红线真源完全一致；
 * 仅 eval-gate 的 --chaos 破坏演习会在【内存】里把阈值改坏，
 * 用于证明门禁能红灯拦截「红线被改坏」的回归——绝不修改任何源文件，演习后必须复位。
 * ================================================================ */

let chaosThresholdOverrideYuan: number | null = null;

/** 仅限评测门禁破坏演习调用：null = 恢复真源阈值；任何调用方必须在 finally 复位 */
export function setFin001ChaosThresholdOverride(yuan: number | null): void {
  chaosThresholdOverrideYuan = yuan;
}

/* ================================================================
 * 租户财务规则注入缝（Day 27 多租户专用）
 * 缺省恒为 null（默认租户经典口径）；多租户服务端按请求租户注入
 * config/tenants/<tenantId>.json 里的审批门槛（见 ontology/tenant-config.financeRulesOf）。
 * 优先级：破坏演习 > 租户规则 > 配置真源（演习是刻意改坏，必须最先看到）。
 * ================================================================ */

/** 租户化财务规则切片 */
export interface FinanceRules {
  /** 触发门槛所限定的部门（如「财务部」） */
  financeDepartment: string;
  /** 金额门槛（元）：严格大于才触发，等于不触发 */
  thresholdYuan: number;
}

/** 默认租户财务规则（经典口径：FIN-001 部门 + 50000 启动基准） */
export const DEFAULT_FINANCE_RULES: FinanceRules = {
  financeDepartment: APPROVAL_POLICY.rules.find((r) => r.id === "FIN-001")?.department ?? "财务部",
  thresholdYuan: FIN001_THRESHOLD_YUAN,
};

let tenantRulesOverride: FinanceRules | null = null;

/** 注入当前请求租户的财务规则；null = 复位为默认租户经典口径（请求结束必须复位防串味） */
export function setActiveFinanceRules(rules: FinanceRules | null): void {
  tenantRulesOverride = rules;
}

/** 当前生效的财务规则（判定与审计文案统一取此口径；优先级：演习 > 租户 > 配置真源） */
export function activeFinanceRules(): FinanceRules {
  if (chaosThresholdOverrideYuan !== null) {
    return { ...DEFAULT_FINANCE_RULES, thresholdYuan: chaosThresholdOverrideYuan };
  }
  return tenantRulesOverride ?? DEFAULT_FINANCE_RULES;
}

/** 当前生效阈值（演习注入 or 租户规则 or 配置真源），供回答文本引用口径 */
export function activeFin001ThresholdYuan(): number {
  if (chaosThresholdOverrideYuan !== null) return chaosThresholdOverrideYuan;
  return tenantRulesOverride?.thresholdYuan ?? getFinanceApprovalThresholdCny();
}

/**
 * FIN-001 判定（超门槛且命中门槛部门才触发；「等于」不触发）。
 * rules 缺省 = 当前生效规则（未注入任何演习/租户时即默认租户经典口径）。
 */
export function isLargeAmount(
  t: { department: string; amount: number },
  rules: FinanceRules = activeFinanceRules(),
): boolean {
  if (rules === DEFAULT_FINANCE_RULES) {
    // 默认租户走经典常量口径（保持既有行为与审计文案完全不变）
    return t.department === "财务部" && t.amount > FIN001_THRESHOLD_YUAN;
  }
  return t.department === rules.financeDepartment && t.amount > rules.thresholdYuan;
}

/** 具名审批人校验（CISO 条款 3：AI / 匿名 / 部门 / 值班一律无效；名单真源在配置） */
export function isValidNamedApprover(approver: string): boolean {
  const forbidden = APPROVAL_POLICY.humanApproval.forbiddenApprovers;
  const name = approver.trim();
  if (name.length === 0 || name.length > 20) return false;
  return !forbidden.some((word) => name.toLowerCase().includes(word.toLowerCase()));
}

/** 供客户端展示用的具名审批人名单（真源：config/approval-policies.json） */
export const NAMED_APPROVERS = APPROVAL_POLICY.humanApproval.namedApprovers;
