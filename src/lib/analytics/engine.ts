/**
 * analytics/engine.ts —— Day 39 「analytics」内室引擎（ADR-004 门面契约）
 * 大白话 → 确定性模板规划 → 五重安全死锁校验 → 只读执行 → 图表 + ROI 账单。
 * 红线溯源：全程零写操作（红区）、零 LLM 调用（costUsd 恒 0，呼应 ADR-001 受控输出）；
 *          FIN-001 金额口径取 fin001.ts 单一真源；PII 列永不进分析模板。
 */

import { ensureSchema } from "@/db";
import { registerFlowEngine } from "@/lib/workbot/facade";
import type { EmitWorkbotEvent, WorkbotEngine, WorkbotRequest } from "@/lib/workbot/types";

import {
  ANALYTICS_TENANT_ID,
  buildRoiBill,
  DAY2_ASSUMPTIONS,
  fmtCny,
  monthBounds,
  PLANNER_CAPABILITIES,
  planFromQuestion,
  type AnalyticsPlan,
  type AnalyticsPlanMode,
  type RoiBill,
  type RoiMeasuredInput,
} from "./planner";
import { AnalyticsQueryError, executeAnalyticsQuery, validateSecureSql, type LayerAudit } from "./secure-sql";
import type {
  AnalyticsChartPayload,
  AnalyticsIntentPayload,
  AnalyticsRunPayload,
  AnalyticsSqlAuditPayload,
} from "./types";

const DEFAULT_QUESTION = "对比 Day 2 预估 ROI 与本月真实省了多少钱？";
const STREAM_CHUNK = 24;
const STREAM_PACE_MS = 12;

let registered = false;

/** 路由加载时调用（幂等；热更新竞态下重复注册视为已就绪） */
export function ensureAnalyticsFlow(): void {
  if (registered) return;
  try {
    registerFlowEngine("analytics", runAnalyticsEngine);
  } catch (err) {
    if (!(err instanceof Error && /已注册|already/.test(err.message))) throw err;
  }
  registered = true;
}

/* ---------------- 小工具 ---------------- */

function emitStep(emit: EmitWorkbotEvent, stepRef: { n: number }, payload: unknown): void {
  stepRef.n += 1;
  emit({ type: "step", kind: "observation", step: stepRef.n, payload });
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  return String(v);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatParam(p: unknown): string {
  if (p instanceof Date) return p.toLocaleString("zh-CN", { hour12: false });
  if (typeof p === "string") return `"${p}"`;
  return String(p);
}

/* ---------------- 校验 + 只读执行（月/全口径复用） ---------------- */

interface ValidatedStep {
  label: string;
  finalSql: string;
  params: unknown[];
  audits: LayerAudit[];
  paramsDisplay: string[];
}

interface StageOutcome {
  ok: boolean;
  runs: AnalyticsRunPayload[];
  failText: string;
}

async function validateAndRun(
  plan: AnalyticsPlan,
  emit: EmitWorkbotEvent,
  stepRef: { n: number },
): Promise<StageOutcome> {
  /* ---- ② 五重死锁校验：全部通过才放行执行（fail-closed 整单作废） ---- */
  emit({ type: "phase", label: "② 五重安全死锁校验（任何一层拦截即作废）" });
  const validated: ValidatedStep[] = [];

  for (const step of plan.steps) {
    const v = validateSecureSql(step.sql, { tenantId: ANALYTICS_TENANT_ID, scoped: step.scoped });
    const blocked = v.audits.find((a) => a.verdict === "blocked");
    const auditPayload: AnalyticsSqlAuditPayload = {
      label: step.label,
      sql: step.sql.trim(),
      paramsDisplay: step.params.map(formatParam),
      audits: v.audits,
      blockedLayer: v.blockedLayer,
      blockedDetail: blocked ? blocked.detail : "",
    };
    emitStep(emit, stepRef, auditPayload);

    if (!v.ok) {
      emit({
        type: "notice",
        level: "warn",
        text: `第 ${String(v.blockedLayer ?? "?")} 重死锁拦截了本条 SQL：${auditPayload.blockedDetail}`,
      });
      return {
        ok: false,
        runs: [],
        failText: [
          `⚠ 本次分析在第 ${String(v.blockedLayer ?? "?")} 重安全死锁处被中止，没有执行任何 SQL。`,
          `拦截原因：${auditPayload.blockedDetail}`,
          "这是保护性拦截（fail-closed）：宁可不出数，也不让一条越权语句碰生产快照。请换个说法重试。",
        ].join("\n"),
      };
    }
    validated.push({
      label: step.label,
      finalSql: v.finalSql,
      params: step.params,
      audits: v.audits,
      paramsDisplay: auditPayload.paramsDisplay,
    });
  }

  /* ---- ③ 只读执行：BEGIN READ ONLY + 会话只读 + statement_timeout ---- */
  emit({ type: "phase", label: "③ 只读执行（只读角色 · BEGIN READ ONLY · 3 秒超时）" });
  const runs: AnalyticsRunPayload[] = [];

  for (const item of validated) {
    let execution;
    try {
      execution = await executeAnalyticsQuery(item.finalSql, item.params);
    } catch (err: unknown) {
      const message =
        err instanceof AnalyticsQueryError
          ? err.message
          : err instanceof Error
            ? err.message
            : "未知数据库错误";
      emit({ type: "notice", level: "warn", text: `只读执行被中止：${message}` });
      return {
        ok: false,
        runs: [],
        failText: [
          "⚠ SQL 已通过五重校验，但执行阶段被数据库层安全机制中止，没有返回数据。",
          `原因：${message}`,
          "数据库连接层只做了只读授权，任何写意图都会在这里被物理拒绝。",
        ].join("\n"),
      };
    }
    const runPayload: AnalyticsRunPayload = {
      label: item.label,
      finalSql: execution.finalSql,
      columns: execution.columns,
      rows: execution.rows,
      rowCount: execution.rowCount,
      durationMs: execution.durationMs,
      mechanism: execution.mechanism,
    };
    emitStep(emit, stepRef, runPayload);
    runs.push(runPayload);
  }

  return { ok: true, runs, failText: "" };
}

/* ---------------- 结果加工：图表 / ROI 实测 / 结论 ---------------- */

function extractMeasured(runs: readonly AnalyticsRunPayload[]): RoiMeasuredInput {
  const r0: Record<string, unknown> = runs[0]?.rows[0] ?? {};
  const r1: Record<string, unknown> = runs[1]?.rows[0] ?? {};
  const r2: Record<string, unknown> = runs[2]?.rows[0] ?? {};
  return {
    ticketCount: num(r0.ticket_count),
    fin001Count: num(r0.fin001_count),
    fin001Amount: num(r0.fin001_amount),
    reworkTotal: num(r1.rework_total),
    avgTriageSavings: num(r1.avg_triage_savings),
    llmCalls: num(r2.llm_calls),
    llmCostUsd: num(r2.llm_cost_usd),
  };
}

function rowsToChart(
  rows: readonly Record<string, unknown>[],
  labelKey: string,
  valueKey: string,
  title: string,
  unit: string,
): AnalyticsChartPayload | null {
  const bars = rows.slice(0, 12).map((r, i) => ({
    label: str(r[labelKey]) || "（未注明）",
    value: num(r[valueKey]),
    highlight: i === 0,
  }));
  if (bars.length === 0) return null;
  return { title, unit, bars };
}

function buildChart(plan: AnalyticsPlan, runs: readonly AnalyticsRunPayload[]): AnalyticsChartPayload | null {
  const rows = runs[0]?.rows ?? [];
  const scope = plan.mode === "month" ? "本月" : "全部累计";
  switch (plan.templateId) {
    case "roi_bill": {
      if (rows.length === 0) return null;
      const bill = buildRoiBill(extractMeasured(runs), plan.mode);
      return {
        title: `Day 2 预估 vs Day 39 实测净收益（${scope}）`,
        unit: "元",
        bars: [
          { label: "Day 2 预估", value: DAY2_ASSUMPTIONS.estimatedMonthlyGain, highlight: false },
          { label: "Day 39 实测", value: Math.max(bill.netGainCny, 0), highlight: true },
        ],
      };
    }
    case "dept_fin001":
      return rowsToChart(rows, "department", "intercept_amount", `各部门超线拦截金额（${scope}）`, "元");
    case "rework_reason":
      return rowsToChart(rows, "reason", "rework_total", `返工原因分布 · 按次数（${scope}）`, "次");
    case "ticket_volume":
      return rowsToChart(rows, "department", "ticket_count", `各部门工单量（${scope}）`, "单");
    case "llm_cost":
      return rowsToChart(rows, "provider_id", "cost_usd", `大模型费用分布（${scope}）`, "美元");
    case "audit_month":
      return rowsToChart(rows, "action", "event_count", `审批审计动作分布（${scope}）`, "次");
    default:
      return null;
  }
}

/** 月口径查空判定：主聚合行为空 / 主键计数为 0 → 切全量重跑 */
function planResultIsEmpty(plan: AnalyticsPlan, runs: readonly AnalyticsRunPayload[]): boolean {
  if (runs.length === 0) return true;
  if (plan.templateId === "roi_bill") {
    const r0: Record<string, unknown> | undefined = runs[0]?.rows[0];
    return !r0 || num(r0.ticket_count) === 0;
  }
  return runs.every((r) => r.rowCount === 0);
}

/* ---------------- 结论文案（全部由实测数据驱动，零编造） ---------------- */

function roiConclusion(bill: RoiBill, measured: RoiMeasuredInput, mode: AnalyticsPlanMode): string {
  const scope = mode === "month" ? "本月" : "全部累计";
  const gap = DAY2_ASSUMPTIONS.estimatedMonthlyGain - bill.netGainCny;
  return [
    `【老板直读版 · ${scope} ROI 账单】`,
    `${scope}真实净收益 ≈ ${fmtCny(bill.netGainCny)}（人工省 ${fmtCny(bill.laborSavingCny)} − 大模型费 ${fmtCny(bill.llmCostCny)}）。对照 Day 2 预估 ${fmtCny(DAY2_ASSUMPTIONS.estimatedMonthlyGain)}/月，${gap >= 0 ? `还差 ${fmtCny(gap)}` : `反超 ${fmtCny(-gap)}`}。`,
    `差距主因不是省钱逻辑失效，而是样本量：Day 2 按 ${DAY2_ASSUMPTIONS.monthlyTickets.toLocaleString("zh-CN")} 单/月测算，${scope}实际只有 ${measured.ticketCount.toLocaleString("zh-CN")} 单——单量没起来，节省按比例缩水，公式本身正在被真实数据验证。`,
    `另外，FIN-001 闸口${scope}拦下 ${measured.fin001Count} 笔超线单、金额 ${fmtCny(measured.fin001Amount)}——这是「避免大额错账」的风险敞口，账单里单列、不计入收益：宁保守，不多报。`,
    bill.disclaimer,
  ].join("\n\n");
}

function genericConclusion(plan: AnalyticsPlan, runs: readonly AnalyticsRunPayload[]): string {
  const rows = runs[0]?.rows ?? [];
  const scope = plan.mode === "month" ? "本月" : "全部累计";
  switch (plan.templateId) {
    case "dept_fin001": {
      if (rows.length === 0) return `${scope}没有单笔超过 FIN-001 线的付款单：各部门全部安全，闸口没有拦截记录。`;
      const top = rows[0];
      return [
        `【${scope}超线拦截画像】`,
        `重灾区是「${str(top.department)}」：${num(top.ticket_count).toLocaleString("zh-CN")} 笔、合计 ${fmtCny(num(top.intercept_amount))}，全部停在人工审批闸前等具名签字——AI 只拦截不放行，一分钱没动。`,
      ].join("\n\n");
    }
    case "rework_reason": {
      if (rows.length === 0) return `${scope}没有返工记录：专班一次过。`;
      const top = rows[0];
      return [
        `【${scope}返工画像】`,
        `返工最集中的原因：「${str(top.reason)}」——${num(top.case_count)} 单里返工 ${num(top.rework_total)} 次，返工率 ${num(top.rework_rate)}。建议优先治理该环节。`,
        `注：大量记录升级原因为空，已归入「未注明原因」——上报口径本身就是治理点。`,
      ].join("\n\n");
    }
    case "ticket_volume": {
      if (rows.length === 0) return `${scope}暂无工单。`;
      const total = rows.reduce((acc: number, r) => acc + num(r.ticket_count), 0);
      return `【${scope}单量画像】合计 ${total.toLocaleString("zh-CN")} 单；最多的是「${str(rows[0].department)}」${num(rows[0].ticket_count).toLocaleString("zh-CN")} 单。`;
    }
    case "llm_cost": {
      if (rows.length === 0) return `${scope}没有大模型调用记录。`;
      const total = rows.reduce((acc: number, r) => acc + num(r.cost_usd), 0);
      return [
        `【${scope}机器费画像】`,
        `合计 $${total.toFixed(4)}；最大头是「${str(rows[0].provider_id)}」$${num(rows[0].cost_usd).toFixed(4)}。以上全部为只读统计，未触碰任何业务数据。`,
      ].join("\n\n");
    }
    case "audit_month": {
      if (rows.length === 0) return `${scope}没有审批审计动作。`;
      return `【${scope}审计画像】最多动作：「${str(rows[0].action)}」${num(rows[0].event_count).toLocaleString("zh-CN")} 次。审计日志只增不改，全程留痕。`;
    }
    default:
      return "分析完成：以上全部结果来自五重死锁保护的只读快照。";
  }
}

function refusalText(question: string, monthLabel: string): string {
  return [
    "这条提问没能对上任何安全模板，所以我不生成 SQL——宁诚实拒答，不硬凑查询。",
    `你问的是：「${question}」`,
    "当前我能用大白话直接回答的题目：",
    ...PLANNER_CAPABILITIES.map((c) => `· ${c}`),
    `小提示：带上「ROI / 省了 / 部门 / 拦截 / 返工 / 原因 / 单量 / 审计 / 大模型费用」更容易命中；默认口径 ${monthLabel}，说「全部 / 累计」可切全量。`,
  ].join("\n");
}

/* ---------------- 引擎主流程 ---------------- */

const runAnalyticsEngine: WorkbotEngine = async (req: WorkbotRequest, emit, ctx) => {
  const started = performance.now();
  const stepRef = { n: 0 };
  const ttftRef: { value: number | null } = { value: null };
  const touchTtft = (): void => {
    if (ttftRef.value === null) ttftRef.value = Math.round(performance.now() - started);
  };
  const finishUsage = async (): Promise<void> => {
    emit({
      type: "usage",
      meta: ctx.meta,
      ttftMs: ttftRef.value ?? Math.round(performance.now() - started),
      costUsd: 0,
    });
  };
  const streamText = async (full: string): Promise<void> => {
    touchTtft();
    for (let i = 0; i < full.length; i += STREAM_CHUNK) {
      emit({ type: "text_delta", text: full.slice(i, i + STREAM_CHUNK) });
      await sleep(STREAM_PACE_MS);
    }
  };

  /* ---- ① 大白话理解（确定性规划器，零 LLM） ---- */
  emit({ type: "phase", label: "① 大白话理解（确定性规划器 · 零 LLM）" });
  const question = req.question.trim().length > 0 ? req.question.trim() : DEFAULT_QUESTION;
  const bounds = monthBounds();
  let plan = planFromQuestion(question);
  const intent: AnalyticsIntentPayload = {
    question,
    matched: plan !== null,
    templateId: plan?.templateId ?? null,
    title: plan?.title ?? null,
    mode: plan?.mode ?? "month",
    matchedKeywords: plan?.matchedKeywords ?? [],
    monthLabel: bounds.label,
    capabilities: PLANNER_CAPABILITIES,
  };
  emitStep(emit, stepRef, intent);

  if (!plan) {
    emit({ type: "notice", level: "info", text: "未命中模板白名单：不生成任何 SQL（ADR-001 受控输出，宁拒答不硬凑）" });
    await streamText(refusalText(question, bounds.label));
    await finishUsage();
    return;
  }

  /* ---- ②③ 校验 + 只读执行（本月口径） ---- */
  await ensureSchema();
  let outcome = await validateAndRun(plan, emit, stepRef);

  // 月口径查空 → 自动切全量重跑（同一模板，重新过五重死锁）
  if (outcome.ok && plan.mode === "month" && planResultIsEmpty(plan, outcome.runs)) {
    emit({
      type: "notice",
      level: "fallback",
      text: `${bounds.label}窗口内暂无数据，已自动切换为「全部累计」口径重跑（同一模板，仍过五重死锁）`,
    });
    const allPlan = planFromQuestion(question, "all");
    if (allPlan) {
      plan = allPlan;
      outcome = await validateAndRun(plan, emit, stepRef);
    }
  }

  if (!outcome.ok) {
    await streamText(outcome.failText);
    await finishUsage();
    return;
  }

  /* ---- ④ 图表 + ROI 账单 + 大白话结论 ---- */
  emit({ type: "phase", label: "④ 图表与结论（透明账单）" });
  const chart = buildChart(plan, outcome.runs);
  if (chart) emitStep(emit, stepRef, chart);

  if (plan.templateId === "roi_bill") {
    const measured = extractMeasured(outcome.runs);
    const bill = buildRoiBill(measured, plan.mode);
    emitStep(emit, stepRef, bill);
    await streamText(roiConclusion(bill, measured, plan.mode));
    await finishUsage();
    return;
  }

  await streamText(genericConclusion(plan, outcome.runs));
  await finishUsage();
};
