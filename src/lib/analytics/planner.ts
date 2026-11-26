/**
 * Day 39 确定性 NL→SQL 规划器（planner.ts）
 * 溯源：ADR-001 受控输出（大模型/用户文本永远不直接拼 SQL）；
 *      .fde/03-solution-design.md「ROI 测算假设表」（Day 2 预估口径）。
 *
 * 路线：大白话提问 → 关键词评分命中【模板白名单】→ 参数全部占位符绑定
 *      （租户 = 服务端常量、金额阈值 = fin001 单一真源、月份窗口 = 服务端时钟）。
 *      任何无法命中模板的提问一律诚实拒答，绝不硬凑 SQL。
 */

import { activeFin001ThresholdYuan } from "@/lib/fin001";

/** 服务端会话租户（分析代理为绿区只读，租户由服务端决定，客户端不可影响） */
export const ANALYTICS_TENANT_ID = "xingchen";

export type AnalyticsPlanMode = "month" | "all";

export interface SqlPlanStep {
  label: string;
  sql: string;
  params: unknown[];
  /** 是否触碰租户业务表（决定第③重校验口径） */
  scoped: boolean;
}

export interface AnalyticsPlan {
  templateId: string;
  title: string;
  mode: AnalyticsPlanMode;
  matchedKeywords: string[];
  steps: SqlPlanStep[];
}

/* ================================================================
 * 一、服务端时间窗口（本地时区自然月）
 * ================================================================ */

export function monthBounds(): { start: Date; end: Date; label: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
  const label = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月`;
  return { start, end, label };
}

/* ================================================================
 * 二、Day 2 ROI 假设常量（单一真源：.fde/03 假设表 A1~A10）
 * ================================================================ */

export const DAY2_ASSUMPTIONS = {
  /** A1 月均单量预估 */
  monthlyTickets: 4000,
  /** A2 现状每单人工处理时长（分钟） */
  manualMinutesPerTicket: 12,
  /** A8 V1 上线后每单人工时长（分钟） */
  aiMinutesPerTicket: 3,
  /** A6 一单错账/漏审平均返工时长（分钟） */
  reworkMinutesPerCase: 30,
  /** A5 员工每人每月综合成本（元） */
  staffCostPerMonth: 12000,
  /** A4 每月法定工时（小时） */
  staffHoursPerMonth: 160,
  /** A10 机器运行费折合每单（元） */
  machineCostPerTicket: 1,
  /** A3×A7 漏审损失预算（每月，元）：4000 单 × 4% 漏审 × ¥200 */
  leakLossBudgetPerMonth: 24000,
  /** 03 号契约测算结论：月净收益预估（元） */
  estimatedMonthlyGain: 71000,
  /** 演示口径汇率（展示折算，非业务操作） */
  demoFxUsdToCny: 7.2,
} as const;

export const ROI_ASSUMPTION_NOTE =
  "人工/返工折算沿用 Day 2 假设参数（A4~A8：¥12,000 ÷ 160h ≈ ¥75/小时）；实测样本为当月真实只读快照，样本量小，不构成收益承诺。";

/* ================================================================
 * 三、SQL 模板白名单（全部参数化占位符，零字符串拼接用户输入）
 * ================================================================ */

interface TemplateDef {
  id: string;
  title: string;
  keywords: string[];
  build: (mode: AnalyticsPlanMode, bounds: { start: Date; end: Date }) => SqlPlanStep[];
}

function deptFin001Steps(mode: AnalyticsPlanMode, bounds: { start: Date; end: Date }): SqlPlanStep[] {
  const threshold = activeFin001ThresholdYuan();
  const base =
    "SELECT department, COUNT(*) AS ticket_count, SUM(amount) AS intercept_amount " +
    "FROM intake_requests WHERE tenant_id = $1 AND amount > $2";
  return [
    mode === "month"
      ? {
          label: "SQL-① 各部门超线拦截（intake_requests · 本月）",
          sql: `${base} AND created_at >= $3 AND created_at < $4 GROUP BY department ORDER BY intercept_amount DESC`,
          params: [ANALYTICS_TENANT_ID, threshold, bounds.start, bounds.end],
          scoped: true,
        }
      : {
          label: "SQL-① 各部门超线拦截（intake_requests · 全部）",
          sql: `${base} GROUP BY department ORDER BY intercept_amount DESC`,
          params: [ANALYTICS_TENANT_ID, threshold],
          scoped: true,
        },
  ];
}

function roiSteps(mode: AnalyticsPlanMode, bounds: { start: Date; end: Date }): SqlPlanStep[] {
  const month = mode === "month";
  return [
    month
      ? {
          label: "SQL-① 本月工单与 FIN-001 拦截（intake_requests）",
          sql:
            "SELECT COUNT(*) AS ticket_count, SUM(CASE WHEN is_fin001 THEN 1 ELSE 0 END) AS fin001_count, " +
            "SUM(CASE WHEN is_fin001 THEN amount ELSE 0 END) AS fin001_amount " +
            "FROM intake_requests WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3",
          params: [ANALYTICS_TENANT_ID, bounds.start, bounds.end],
          scoped: true,
        }
      : {
          label: "SQL-① 全部工单与 FIN-001 拦截（intake_requests）",
          sql:
            "SELECT COUNT(*) AS ticket_count, SUM(CASE WHEN is_fin001 THEN 1 ELSE 0 END) AS fin001_count, " +
            "SUM(CASE WHEN is_fin001 THEN amount ELSE 0 END) AS fin001_amount " +
            "FROM intake_requests WHERE tenant_id = $1",
          params: [ANALYTICS_TENANT_ID],
          scoped: true,
        },
    month
      ? {
          label: "SQL-② 本月专班返工与分流（agent_traces）",
          sql:
            "SELECT COUNT(*) AS trace_count, SUM(rework_count) AS rework_total, " +
            "AVG(triage_savings_percent) AS avg_triage_savings " +
            "FROM agent_traces WHERE created_at >= $1 AND created_at < $2",
          params: [bounds.start, bounds.end],
          scoped: false,
        }
      : {
          label: "SQL-② 全部专班返工与分流（agent_traces）",
          sql: "SELECT COUNT(*) AS trace_count, SUM(rework_count) AS rework_total, AVG(triage_savings_percent) AS avg_triage_savings FROM agent_traces",
          params: [],
          scoped: false,
        },
    month
      ? {
          label: "SQL-③ 本月大模型真实费用（llm_usage_logs）",
          sql:
            "SELECT COUNT(*) AS llm_calls, SUM(usd_cost::numeric) AS llm_cost_usd, " +
            "COUNT(DISTINCT provider_id) AS provider_count " +
            "FROM llm_usage_logs WHERE created_at >= $1 AND created_at < $2",
          params: [bounds.start, bounds.end],
          scoped: false,
        }
      : {
          label: "SQL-③ 全部大模型真实费用（llm_usage_logs）",
          sql: "SELECT COUNT(*) AS llm_calls, SUM(usd_cost::numeric) AS llm_cost_usd, COUNT(DISTINCT provider_id) AS provider_count FROM llm_usage_logs",
          params: [],
          scoped: false,
        },
  ];
}

function reworkReasonSteps(mode: AnalyticsPlanMode, bounds: { start: Date; end: Date }): SqlPlanStep[] {
  const month = mode === "month";
  const select =
    "SELECT COALESCE(NULLIF(escalate_reason, ''), '未注明原因') AS reason, COUNT(*) AS case_count, " +
    "SUM(rework_count) AS rework_total, " +
    "ROUND(SUM(rework_count)::numeric / GREATEST(COUNT(*), 1), 2) AS rework_rate " +
    "FROM agent_traces";
  return [
    month
      ? {
          label: "SQL-① 本月返工原因画像（agent_traces · 本月）",
          sql: `${select} WHERE created_at >= $1 AND created_at < $2 GROUP BY reason ORDER BY rework_rate DESC, rework_total DESC`,
          params: [bounds.start, bounds.end],
          scoped: false,
        }
      : {
          label: "SQL-① 全部返工原因画像（agent_traces · 全部）",
          sql: `${select} GROUP BY reason ORDER BY rework_rate DESC, rework_total DESC`,
          params: [],
          scoped: false,
        },
  ];
}

function ticketVolumeSteps(mode: AnalyticsPlanMode, bounds: { start: Date; end: Date }): SqlPlanStep[] {
  const base =
    "SELECT department, COUNT(*) AS ticket_count, SUM(amount) AS total_amount " +
    "FROM intake_requests WHERE tenant_id = $1";
  return [
    mode === "month"
      ? {
          label: "SQL-① 各部门工单量（intake_requests · 本月）",
          sql: `${base} AND created_at >= $2 AND created_at < $3 GROUP BY department ORDER BY ticket_count DESC`,
          params: [ANALYTICS_TENANT_ID, bounds.start, bounds.end],
          scoped: true,
        }
      : {
          label: "SQL-① 各部门工单量（intake_requests · 全部）",
          sql: `${base} GROUP BY department ORDER BY ticket_count DESC`,
          params: [ANALYTICS_TENANT_ID],
          scoped: true,
        },
  ];
}

function llmCostSteps(mode: AnalyticsPlanMode, bounds: { start: Date; end: Date }): SqlPlanStep[] {
  const select =
    "SELECT provider_id, COUNT(*) AS call_count, SUM(usd_cost::numeric) AS cost_usd " +
    "FROM llm_usage_logs";
  return [
    mode === "month"
      ? {
          label: "SQL-① 大模型费用分布（llm_usage_logs · 本月）",
          sql: `${select} WHERE created_at >= $1 AND created_at < $2 GROUP BY provider_id ORDER BY cost_usd DESC`,
          params: [bounds.start, bounds.end],
          scoped: false,
        }
      : {
          label: "SQL-① 大模型费用分布（llm_usage_logs · 全部）",
          sql: `${select} GROUP BY provider_id ORDER BY cost_usd DESC`,
          params: [],
          scoped: false,
        },
  ];
}

function auditSteps(mode: AnalyticsPlanMode, bounds: { start: Date; end: Date }): SqlPlanStep[] {
  const base = "SELECT action, COUNT(*) AS event_count FROM approval_audit_logs WHERE tenant_id = $1";
  return [
    mode === "month"
      ? {
          label: "SQL-① 审批审计动作分布（approval_audit_logs · 本月）",
          sql: `${base} AND created_at >= $2 AND created_at < $3 GROUP BY action ORDER BY event_count DESC`,
          params: [ANALYTICS_TENANT_ID, bounds.start, bounds.end],
          scoped: true,
        }
      : {
          label: "SQL-① 审批审计动作分布（approval_audit_logs · 全部）",
          sql: `${base} GROUP BY action ORDER BY event_count DESC`,
          params: [ANALYTICS_TENANT_ID],
          scoped: true,
        },
  ];
}

const TEMPLATES: readonly TemplateDef[] = [
  {
    id: "roi_bill",
    title: "Day 2 假设 vs Day 39 实测：硬核 ROI 账单",
    keywords: ["ROI", "roi", "省了", "赚了", "收益", "账单", "划算", "值不值", "对比"],
    build: roiSteps,
  },
  {
    id: "dept_fin001",
    title: "各部门超 5 万拦截总金额",
    keywords: ["部门", "拦截", "大额", "超 5 万", "超5万", "5 万", "5万", "超线"],
    build: deptFin001Steps,
  },
  {
    id: "rework_reason",
    title: "本月返工率最高的原因",
    keywords: ["返工", "原因", "重做", "质量", "返修"],
    build: reworkReasonSteps,
  },
  {
    id: "ticket_volume",
    title: "各部门工单量统计",
    keywords: ["单量", "多少单", "工单数", "总量", "几单"],
    build: ticketVolumeSteps,
  },
  {
    id: "llm_cost",
    title: "大模型费用分布",
    keywords: ["ai 费用", "ai费用", "大模型", "花费", "美元", "token", "token 费"],
    build: llmCostSteps,
  },
  {
    id: "audit_month",
    title: "审批审计动作分布",
    keywords: ["审计", "审批", "放行", "谁批", "签字"],
    build: auditSteps,
  },
];

/** 能力清单（未命中模板时的诚实兜底文案） */
export const PLANNER_CAPABILITIES = TEMPLATES.map((t) => t.title);

/* ================================================================
 * 四、规划入口：关键词评分，命中最高分模板；未命中返回 null
 * ================================================================ */

/**
 * forceMode：引擎在「本月口径查空」时强制切全量重跑用；
 * 不传 = 按提问措辞自动判定（默认自然月，与账单口径一致）。
 */
export function planFromQuestion(question: string, forceMode?: AnalyticsPlanMode): AnalyticsPlan | null {
  const q = question.toLowerCase();
  let best: TemplateDef | null = null;
  let bestHits: string[] = [];

  for (const t of TEMPLATES) {
    const hits = t.keywords.filter((k) => q.includes(k.toLowerCase()));
    if (hits.length > bestHits.length) {
      best = t;
      bestHits = hits;
    }
  }
  if (!best || bestHits.length === 0) return null;

  // 时间口径：明确说「全部/累计/历史」用全量；默认按自然月（与账单口径一致）
  const mode: AnalyticsPlanMode = forceMode ?? (/全部|累计|历史|所有时间|开台以来/.test(question) ? "all" : "month");
  const bounds = monthBounds();

  return {
    templateId: best.id,
    title: best.title,
    mode,
    matchedKeywords: bestHits,
    steps: best.build(mode, bounds),
  };
}

/* ================================================================
 * 五、实测 ROI 账单（确定性公式，数字全部来自 SQL 实查）
 * ================================================================ */

export interface RoiBillRow {
  item: string;
  day2: string;
  day39: string;
  source: string;
  tone: "estimate" | "measured" | "risk" | "total";
}

export interface RoiMeasuredInput {
  ticketCount: number;
  fin001Count: number;
  fin001Amount: number;
  reworkTotal: number;
  avgTriageSavings: number;
  llmCalls: number;
  llmCostUsd: number;
}

export interface RoiBill {
  rows: RoiBillRow[];
  netGainCny: number;
  laborSavingCny: number;
  llmCostCny: number;
  interceptCny: number;
  disclaimer: string;
}

export function fmtCny(n: number): string {
  const v = Math.round(n * 100) / 100;
  return `¥${v.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
}

export function buildRoiBill(measured: RoiMeasuredInput, mode: AnalyticsPlanMode): RoiBill {
  const A = DAY2_ASSUMPTIONS;
  const costPerHour = A.staffCostPerMonth / A.staffHoursPerMonth; // ≈ ¥75/小时

  const hoursSaved = (measured.ticketCount * (A.manualMinutesPerTicket - A.aiMinutesPerTicket)) / 60;
  const laborSavingCny = hoursSaved * costPerHour;
  const reworkHours = (measured.reworkTotal * A.reworkMinutesPerCase) / 60;
  const reworkCostCny = reworkHours * costPerHour;
  const llmCostCny = measured.llmCostUsd * A.demoFxUsdToCny;
  const netGainCny = laborSavingCny - llmCostCny;
  const scope = mode === "month" ? "本月" : "全部累计";

  const money = (n: number) => fmtCny(n);
  const rows: RoiBillRow[] = [
    {
      item: `${scope}工单量`,
      day2: `假设 ${A.monthlyTickets.toLocaleString("zh-CN")} 单/月（A1）`,
      day39: `实测 ${measured.ticketCount.toLocaleString("zh-CN")} 单`,
      source: "SQL-① intake_requests",
      tone: "measured",
    },
    {
      item: "人工处理工时",
      day2: `12 分钟/单 → 3 分钟/单，预估省 ${((A.monthlyTickets * (A.manualMinutesPerTicket - A.aiMinutesPerTicket)) / 60).toLocaleString("zh-CN")} 小时/月（A2/A8）`,
      day39: `实测省 ${hoursSaved.toFixed(1)} 小时（按 A8 口径折算 ≈ ${money(laborSavingCny)}）`,
      source: "SQL-① × 假设 A2/A8",
      tone: "measured",
    },
    {
      item: "错账返工",
      day2: "预估压到 ≈0（A6/A9）",
      day39: `实测仍发生 ${measured.reworkTotal} 次 ≈ ${reworkHours.toFixed(1)} 小时（成本 ≈ ${money(reworkCostCny)}，AI 专班平均分流 ${measured.avgTriageSavings.toFixed(0)}%）`,
      source: "SQL-② agent_traces × A6",
      tone: "measured",
    },
    {
      item: "大额漏审损失",
      day2: `预估省 ${money(A.leakLossBudgetPerMonth)}/月（A3/A7）`,
      day39: `实测 FIN-001 拦截超线 ${measured.fin001Count} 单 / ${money(measured.fin001Amount)}（风险规避敞口，非收益）`,
      source: "SQL-① intake_requests",
      tone: "risk",
    },
    {
      item: "机器运行费",
      day2: `预估 ${money(A.monthlyTickets * A.machineCostPerTicket)}/月（A10）`,
      day39: `实测 $${measured.llmCostUsd.toFixed(4)}（${measured.llmCalls} 次调用，折合 ≈ ${money(llmCostCny)}，演示汇率 ${A.demoFxUsdToCny}）`,
      source: "SQL-③ llm_usage_logs",
      tone: "measured",
    },
    {
      item: "月净收益",
      day2: `预估 ≈ ${money(A.estimatedMonthlyGain)}/月（03 号契约测算）`,
      day39: `实测（保守可证口径）≈ ${money(netGainCny)}：人工省 ${money(laborSavingCny)} − 机器费 ${money(llmCostCny)}；另有 ${money(measured.fin001Amount)} 超线金额被拦在人工审批闸前`,
      source: "上述实测项合计",
      tone: "total",
    },
  ];

  return {
    rows,
    netGainCny,
    laborSavingCny,
    llmCostCny,
    interceptCny: measured.fin001Amount,
    disclaimer: `${ROI_ASSUMPTION_NOTE}（口径：${scope}）`,
  };
}
