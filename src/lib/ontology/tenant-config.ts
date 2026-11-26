/**
 * 租户配置层（Day 27 多租户逻辑隔离 · 唯一真源）
 * 溯源：Day 27 任务——提示词模板、审批门槛、部门分类、单据字段必须从租户配置文件
 *      动态读取，禁止写死"星辰集团"；AGENTS.md 代码红线 2（密钥/配置不入代码）。
 * 边界：
 *  - 本模块只准服务端引用（node:fs 读配置文件），客户端组件严禁 import；
 *  - fail-closed：任何租户配置缺失或非法字段，直接抛错拒绝服务，绝不静默兜底；
 *  - 提示词文案真源 = 本配置文件；prompt_versions 表只留版本开关与演练标记（热回滚机制不变）。
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { validateRuleDsl, type RuleDsl } from "@/lib/workbot/rule-dsl";

/** 默认租户（星辰跨境企服集团）——历史存量行由数据库 DEFAULT 'xingchen' 回填 */
export const DEFAULT_TENANT_ID = "xingchen";

/** 租户配置目录（config/tenants/<tenantId>.json） */
export const TENANT_CONFIG_DIR = path.join(process.cwd(), "config", "tenants");

/* ================================================================
 * 一、配置类型
 * ================================================================ */

/** 审批门槛（mode 只允许 "above"：严格大于才触发，「等于」不触发——FIN-001 口径） */
export interface TenantApprovalThreshold {
  /** 触发门槛所限定的部门（如「财务部」） */
  department: string;
  /** 金额门槛（元，整数） */
  amountYuan: number;
  /** 触发口径：above = 严格大于 */
  mode: "above";
}

/** 单据字段定义（展示标签 / 是否必填 / 是否 PII） */
export interface TenantDocumentField {
  key: string;
  label: string;
  required: boolean;
  /** PII 字段展示层一律脱敏（张* / 6222 **** **** 1234） */
  pii: boolean;
}

/** 租户主题色（Day 29 配置工作台：切换租户时全站主题无缝换肤） */
export interface TenantTheme {
  /** 主色 hex（#RRGGBB） */
  primaryHex: string;
  /** 主色中文名（展示用） */
  primaryName: string;
}

/** 租户红线规则（Day 29：规则 DSL 外置化——纯数据条件树，经 validateRuleDsl fail-closed 校验） */
export interface TenantRedlineRule {
  /** 规则编号（如 FIN-001 / RK-COLD-002） */
  id: string;
  /** 中文规则名（如「冷链超温 ≥2℃ 强制人工复核」） */
  label: string;
  /** 命中后动作（展示用，如 REQUIRE_HUMAN_APPROVAL / MANUAL_REVIEW / BLOCK_LEAK） */
  action: string;
  /** 规则 DSL 条件树（已校验收窄） */
  rule: RuleDsl;
}

/** 租户配置（config/tenants/<tenantId>.json 的解析结果） */
export interface TenantConfig {
  tenantId: string;
  /** 公司显示名（提示词与页面文案用，不再写死） */
  companyDisplayName: string;
  /** 部门分类清单 */
  departments: readonly string[];
  /** 审批门槛（FIN-001 口径的租户化） */
  approvalThreshold: TenantApprovalThreshold;
  /** 具名审批人清单（AI/匿名/值班永远不在列） */
  namedApprovers: readonly string[];
  /** 业务流 → 部门映射（语义记忆学习用） */
  flowDepartments: Readonly<Record<string, string>>;
  /** 提示词模板（占位符：{company} {threshold} {approvers}） */
  promptTemplate: string;
  /** 故障演练版提示词模板（引用废止制度，仅演练时经 prompt_versions 开关启用） */
  faultyPromptTemplate: string;
  /** 单据字段清单（从配置动态读取，不同租户可不同标签） */
  documentFields: readonly TenantDocumentField[];
  /** 主题色（缺省 = 经典石墨黑；配置工作台按此换肤） */
  theme: TenantTheme;
  /** 红线规则 DSL 清单（缺省空；命中规则 = 触发对应红线动作） */
  redlineRules: readonly TenantRedlineRule[];
}

/** FIN-001 判定所需的财务规则切片（fin001.isLargeAmount 的注入参数） */
export interface TenantFinanceRules {
  financeDepartment: string;
  thresholdYuan: number;
}

/** 从租户配置提取 FIN-001 判定规则（fin001.ts 唯一消费口径） */
export function financeRulesOf(cfg: TenantConfig): TenantFinanceRules {
  return {
    financeDepartment: cfg.approvalThreshold.department,
    thresholdYuan: cfg.approvalThreshold.amountYuan,
  };
}

/* ================================================================
 * 二、fail-closed 校验（纯函数，测试可直测，不依赖文件系统）
 * ================================================================ */

/** 租户 ID 白名单格式：小写字母/数字/连字符，防路径穿越 */
export const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** 提示词模板必须支持的占位符 */
const REQUIRED_TEMPLATE_PLACEHOLDERS: readonly string[] = ["{company}", "{threshold}"];

/**
 * 校验并收窄原始 JSON → TenantConfig（fail-closed：任何非法字段抛错）。
 * 独立成纯函数：隔离测试无需文件系统即可覆盖全部边界。
 */
export function parseTenantConfig(raw: unknown): TenantConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("租户配置必须是 JSON 对象。");
  }
  const obj = raw as Record<string, unknown>;

  const tenantId = obj.tenantId;
  if (typeof tenantId !== "string" || !TENANT_ID_PATTERN.test(tenantId)) {
    throw new Error(`租户配置 tenantId 非法（只允许小写字母/数字/连字符）：${String(tenantId)}`);
  }

  const companyDisplayName = obj.companyDisplayName;
  if (typeof companyDisplayName !== "string" || companyDisplayName.trim().length === 0) {
    throw new Error(`租户 ${tenantId} 缺少 companyDisplayName。`);
  }

  // 部门分类：非空、去重
  const departmentsRaw = obj.departments;
  if (
    !Array.isArray(departmentsRaw) ||
    departmentsRaw.length === 0 ||
    !departmentsRaw.every((d): d is string => typeof d === "string" && d.trim().length > 0)
  ) {
    throw new Error(`租户 ${tenantId} 的 departments 必须是非空字符串数组。`);
  }
  const departments = [...new Set(departmentsRaw.map((d) => d.trim()))];

  // 审批门槛：整数 > 0；mode 必须 "above"（严格大于，等于不触发）
  const thresholdRaw = obj.approvalThreshold as Record<string, unknown> | undefined;
  if (
    typeof thresholdRaw !== "object" ||
    thresholdRaw === null ||
    typeof thresholdRaw.department !== "string" ||
    !departments.includes(thresholdRaw.department) ||
    !Number.isInteger(thresholdRaw.amountYuan) ||
    (thresholdRaw.amountYuan as number) <= 0 ||
    thresholdRaw.mode !== "above"
  ) {
    throw new Error(
      `租户 ${tenantId} 的 approvalThreshold 非法：必须是 { department ∈ departments, amountYuan 为正整数, mode: "above" }。`,
    );
  }
  const approvalThreshold: TenantApprovalThreshold = {
    department: thresholdRaw.department,
    amountYuan: thresholdRaw.amountYuan as number,
    mode: "above",
  };

  // 具名审批人：非空字符串数组（AI/匿名/值班由 fin001.isValidNamedApprover 运行时再拦一层）
  const approversRaw = obj.namedApprovers;
  if (
    !Array.isArray(approversRaw) ||
    approversRaw.length === 0 ||
    !approversRaw.every((a): a is string => typeof a === "string" && a.trim().length > 0)
  ) {
    throw new Error(`租户 ${tenantId} 的 namedApprovers 必须是非空字符串数组。`);
  }

  // 业务流 → 部门映射：键任意，值必须在 departments 内
  const flowRaw = obj.flowDepartments as Record<string, unknown> | undefined;
  if (typeof flowRaw !== "object" || flowRaw === null) {
    throw new Error(`租户 ${tenantId} 缺少 flowDepartments 映射。`);
  }
  const flowDepartments: Record<string, string> = {};
  for (const [flow, dept] of Object.entries(flowRaw)) {
    if (typeof dept !== "string" || (dept !== "" && !departments.includes(dept))) {
      throw new Error(
        `租户 ${tenantId} 的 flowDepartments.${flow} 指向未注册部门「${String(dept)}」。`,
      );
    }
    flowDepartments[flow] = dept;
  }

  // 正式提示词模板：必须含 {company} 与 {threshold} 占位符（动态渲染的前提）；
  // 故障演练模板为固定演练文案（引用废止制度），不强制占位符。
  const promptTemplateRaw = obj.promptTemplate;
  const faultyPromptTemplateRaw = obj.faultyPromptTemplate;
  if (
    typeof promptTemplateRaw !== "string" ||
    promptTemplateRaw.trim().length === 0 ||
    typeof faultyPromptTemplateRaw !== "string" ||
    faultyPromptTemplateRaw.trim().length === 0
  ) {
    throw new Error(`租户 ${tenantId} 缺少提示词模板。`);
  }
  for (const ph of REQUIRED_TEMPLATE_PLACEHOLDERS) {
    if (!promptTemplateRaw.includes(ph)) {
      throw new Error(`租户 ${tenantId} 的提示词模板缺少占位符 ${ph}。`);
    }
  }

  // 单据字段：非空，key 唯一；金额字段（amount）必须存在且必填
  const fieldsRaw = obj.documentFields;
  if (!Array.isArray(fieldsRaw) || fieldsRaw.length === 0) {
    throw new Error(`租户 ${tenantId} 的 documentFields 必须是非空数组。`);
  }
  const seenKeys = new Set<string>();
  const documentFields: TenantDocumentField[] = fieldsRaw.map((f) => {
    if (typeof f !== "object" || f === null) {
      throw new Error(`租户 ${tenantId} 的 documentFields 含非法项。`);
    }
    const rec = f as Record<string, unknown>;
    if (
      typeof rec.key !== "string" ||
      rec.key.trim().length === 0 ||
      typeof rec.label !== "string" ||
      rec.label.trim().length === 0
    ) {
      throw new Error(`租户 ${tenantId} 的 documentFields 项缺少 key/label。`);
    }
    const key = rec.key.trim();
    if (seenKeys.has(key)) {
      throw new Error(`租户 ${tenantId} 的 documentFields key 重复：${key}`);
    }
    seenKeys.add(key);
    return {
      key,
      label: rec.label.trim(),
      required: rec.required === true,
      pii: rec.pii === true,
    };
  });
  if (!documentFields.some((f) => f.key === "amount" && f.required)) {
    throw new Error(`租户 ${tenantId} 的 documentFields 缺少必填的 amount 字段。`);
  }

  // 主题色（可选字段：缺省经典石墨黑；hex 必须是 #RRGGBB）
  const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;
  const themeRaw = obj.theme as Record<string, unknown> | undefined;
  let theme: TenantTheme = { primaryHex: "#18181b", primaryName: "经典石墨黑" };
  if (themeRaw !== undefined) {
    if (
      typeof themeRaw.primaryHex !== "string" ||
      !HEX_PATTERN.test(themeRaw.primaryHex) ||
      typeof themeRaw.primaryName !== "string" ||
      themeRaw.primaryName.trim().length === 0
    ) {
      throw new Error(`租户 ${tenantId} 的 theme 非法：primaryHex 必须是 #RRGGBB，primaryName 必须非空。`);
    }
    theme = { primaryHex: themeRaw.primaryHex, primaryName: themeRaw.primaryName.trim() };
  }

  // 红线规则 DSL（可选字段：缺省空清单；每条经 validateRuleDsl fail-closed 校验）
  const redlineRaw = obj.redlineRules;
  const redlineRules: TenantRedlineRule[] = [];
  if (redlineRaw !== undefined) {
    if (!Array.isArray(redlineRaw) || redlineRaw.length > 20) {
      throw new Error(`租户 ${tenantId} 的 redlineRules 必须是不超过 20 条的数组。`);
    }
    for (const r of redlineRaw) {
      if (typeof r !== "object" || r === null) {
        throw new Error(`租户 ${tenantId} 的 redlineRules 含非法项。`);
      }
      const rec = r as Record<string, unknown>;
      if (
        typeof rec.id !== "string" ||
        !/^[A-Za-z0-9-]{1,40}$/.test(rec.id) ||
        typeof rec.label !== "string" ||
        rec.label.trim().length === 0 ||
        rec.label.length > 60 ||
        typeof rec.action !== "string" ||
        rec.action.trim().length === 0 ||
        rec.action.length > 40
      ) {
        throw new Error(`租户 ${tenantId} 的 redlineRules 项缺少合法的 id/label/action。`);
      }
      redlineRules.push({
        id: rec.id,
        label: rec.label.trim(),
        action: rec.action.trim(),
        rule: validateRuleDsl(rec.rule, 0, `租户 ${tenantId} 红线规则 ${rec.id}`),
      });
    }
  }

  return {
    tenantId,
    companyDisplayName: companyDisplayName.trim(),
    departments,
    approvalThreshold,
    namedApprovers: approversRaw.map((a) => a.trim()),
    flowDepartments,
    promptTemplate: promptTemplateRaw,
    faultyPromptTemplate: faultyPromptTemplateRaw,
    documentFields,
    theme,
    redlineRules,
  };
}

/* ================================================================
 * 三、加载与缓存（服务端）
 * ================================================================ */

/** 进程内缓存：同一租户配置只读一次文件 */
const configCache = new Map<string, TenantConfig>();

/** 校验租户 ID（防路径穿越的最后一道闸） */
function assertValidTenantId(tenantId: string): void {
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new Error(`租户 ID 非法（防路径穿越拒绝）：${tenantId}`);
  }
}

/** 读取租户配置（fail-closed：文件缺失 / JSON 非法 / 校验不过一律抛错） */
export async function loadTenantConfig(tenantId: string): Promise<TenantConfig> {
  assertValidTenantId(tenantId);
  const cached = configCache.get(tenantId);
  if (cached) return cached;

  const filePath = path.join(TENANT_CONFIG_DIR, `${tenantId}.json`);
  let raw: unknown;
  try {
    const text = await readFile(filePath, "utf-8");
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`租户配置不存在或非法：config/tenants/${tenantId}.json（fail-closed，拒绝兜底）。`);
  }
  const cfg = parseTenantConfig(raw);
  if (cfg.tenantId !== tenantId) {
    throw new Error(`租户配置文件 ${tenantId}.json 内的 tenantId（${cfg.tenantId}）与文件名不一致。`);
  }
  configCache.set(tenantId, cfg);
  return cfg;
}

/** 列出全部已上架租户 ID（读 config/tenants/ 目录；文件名不符合白名单格式的跳过） */
export async function listTenantIds(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(TENANT_CONFIG_DIR);
  } catch {
    return [];
  }
  const ids = entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter((id) => TENANT_ID_PATTERN.test(id));
  return [...new Set(ids)].sort();
}

/** 渲染提示词模板：{company} / {threshold} / {approvers} 占位符替换 */
export function buildSystemPrompt(
  cfg: TenantConfig,
  opts: { faulty?: boolean } = {},
): string {
  const template = opts.faulty ? cfg.faultyPromptTemplate : cfg.promptTemplate;
  return template
    .replaceAll("{company}", cfg.companyDisplayName)
    .replaceAll("{threshold}", cfg.approvalThreshold.amountYuan.toLocaleString("zh-CN"))
    .replaceAll("{approvers}", cfg.namedApprovers.join("、"));
}
