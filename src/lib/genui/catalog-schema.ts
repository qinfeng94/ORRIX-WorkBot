/**
 * catalog-schema.ts —— Day 8 生成式 UI 组件目录与安全契约（共享：服务端 + 客户端）
 * 溯源：AGENTS.md 红线——大模型只输出「白名单组件名 + 受控 Props」，严禁输出原始 HTML/JS；
 *      04 号文档三色边界（黄区审批类组件只起草，放行归具名审批人）。
 * 安全设计（物理隔离，不是提示词劝阻）：
 * - 组件名白名单 CATALOG：不在名单内的组件名一律拒绝（客户端温和降级为灰色提示条）；
 * - 逐组件 Props 校验器：类型不符 / 必填缺失一律拒绝整条布局；
 * - 禁用模式扫描：布局 JSON 里出现 <script / javascript: / onerror= 等注入特征直接 400；
 * - parseLayoutFromModelText：剥离 ```json 围栏后解析，模型文本永远不当 HTML 渲染。
 */

/* ================= 一、16 个受控组件的 Props 契约 ================= */

/** 指标类 */
export interface KpiCardProps {
  label: string;
  value: number;
  unit?: string;
  delta?: string;
  tone?: "default" | "good" | "warn" | "danger";
}
export interface RiskBannerProps {
  level: "info" | "warning" | "danger";
  title: string;
  message: string;
  source?: string;
}
export interface ProgressBarProps {
  label: string;
  percent: number;
  detail?: string;
}
export interface CostCardProps {
  provider: string;
  model: string;
  usdCost: number;
  tokensIn: number;
  tokensOut: number;
  note?: string;
}

/** 图表类 */
export interface DeptBarChartProps {
  title: string;
  categories: string[];
  values: number[];
}
export interface TrendLineChartProps {
  title: string;
  labels: string[];
  series: { name: string; values: number[] }[];
}
export interface ShareDonutChartProps {
  title: string;
  slices: { label: string; value: number }[];
}
export interface FunnelChartProps {
  title: string;
  stages: { label: string; value: number }[];
}

/** 表格类 */
export interface TicketTableRow {
  ticketNo: string;
  department: string;
  amount: number;
  summary: string;
  status: string;
}
export interface TicketTableProps {
  title: string;
  rows: TicketTableRow[];
}
export interface PolicyCitationCardProps {
  citations: { docId: string; section: string; title: string; snippet: string }[];
}
export interface CustomerProfileCardProps {
  customerId: string;
  maskedName: string;
  tier: string;
  riskFlag: string;
  fin001Flag: boolean;
  pendingApprovalId: string | null;
}
export interface ComparisonMatrixProps {
  title: string;
  dimensions: string[];
  columns: string[];
  cells: string[][];
}

/** 交互回写类 */
export interface ApprovalFormCardProps {
  approvalId: string;
  tool: string;
  summary: string;
  approverDefault: string;
  ticketRef?: string;
}
export interface QuickFilterBarProps {
  title: string;
  options: string[];
}
export interface DryRunConfirmCardProps {
  approvalId: string;
  tool: string;
  title: string;
  summary: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  draft?: Record<string, unknown>;
}
export interface ExportReportButtonProps {
  label: string;
}

/* ================= 二、组件白名单目录（允许大模型调用的全集） ================= */

export const GENUI_COMPONENT_NAMES = [
  // 指标类
  "kpi_card",
  "risk_banner",
  "progress_bar",
  "cost_card",
  // 图表类
  "dept_bar_chart",
  "trend_line_chart",
  "share_donut_chart",
  "funnel_chart",
  // 表格类
  "ticket_table",
  "policy_citation_card",
  "customer_profile_card",
  "comparison_matrix",
  // 交互回写类
  "approval_form_card",
  "quick_filter_bar",
  "dry_run_confirm_card",
  "export_report_button",
] as const;

export type GenuiComponentName = (typeof GENUI_COMPONENT_NAMES)[number];

export const GENUI_CATEGORIES = {
  指标类: ["kpi_card", "risk_banner", "progress_bar", "cost_card"],
  图表类: ["dept_bar_chart", "trend_line_chart", "share_donut_chart", "funnel_chart"],
  表格类: ["ticket_table", "policy_citation_card", "customer_profile_card", "comparison_matrix"],
  交互回写类: ["approval_form_card", "quick_filter_bar", "dry_run_confirm_card", "export_report_button"],
} as const satisfies Record<string, readonly GenuiComponentName[]>;

export interface GenuiLayoutItem {
  component: GenuiComponentName;
  props: Record<string, unknown>;
}
export interface GenuiLayout {
  layout: GenuiLayoutItem[];
}

/* ================= 三、禁用模式扫描（严禁原始 HTML/JS 进入渲染管线） ================= */

const FORBIDDEN_PATTERNS = [
  /<script/i,
  /<iframe/i,
  /javascript:/i,
  /onerror\s*=/i,
  /onload\s*=/i,
  /dangerouslySetInnerHTML/i,
  /innerHTML/i,
  /eval\s*\(/i,
  /document\.cookie/i,
] as const;

/** 布局 JSON 出现任何注入特征即拒绝（服务端 400，绝不进入渲染） */
export function scanForbiddenPatterns(item: unknown): string | null {
  const text = JSON.stringify(item);
  for (const re of FORBIDDEN_PATTERNS) {
    if (re.test(text)) return `布局包含禁用模式「${re.source}」（疑似原始 HTML/JS 注入）`;
  }
  return null;
}

/* ================= 四、逐组件 Props 校验器 ================= */

type UnknownRecord = Record<string, unknown>;

function isStr(v: unknown): v is string {
  return typeof v === "string";
}
function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isArr(v: unknown): v is unknown[] {
  return Array.isArray(v);
}
function isBool(v: unknown): v is boolean {
  return typeof v === "boolean";
}

interface PropCheck {
  check: (v: unknown) => boolean;
  label: string;
}

/** 每个组件的必填 Props 检查表（类型不符即拒绝该组件条目） */
const PROP_RULES: Record<GenuiComponentName, PropCheck[]> = {
  kpi_card: [
    { check: (p) => isStr(p), label: "label:string" },
    { check: (p) => isNum(p), label: "value:number" },
  ],
  risk_banner: [
    { check: (p) => isStr(p) && ["info", "warning", "danger"].includes(p), label: "level" },
    { check: (p) => isStr(p), label: "title:string" },
    { check: (p) => isStr(p), label: "message:string" },
  ],
  progress_bar: [
    { check: (p) => isStr(p), label: "label:string" },
    { check: (p) => isNum(p) && p >= 0 && p <= 100, label: "percent:0~100" },
  ],
  cost_card: [
    { check: (p) => isStr(p), label: "provider:string" },
    { check: (p) => isStr(p), label: "model:string" },
    { check: (p) => isNum(p), label: "usdCost:number" },
    { check: (p) => isNum(p), label: "tokensIn:number" },
    { check: (p) => isNum(p), label: "tokensOut:number" },
  ],
  dept_bar_chart: [
    { check: (p) => isStr(p), label: "title:string" },
    { check: (p) => isArr(p) && p.every(isStr), label: "categories:string[]" },
    { check: (p) => isArr(p) && p.every(isNum), label: "values:number[]" },
  ],
  trend_line_chart: [
    { check: (p) => isStr(p), label: "title:string" },
    { check: (p) => isArr(p) && p.every(isStr), label: "labels:string[]" },
    {
      check: (p) =>
        isArr(p) &&
        p.every(
          (s) =>
            typeof s === "object" && s !== null && isStr((s as UnknownRecord).name) &&
            isArr((s as UnknownRecord).values) && ((s as UnknownRecord).values as unknown[]).every(isNum),
        ),
      label: "series:[{name,values}]",
    },
  ],
  share_donut_chart: [
    { check: (p) => isStr(p), label: "title:string" },
    {
      check: (p) =>
        isArr(p) &&
        p.every(
          (s) => typeof s === "object" && s !== null && isStr((s as UnknownRecord).label) && isNum((s as UnknownRecord).value),
        ),
      label: "slices:[{label,value}]",
    },
  ],
  funnel_chart: [
    { check: (p) => isStr(p), label: "title:string" },
    {
      check: (p) =>
        isArr(p) &&
        p.every(
          (s) => typeof s === "object" && s !== null && isStr((s as UnknownRecord).label) && isNum((s as UnknownRecord).value),
        ),
      label: "stages:[{label,value}]",
    },
  ],
  ticket_table: [
    { check: (p) => isStr(p), label: "title:string" },
    { check: (p) => isArr(p), label: "rows:array" },
  ],
  policy_citation_card: [
    {
      check: (p) => isArr(p) && p.every((c) => typeof c === "object" && c !== null && isStr((c as UnknownRecord).docId)),
      label: "citations:[{docId,...}]",
    },
  ],
  customer_profile_card: [
    { check: (p) => isStr(p), label: "customerId:string" },
    { check: (p) => isStr(p), label: "maskedName:string" },
    { check: (p) => isStr(p), label: "tier:string" },
    { check: (p) => isStr(p), label: "riskFlag:string" },
    { check: (p) => isBool(p), label: "fin001Flag:boolean" },
  ],
  comparison_matrix: [
    { check: (p) => isStr(p), label: "title:string" },
    { check: (p) => isArr(p) && p.every(isStr), label: "dimensions:string[]" },
    { check: (p) => isArr(p) && p.every(isStr), label: "columns:string[]" },
    { check: (p) => isArr(p) && p.every((r) => isArr(r)), label: "cells:string[][]" },
  ],
  approval_form_card: [
    { check: (p) => isStr(p), label: "approvalId:string" },
    { check: (p) => isStr(p), label: "tool:string" },
    { check: (p) => isStr(p), label: "summary:string" },
    { check: (p) => isStr(p), label: "approverDefault:string" },
  ],
  quick_filter_bar: [
    { check: (p) => isStr(p), label: "title:string" },
    { check: (p) => isArr(p) && p.every(isStr), label: "options:string[]" },
  ],
  dry_run_confirm_card: [
    { check: (p) => isStr(p), label: "approvalId:string" },
    { check: (p) => isStr(p), label: "tool:string" },
    { check: (p) => isStr(p), label: "title:string" },
    { check: (p) => isStr(p), label: "summary:string" },
  ],
  export_report_button: [{ check: (p) => isStr(p), label: "label:string" }],
};

/* ================= 五、解析与校验管线 ================= */

/** 剥离 ```json 围栏并提取候选 JSON 文本（找不到围栏时退化为直接找第一个 { 到末个 }） */
export function stripJsonFence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) return candidate.slice(start, end + 1);
  return candidate.trim();
}

/**
 * 把「模型输出文本」解析为受控布局：
 * ① 剥离 ```json 围栏 → ② JSON.parse → ③ 组件名白名单 → ④ 逐组件 Props 校验 → ⑤ 禁用模式扫描。
 * 任一环节失败都整条拒绝，绝不把模型输出当 HTML 渲染。
 */
export function parseLayoutFromModelText(
  text: string,
): { ok: true; layout: GenuiLayoutItem[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(text));
  } catch {
    return { ok: false, error: "模型输出不是合法 JSON（已剥离围栏后仍解析失败）" };
  }
  return validateGenuiLayout(parsed);
}

/** 校验并放行一个布局对象（服务端与客户端共用同一份规则） */
export function validateGenuiLayout(
  raw: unknown,
): { ok: true; layout: GenuiLayoutItem[] } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null || !isArr((raw as UnknownRecord).layout)) {
    return { ok: false, error: "布局必须形如 { layout: [...] }" };
  }
  const items = (raw as UnknownRecord).layout as unknown[];
  const result: GenuiLayoutItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (typeof item !== "object" || item === null) {
      return { ok: false, error: `第 ${i + 1} 条布局不是对象` };
    }
    const rec = item as UnknownRecord;
    const name = rec.component;
    if (!isStr(name) || !GENUI_COMPONENT_NAMES.includes(name as GenuiComponentName)) {
      return {
        ok: false,
        error: `第 ${i + 1} 条布局引用了未注册组件「${String(name)}」（不在白名单目录中，拒绝渲染）`,
      };
    }
    const comp = name as GenuiComponentName;
    const props = rec.props;
    if (typeof props !== "object" || props === null) {
      return { ok: false, error: `第 ${i + 1} 条布局（${comp}）缺少 props 对象` };
    }
    const propsRec = props as UnknownRecord;
    for (const rule of PROP_RULES[comp]) {
      const key = rule.label.split(":")[0];
      if (!rule.check(propsRec[key])) {
        return { ok: false, error: `第 ${i + 1} 条布局（${comp}）Props 校验失败：${rule.label}` };
      }
    }
    const forbidden = scanForbiddenPatterns(item);
    if (forbidden) return { ok: false, error: `第 ${i + 1} 条布局（${comp}）：${forbidden}` };
    result.push({ component: comp, props: propsRec });
  }
  return { ok: true, layout: result };
}
