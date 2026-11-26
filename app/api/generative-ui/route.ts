/**
 * /api/generative-ui —— Day 8 生成式 UI 布局接口（仅服务端，POST）
 * 溯源：AGENTS.md 红线——大模型只输出「白名单组件 + 受控 Props」，严禁原始 HTML/JS；
 *      04 号文档三色边界（审批类组件只起草，放行归具名审批人）。
 * 管线（本接口完整演示「模型文本 → 受控渲染」的安全链路）：
 *   ① 组装布局 → ② 包成 ```json 围栏文本（仿真模型输出）→
 *   ③ parseLayoutFromModelText 剥围栏解析 → ④ 白名单 + 逐组件校验 → ⑤ 禁用模式扫描
 * 任一环节失败整条 400，绝不把模型输出当 HTML 渲染。
 * 记账：大屏指标（待审批数 / 今日批准 / 审计留痕 / 今日花费）全部来自数据库真实查询。
 */

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ensureSchema, getDb } from "@/db";
import { approvalAuditLogs, intakeRequests, llmUsageLogs } from "@/db/schema";
import {
  parseLayoutFromModelText,
  type GenuiLayoutItem,
} from "@/lib/genui/catalog-schema";

/* ================= 一、大屏真实指标（DB 查询，失败降级为 0） ================= */

interface DashboardMetrics {
  pendingTotal: number;
  approvedToday: number;
  auditToday: number;
  usdToday: number;
  tokensInToday: number;
  tokensOutToday: number;
  deptCounts: { label: string; value: number }[];
  statusCounts: { label: string; value: number }[];
  approvalTrend: { label: string; value: number }[];
  tickets: {
    ticketNo: string;
    department: string;
    amount: number;
    summary: string;
    status: string;
  }[];
  firstPending: {
    ticketNo: string;
    department: string;
    amount: number;
    summary: string;
  } | null;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

async function loadMetrics(): Promise<DashboardMetrics> {
  const empty: DashboardMetrics = {
    pendingTotal: 0,
    approvedToday: 0,
    auditToday: 0,
    usdToday: 0,
    tokensInToday: 0,
    tokensOutToday: 0,
    deptCounts: [],
    statusCounts: [],
    approvalTrend: [],
    tickets: [],
    firstPending: null,
  };
  try {
    await ensureSchema();
    const db = getDb();
    const today = startOfToday();

    const [pendingRows, approvedRows, auditRows, usageRows, deptRows, statusRows, ticketRows] =
      await Promise.all([
        db
          .select({ n: sql<number>`count(*)`.mapWith(Number) })
          .from(intakeRequests)
          .where(eq(intakeRequests.status, "待林总审批")),
        db
          .select({ n: sql<number>`count(*)`.mapWith(Number) })
          .from(intakeRequests)
          .where(and(eq(intakeRequests.status, "已批准"), gte(intakeRequests.approvedAt, today))),
        db
          .select({ n: sql<number>`count(*)`.mapWith(Number) })
          .from(approvalAuditLogs)
          .where(gte(approvalAuditLogs.createdAt, today)),
        db
          .select({
            usdCost: llmUsageLogs.usdCost,
            inputTokens: llmUsageLogs.inputTokens,
            outputTokens: llmUsageLogs.outputTokens,
          })
          .from(llmUsageLogs)
          .where(gte(llmUsageLogs.createdAt, today)),
        db
          .select({
            department: intakeRequests.department,
            n: sql<number>`count(*)`.mapWith(Number),
          })
          .from(intakeRequests)
          .groupBy(intakeRequests.department),
        db
          .select({ status: intakeRequests.status, n: sql<number>`count(*)`.mapWith(Number) })
          .from(intakeRequests)
          .groupBy(intakeRequests.status),
        db
          .select({
            ticketNo: intakeRequests.ticketNo,
            department: intakeRequests.department,
            amount: intakeRequests.amount,
            summary: intakeRequests.summary,
            status: intakeRequests.status,
            createdAt: intakeRequests.createdAt,
          })
          .from(intakeRequests)
          .orderBy(desc(intakeRequests.createdAt))
          .limit(8),
      ]);

    const firstPendingRows = await db
      .select({
        ticketNo: intakeRequests.ticketNo,
        department: intakeRequests.department,
        amount: intakeRequests.amount,
        summary: intakeRequests.summary,
      })
      .from(intakeRequests)
      .where(eq(intakeRequests.status, "待林总审批"))
      .orderBy(desc(intakeRequests.createdAt))
      .limit(1);

    // 近 7 日审批留痕趋势（JS 侧按天聚合，避免方言差异）
    const trendRows = await db
      .select({ createdAt: approvalAuditLogs.createdAt })
      .from(approvalAuditLogs)
      .where(gte(approvalAuditLogs.createdAt, new Date(today.getTime() - 6 * 86400000)));
    const approvalTrend: { label: string; value: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const day = new Date(today.getTime() - i * 86400000);
      const key = `${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      const n = trendRows.filter(
        (r) => new Date(r.createdAt).toDateString() === day.toDateString(),
      ).length;
      approvalTrend.push({ label: key, value: n });
    }

    return {
      pendingTotal: pendingRows[0]?.n ?? 0,
      approvedToday: approvedRows[0]?.n ?? 0,
      auditToday: auditRows[0]?.n ?? 0,
      usdToday: usageRows.reduce((s, r) => s + Number(r.usdCost || 0), 0),
      tokensInToday: usageRows.reduce((s, r) => s + r.inputTokens, 0),
      tokensOutToday: usageRows.reduce((s, r) => s + r.outputTokens, 0),
      deptCounts: deptRows.map((r) => ({ label: r.department, value: r.n })),
      statusCounts: statusRows.map((r) => ({ label: r.status, value: r.n })),
      approvalTrend,
      tickets: ticketRows.map((r) => ({
        ticketNo: r.ticketNo,
        department: r.department,
        amount: r.amount,
        summary: r.summary,
        status: r.status,
      })),
      firstPending: firstPendingRows[0] ?? null,
    };
  } catch (err: unknown) {
    console.error(
      "[generative-ui] 指标查询失败（降级为 0 值）：",
      err instanceof Error ? err.message : err,
    );
    return empty;
  }
}

/* ================= 二、布局组装（会打成 ```json 围栏文本走解析管线） ================= */

type PresetKey = "cfo" | "csd" | "ciso" | "zero" | "generic";

const PRESET_LABELS: Record<PresetKey, string> = {
  cfo: "CFO 晨会大屏",
  csd: "客服总监看板",
  ciso: "CISO 合规态势",
  zero: "0 数据边界测试",
  generic: "综合速览",
};

function classify(preset: string | undefined, question: string): PresetKey {
  if (preset === "cfo" || preset === "csd" || preset === "ciso" || preset === "zero") {
    return preset;
  }
  if (/0\s*数据|边界测试|全零/.test(question)) return "zero";
  if (/CFO|晨会|财务|审批|费用/.test(question)) return "cfo";
  if (/客服|客诉|投诉|总监/.test(question)) return "csd";
  if (/安全|合规|CISO|红区|审计/.test(question)) return "ciso";
  return "generic";
}

function buildLayout(
  preset: PresetKey,
  m: DashboardMetrics,
): { layout: GenuiLayoutItem[] } {
  /** @type {GenuiLayoutItem[]} */ const L: GenuiLayoutItem[] = [];
  const approvalId =
    m.firstPending?.ticketNo ?? `AP-DEMO-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-X`;

  if (preset === "zero") {
    // 0 数据边界测试：全部空数组 / 全零值，验证 Math.max(...,1) 兜底与空态渲染
    L.push(
      { component: "risk_banner", props: { level: "info", title: "0 数据边界测试", message: "所有数值为空或全零，验证图表兜底逻辑：空态正常渲染、无未定义数值、页面不白屏。", source: "Day 8 工程护栏" } },
      { component: "kpi_card", props: { label: "待审批工单", value: 0, unit: "笔", tone: "default" } },
      { component: "dept_bar_chart", props: { title: "各部门工单分布（空数据）", categories: [], values: [] } },
      { component: "trend_line_chart", props: { title: "近 7 日审批趋势（空数据）", labels: [], series: [] } },
      { component: "share_donut_chart", props: { title: "工单状态占比（全零）", slices: [{ label: "财务部", value: 0 }, { label: "运营部", value: 0 }] } },
      { component: "funnel_chart", props: { title: "客诉处理漏斗（空数据）", stages: [] } },
      { component: "ticket_table", props: { title: "工单明细（0 条）", rows: [] } },
      { component: "progress_bar", props: { label: "24 小时响应率", percent: 0, detail: "0 数据边界：进度条应为 0%" } },
      { component: "export_report_button", props: { label: "导出空报告 JSON" } },
    );
    return { layout: L };
  }

  if (preset === "cfo") {
    L.push(
      { component: "risk_banner", props: { level: m.pendingTotal > 0 ? "danger" : "info", title: "FIN-001 大额审批态势", message: `当前 ${m.pendingTotal} 笔工单待具名审批；单笔超过 ¥50,000 严禁 AI 放行，放行永远归人。`, source: "[DOC-01 §4.2] 财务付款审批制度" } },
      { component: "kpi_card", props: { label: "待审批工单", value: m.pendingTotal, unit: "笔", tone: m.pendingTotal > 0 ? "warn" : "good" } },
      { component: "kpi_card", props: { label: "今日已批准", value: m.approvedToday, unit: "笔", tone: "good" } },
      { component: "kpi_card", props: { label: "今日审计留痕", value: m.auditToday, unit: "条" } },
      { component: "cost_card", props: { provider: "全部厂商", model: "当日汇总", usdCost: m.usdToday, tokensIn: m.tokensInToday, tokensOut: m.tokensOutToday, note: "来自 llm_usage_logs 台账（只增不改）" } },
      { component: "dept_bar_chart", props: { title: "各部门工单分布", categories: m.deptCounts.map((d) => d.label), values: m.deptCounts.map((d) => d.value) } },
      { component: "trend_line_chart", props: { title: "近 7 日审批留痕趋势", labels: m.approvalTrend.map((t) => t.label), series: [{ name: "审批条数", values: m.approvalTrend.map((t) => t.value) }] } },
      { component: "share_donut_chart", props: { title: "工单状态占比", slices: m.statusCounts.map((s) => ({ label: s.label, value: s.value })) } },
      { component: "funnel_chart", props: { title: "客诉处理漏斗（示意）", stages: [{ label: "接诉", value: 12 }, { label: "响应", value: 8 }, { label: "方案", value: 5 }, { label: "闭环", value: 2 }] } },
      { component: "approval_form_card", props: { approvalId, tool: m.firstPending ? "tickets_approve" : "update_crm_profile", summary: m.firstPending ? `放行工单 ${m.firstPending.ticketNo}（${m.firstPending.department}，¥${m.firstPending.amount.toLocaleString("zh-CN")}）：${m.firstPending.summary}` : "示例审批单：将 CUST-8842 档案标记为疑似错账并挂 FIN-001 审批标记", approverDefault: "林总", ticketRef: m.firstPending?.ticketNo } },
      { component: "export_report_button", props: { label: "导出晨会报告 JSON" } },
    );
    return { layout: L };
  }

  if (preset === "csd") {
    L.push(
      { component: "risk_banner", props: { level: "warning", title: "客诉处理时效", message: "重大客诉须 24 小时内预约跨部门评审会，由具名负责人主持。", source: "[DOC-05 §5.2] 客诉分级与评审会制度" } },
      { component: "ticket_table", props: { title: "最新工单明细（数据库实读）", rows: m.tickets } },
      { component: "funnel_chart", props: { title: "客诉处理漏斗（示意）", stages: [{ label: "接诉", value: 12 }, { label: "响应", value: 8 }, { label: "方案", value: 5 }, { label: "闭环", value: 2 }] } },
      { component: "progress_bar", props: { label: "24 小时内响应率", percent: 92, detail: "超 24h 未响应的客诉自动升级至王主管" } },
      { component: "policy_citation_card", props: { citations: [{ docId: "DOC-05", section: "5.2", title: "客诉分级与评审会制度", snippet: "重大客诉（货损、超期叠加、赔偿诉求）须 24 小时内预约跨部门评审会，由具名负责人主持。" }, { docId: "DOC-04", section: "1.3", title: "跨境物流时效管理规范", snippet: "干线运输超过 5 天未入仓视为超期，须开立查验工单并向客户发出进度通报。" }] } },
      { component: "quick_filter_bar", props: { title: "客诉类型快捷筛选", options: ["物流超期", "货损", "赔偿诉求", "重复扣款"] } },
      { component: "export_report_button", props: { label: "导出客服周报 JSON" } },
    );
    return { layout: L };
  }

  if (preset === "ciso") {
    L.push(
      { component: "risk_banner", props: { level: "danger", title: "红区条款零容忍", message: "全站无自动打款能力；审计日志只增不改（数据库触发器物理拒绝 UPDATE/DELETE）；写操作强制 Dry-Run 预演。", source: "04 号文档 CISO 六项条款" } },
      { component: "comparison_matrix", props: { title: "三色权限边界矩阵", dimensions: ["业务数据", "资金动作", "审计日志", "不可信内容"], columns: ["🟢 绿区（AI 自主）", "🟡 黄区（起草+人确认）", "🔴 红区（物理不存在）"], cells: [["只读快照查询", "CRM 标记草稿", "直写正式数据"], ["额度校验 / 标记", "FIN-001 审批流起草", "自动打款 / 代签字"], ["追加留痕", "具名批准回写", "改删审计（触发器拒绝）"], ["包裹隔离标签", "上报不执行", "执行标签内指令"]] } },
      { component: "policy_citation_card", props: { citations: [{ docId: "DOC-01", section: "4.2", title: "财务付款审批制度（FIN-001）", snippet: "单笔金额超过 ¥50,000 的付款/退款，必须由具名在职审批人签字放行；AI 不得充当审批人。" }] } },
      { component: "progress_bar", props: { label: "审计留痕覆盖率", percent: 100, detail: "全过程留痕、只增不改、带时间戳与责任人编号" } },
      { component: "dry_run_confirm_card", props: { approvalId, tool: "update_crm_profile", title: "Dry-Run 预演：CRM 风险标记", summary: "黄区写操作强制预演：批准后真实写入 approval_audit_logs，正式数据由下游具名流程执行。", before: { riskFlag: "normal", fin001Flag: false }, after: { riskFlag: "duplicate_charge_suspected", fin001Flag: true } } },
      { component: "export_report_button", props: { label: "导出合规报告 JSON" } },
    );
    return { layout: L };
  }

  // generic
  L.push(
    { component: "kpi_card", props: { label: "待审批工单", value: m.pendingTotal, unit: "笔" } },
    { component: "kpi_card", props: { label: "今日审计留痕", value: m.auditToday, unit: "条" } },
    { component: "dept_bar_chart", props: { title: "各部门工单分布", categories: m.deptCounts.map((d) => d.label), values: m.deptCounts.map((d) => d.value) } },
    { component: "policy_citation_card", props: { citations: [{ docId: "DOC-01", section: "4.2", title: "财务付款审批制度（FIN-001）", snippet: "单笔金额超过 ¥50,000 的付款/退款，必须由具名在职审批人签字放行。" }] } },
    { component: "export_report_button", props: { label: "导出速览 JSON" } },
  );
  return { layout: L };
}

/* ================= 三、POST 入口 ================= */

interface GenUiRequestBody {
  mode: string;
  preset: string;
  question: string;
  sessionId: string;
}

export async function POST(request: Request): Promise<Response> {
  const raw: unknown = await request.json().catch(() => null);
  const body = (raw ?? {}) as Partial<GenUiRequestBody>;
  const mode = String(body.mode ?? "full");
  const sessionId = String(body.sessionId ?? "").slice(0, 64);

  const m = await loadMetrics();

  // metrics 模式：批准回写后立刻刷新大屏指标用（轻量返回）
  if (mode === "metrics") {
    const metricLayout: GenuiLayoutItem[] = [
      { component: "kpi_card", props: { label: "待审批工单", value: m.pendingTotal, unit: "笔", tone: m.pendingTotal > 0 ? "warn" : "good" } },
      { component: "kpi_card", props: { label: "今日已批准", value: m.approvedToday, unit: "笔", tone: "good" } },
      { component: "kpi_card", props: { label: "今日审计留痕", value: m.auditToday, unit: "条" } },
      { component: "cost_card", props: { provider: "全部厂商", model: "当日汇总", usdCost: m.usdToday, tokensIn: m.tokensInToday, tokensOut: m.tokensOutToday, note: "来自 llm_usage_logs 台账（只增不改）" } },
    ];
    const checked = parseLayoutFromModelText("```json\n" + JSON.stringify({ layout: metricLayout }) + "\n```");
    if (!checked.ok) {
      return NextResponse.json({ error: checked.error }, { status: 500 });
    }
    return NextResponse.json({ mode: "metrics", layout: checked.layout });
  }

  const preset = classify(body.preset, String(body.question ?? ""));
  // ①② 组装布局并包成 ```json 围栏文本（仿真大模型输出——模型只产 JSON，不产 HTML/JS）
  const modelText = "```json\n" + JSON.stringify({ layout: buildLayout(preset, m).layout }, null, 2) + "\n```";
  // ③④⑤ 剥围栏 → 白名单 → 逐组件校验 → 禁用模式扫描
  const parsed = parseLayoutFromModelText(modelText);
  if (!parsed.ok) {
    // 物理护栏：任何注入特征 / 未注册组件都会走到这里
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  return NextResponse.json({
    mode: "full",
    preset,
    presetLabel: PRESET_LABELS[preset],
    layout: parsed.layout,
    modelText,
    metricsNote: "指标来自数据库实时查询（intake_requests / approval_audit_logs / llm_usage_logs）",
    sessionId,
  });
}
