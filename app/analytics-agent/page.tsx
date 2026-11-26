"use client";

/**
 * /analytics-agent —— Day 39 五重死锁只读 SQL 分析代理与 ROI 账单
 * 交互纪律（AGENTS.md）：中文大白话、全程只读、无任何打款/写库按钮；
 * 透明展示：生成的安全 SQL + 五重死锁逐层裁决 + 只读执行结果 + 图表 + Day 2 假设 vs Day 39 实测 ROI 账单。
 */

import { useRef, useState } from "react";

import type {
  AnalyticsChartPayload,
  AnalyticsIntentPayload,
  AnalyticsRoiPayload,
  AnalyticsRunPayload,
  AnalyticsSqlAuditPayload,
  LayerAudit,
  SelfcheckResult,
} from "@/lib/analytics/types";
import type { WorkbotSseEvent } from "@/lib/workbot/types";

interface NoticeItem {
  level: "info" | "warn" | "fallback";
  text: string;
}

interface UsageInfo {
  ttftMs: number;
  costUsd: number;
}

const PRESET_QUESTIONS = [
  "对比 Day 2 预估 ROI 与本月真实省了多少钱？",
  "统计各部门超 5 万拦截总金额",
  "列出本月返工率最高的原因",
] as const;

const LAYER_BRIEFS = [
  { n: 1, text: "仅限 SELECT · 表白名单 · 危险函数黑名单" },
  { n: 2, text: "禁多语句分号 · 禁 DROP/DELETE/UPDATE/INSERT" },
  { n: 3, text: "强制 tenant_id 租户隔离（服务端注入）" },
  { n: 4, text: "强制 LIMIT 100 · 3 秒查询超时" },
  { n: 5, text: "连接层只读角色兜底 · BEGIN READ ONLY" },
] as const;

/** 常见列名中文化（分析代理结果表用） */
const COLUMN_LABELS: Record<string, string> = {
  department: "部门",
  ticket_count: "单数",
  intercept_amount: "拦截金额（元）",
  total_amount: "总金额（元）",
  reason: "原因",
  case_count: "单数",
  rework_total: "返工次数",
  rework_rate: "返工率",
  trace_count: "专班运行数",
  avg_triage_savings: "平均分流（%）",
  llm_calls: "调用次数",
  llm_cost_usd: "费用（美元）",
  provider_count: "供应商数",
  provider_id: "供应商",
  cost_usd: "费用（美元）",
  call_count: "调用次数",
  action: "审计动作",
  event_count: "次数",
};

function hasShape(p: unknown, keys: readonly string[]): boolean {
  return typeof p === "object" && p !== null && keys.every((k) => k in p);
}

function fmtCell(v: unknown): string {
  if (typeof v === "number") {
    return Number.isInteger(v)
      ? v.toLocaleString("zh-CN")
      : v.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
  }
  if (v == null || v === "") return "—";
  return String(v);
}

function verdictStyle(verdict: LayerAudit["verdict"]): string {
  switch (verdict) {
    case "pass":
      return "bg-emerald-50 text-emerald-700";
    case "enforced":
      return "bg-sky-50 text-sky-700";
    case "clamped":
      return "bg-amber-50 text-amber-700";
    case "blocked":
      return "bg-rose-100 text-rose-700";
  }
}

function verdictLabel(verdict: LayerAudit["verdict"]): string {
  switch (verdict) {
    case "pass":
      return "通过";
    case "enforced":
      return "强制";
    case "clamped":
      return "钳制";
    case "blocked":
      return "拦截";
  }
}

/* ---------------- 展示小组件 ---------------- */

function SqlAuditCard({ payload }: { payload: AnalyticsSqlAuditPayload }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold text-zinc-800">{payload.label}</p>
        {payload.blockedLayer !== null ? (
          <span className="rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-bold text-rose-700">
            第 {payload.blockedLayer} 重拦截 · 整条作废
          </span>
        ) : (
          <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-700">
            五重校验通过 · 放行
          </span>
        )}
      </div>
      <pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-950 p-3 text-xs leading-5 text-zinc-100">
        {payload.sql}
      </pre>
      {payload.paramsDisplay.length > 0 && (
        <p className="mt-1.5 text-xs text-zinc-500">
          绑定参数（占位符 $1..$n，租户值由服务端注入，客户端不可影响）：
          <span className="ml-1 font-mono text-zinc-700">{payload.paramsDisplay.join(" · ")}</span>
        </p>
      )}
      <div className="mt-3 space-y-1.5">
        {payload.audits.map((a) => (
          <div key={a.layer} className="flex flex-col gap-1 rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2 sm:flex-row sm:items-start sm:gap-2">
            <span className={`w-fit shrink-0 rounded-md px-2 py-0.5 text-xs font-bold ${verdictStyle(a.verdict)}`}>
              第 {a.layer} 重 · {verdictLabel(a.verdict)}
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-zinc-700">{a.title}</p>
              <p className="text-xs leading-5 text-zinc-500">{a.detail}</p>
            </div>
          </div>
        ))}
      </div>
      {payload.blockedDetail !== "" && (
        <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
          拦截原因：{payload.blockedDetail}
        </p>
      )}
    </div>
  );
}

function RunCard({ payload }: { payload: AnalyticsRunPayload }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold text-zinc-800">{payload.label}</p>
        <span className="rounded-full bg-sky-50 px-2.5 py-0.5 text-xs font-semibold text-sky-700">
          {payload.rowCount} 行 · {payload.durationMs}ms · 只读执行
        </span>
      </div>
      <pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-950 p-3 text-xs leading-5 text-emerald-200">
        {payload.finalSql}
      </pre>
      <p className="mt-1.5 text-xs text-zinc-500">执行通道：{payload.mechanism}</p>
      {payload.rows.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[420px] text-xs">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-zinc-500">
                {payload.columns.map((c) => (
                  <th key={c} className="whitespace-nowrap px-2 py-1.5 font-semibold">
                    {COLUMN_LABELS[c] ?? c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {payload.rows.map((row, i) => (
                <tr key={i} className="border-b border-zinc-100">
                  {payload.columns.map((c) => (
                    <td key={c} className="whitespace-nowrap px-2 py-1.5 tabular-nums text-zinc-700">
                      {fmtCell(row[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BarChart({ chart }: { chart: AnalyticsChartPayload }) {
  const max = Math.max(...chart.bars.map((b) => Math.abs(b.value)), 1);
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <p className="text-sm font-bold text-zinc-800">
        {chart.title}
        <span className="ml-2 text-xs font-normal text-zinc-500">单位：{chart.unit}</span>
      </p>
      <div className="mt-3 space-y-2">
        {chart.bars.map((b) => (
          <div key={b.label} className="flex items-center gap-2">
            <span className="w-40 shrink-0 truncate text-xs text-zinc-600" title={b.label}>
              {b.label}
            </span>
            <div className="h-5 min-w-0 flex-1 rounded bg-zinc-100">
              <div
                className={`h-5 rounded ${b.highlight ? "bg-emerald-500" : "bg-zinc-400"}`}
                style={{ width: `${Math.max((Math.abs(b.value) / max) * 100, 1)}%` }}
              />
            </div>
            <span className="w-28 shrink-0 text-right text-xs tabular-nums text-zinc-700">
              {b.value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RoiBillTable({ bill }: { bill: AnalyticsRoiPayload }) {
  const toneStyle: Record<AnalyticsRoiPayload["rows"][number]["tone"], string> = {
    estimate: "text-zinc-600",
    measured: "text-emerald-700",
    risk: "text-amber-700",
    total: "font-bold text-zinc-900",
  };
  return (
    <div className="rounded-xl border-2 border-zinc-900 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold text-zinc-900">硬核 ROI 账单：Day 2 假设 vs Day 39 实测</p>
        <span className="rounded-full bg-zinc-900 px-2.5 py-0.5 text-xs font-bold text-white">透明账单</span>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[640px] text-xs">
          <thead>
            <tr className="border-b-2 border-zinc-300 text-left text-zinc-500">
              <th className="px-2 py-2 font-semibold">项目</th>
              <th className="px-2 py-2 font-semibold">Day 2 假设（预估）</th>
              <th className="px-2 py-2 font-semibold">Day 39 实测（真实快照）</th>
              <th className="px-2 py-2 font-semibold">数据来源</th>
            </tr>
          </thead>
          <tbody>
            {bill.rows.map((r) => (
              <tr key={r.item} className={`border-b border-zinc-100 ${r.tone === "total" ? "bg-zinc-50" : ""}`}>
                <td className="px-2 py-2 font-semibold text-zinc-800">{r.item}</td>
                <td className="px-2 py-2 leading-5 text-zinc-500">{r.day2}</td>
                <td className={`px-2 py-2 leading-5 ${toneStyle[r.tone]}`}>{r.day39}</td>
                <td className="whitespace-nowrap px-2 py-2 text-zinc-400">{r.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">{bill.disclaimer}</p>
    </div>
  );
}

/* ---------------- 主页面 ---------------- */

export default function AnalyticsAgentPage() {
  const [question, setQuestion] = useState<string>(PRESET_QUESTIONS[0]);
  const [running, setRunning] = useState(false);
  const [phases, setPhases] = useState<string[]>([]);
  const [notices, setNotices] = useState<NoticeItem[]>([]);
  const [intent, setIntent] = useState<AnalyticsIntentPayload | null>(null);
  const [sqlAudits, setSqlAudits] = useState<AnalyticsSqlAuditPayload[]>([]);
  const [runs, setRuns] = useState<AnalyticsRunPayload[]>([]);
  const [chart, setChart] = useState<AnalyticsChartPayload | null>(null);
  const [roi, setRoi] = useState<AnalyticsRoiPayload | null>(null);
  const [aiText, setAiText] = useState("");
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [selfcheck, setSelfcheck] = useState<SelfcheckResult | null>(null);
  const [selfcheckRunning, setSelfcheckRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  function stop(): void {
    abortRef.current?.abort();
    setRunning(false);
    setNotices((prev) => [
      ...prev,
      { level: "fallback", text: "已切断本次分析（Kill Switch 纪律：5 秒内可断，日志保留）。" },
    ]);
  }

  async function run(q: string): Promise<void> {
    if (running) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setPhases([]);
    setNotices([]);
    setIntent(null);
    setSqlAudits([]);
    setRuns([]);
    setChart(null);
    setRoi(null);
    setAiText("");
    setUsage(null);

    try {
      const res = await fetch("/api/analytics-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const errText = await res.text();
        throw new Error(errText.slice(0, 200) || `HTTP ${String(res.status)}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const event = JSON.parse(line.slice(6)) as WorkbotSseEvent;
          if (event.type === "phase") {
            setPhases((prev) => [...prev, event.label]);
          } else if (event.type === "step") {
            const p: unknown = event.payload;
            if (hasShape(p, ["matched", "capabilities"])) setIntent(p as AnalyticsIntentPayload);
            else if (hasShape(p, ["audits", "blockedLayer"])) setSqlAudits((prev) => [...prev, p as AnalyticsSqlAuditPayload]);
            else if (hasShape(p, ["mechanism", "rowCount"])) setRuns((prev) => [...prev, p as AnalyticsRunPayload]);
            else if (hasShape(p, ["bars", "unit"])) setChart(p as AnalyticsChartPayload);
            else if (hasShape(p, ["netGainCny", "disclaimer"])) setRoi(p as AnalyticsRoiPayload);
          } else if (event.type === "notice") {
            setNotices((prev) => [...prev, { level: event.level, text: event.text }]);
          } else if (event.type === "text_delta") {
            setAiText((prev) => prev + event.text);
          } else if (event.type === "usage") {
            setUsage({ ttftMs: event.ttftMs, costUsd: event.costUsd });
          } else if (event.type === "done") {
            setRunning(false);
          }
        }
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setNotices((prev) => [...prev, { level: "fallback", text: `分析中断：${err instanceof Error ? err.message : "未知错误"}` }]);
      }
    } finally {
      setRunning(false);
    }
  }

  async function runSelfcheck(): Promise<void> {
    if (selfcheckRunning) return;
    setSelfcheckRunning(true);
    try {
      const res = await fetch("/api/analytics-agent/selfcheck", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
      setSelfcheck((await res.json()) as SelfcheckResult);
    } catch (err) {
      setNotices((prev) => [...prev, { level: "fallback", text: `自检失败：${err instanceof Error ? err.message : "未知错误"}` }]);
    } finally {
      setSelfcheckRunning(false);
    }
  }

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-4 pb-16 pt-6 sm:px-6">
      {/* 标题区 */}
      <div className="mb-5">
        <p className="text-xs font-semibold tracking-widest text-zinc-400">DAY 39 · 五重死锁只读 SQL 分析代理与 ROI 账单</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-zinc-900">ROI 分析代理</h1>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-zinc-600">
          老板用大白话提问，代理<b>只查不说</b>：确定性规划器把问题翻译成白名单 SQL，过五重安全死锁再进只读通道执行；
          回答全程透明——SQL、逐层裁决、图表、以及「Day 2 假设 vs Day 39 实测」的硬核 ROI 账单全部摆上台面。
          <b className="ml-1 text-zinc-800">全程零写库、零打款、零大模型费用。</b>
        </p>
        <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-5">
          {LAYER_BRIEFS.map((l) => (
            <div key={l.n} className="rounded-lg border border-zinc-200 bg-white px-3 py-2">
              <p className="text-xs font-bold text-zinc-800">第 {l.n} 重</p>
              <p className="text-xs leading-4 text-zinc-500">{l.text}</p>
            </div>
          ))}
        </div>
      </div>

      {/* 提问区 */}
      <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
        <label className="text-sm font-semibold text-zinc-700" htmlFor="analytics-question">
          用大白话提问（只会命中安全模板，命中不了就诚实拒答，绝不硬凑 SQL）
        </label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            id="analytics-question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !running) void run(question);
            }}
            placeholder="例如：这个月 AI 到底帮公司省了多少钱？"
            className="min-w-0 flex-1 rounded-xl border border-zinc-300 px-4 py-2.5 text-sm text-zinc-800 outline-none focus:border-zinc-900"
          />
          <button
            onClick={() => void run(question)}
            disabled={running || question.trim() === ""}
            className="shrink-0 rounded-xl bg-zinc-900 px-6 py-2.5 text-sm font-bold text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {running ? "分析中…" : "开始分析"}
          </button>
          {running && (
            <button
              onClick={stop}
              className="shrink-0 rounded-xl border border-rose-300 bg-white px-4 py-2.5 text-sm font-bold text-rose-600 hover:bg-rose-50"
            >
              停止
            </button>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {PRESET_QUESTIONS.map((q) => (
            <button
              key={q}
              onClick={() => {
                setQuestion(q);
                void run(q);
              }}
              disabled={running}
              className="rounded-full border border-zinc-300 bg-zinc-50 px-3.5 py-1.5 text-xs font-semibold text-zinc-700 transition-colors hover:border-zinc-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {q}
            </button>
          ))}
        </div>
      </div>

      {/* 阶段进度 */}
      {phases.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {phases.map((p, i) => (
            <span key={`${String(i)}-${p}`} className="rounded-full bg-zinc-900 px-3 py-1 text-xs font-semibold text-white">
              {p}
            </span>
          ))}
        </div>
      )}

      {/* 告警 */}
      {notices.length > 0 && (
        <div className="mt-4 space-y-2">
          {notices.map((n, i) => (
            <div
              key={i}
              className={`rounded-xl border px-4 py-2.5 text-sm leading-6 ${
                n.level === "warn"
                  ? "border-rose-200 bg-rose-50 text-rose-800"
                  : n.level === "fallback"
                    ? "border-amber-200 bg-amber-50 text-amber-800"
                    : "border-zinc-200 bg-zinc-50 text-zinc-700"
              }`}
            >
              {n.text}
            </div>
          ))}
        </div>
      )}

      {/* ① 意图理解 */}
      {intent && (
        <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-4">
          <p className="text-sm font-bold text-zinc-800">① 大白话理解</p>
          {intent.matched ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 font-bold text-emerald-700">
                命中模板：{intent.title}
              </span>
              <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 font-semibold text-zinc-700">
                口径：{intent.mode === "month" ? intent.monthLabel : "全部累计"}
              </span>
              {intent.matchedKeywords.length > 0 && (
                <span className="text-zinc-500">命中关键词：{intent.matchedKeywords.join("、")}</span>
              )}
            </div>
          ) : (
            <p className="mt-2 text-xs font-semibold text-amber-700">
              未命中任何安全模板 → 拒绝生成 SQL（诚实拒答，见下方能力清单）
            </p>
          )}
        </div>
      )}

      {/* ② SQL 审计卡 */}
      {sqlAudits.length > 0 && (
        <div className="mt-4 space-y-3">
          <p className="text-sm font-bold text-zinc-800">② 生成的安全 SQL 与五重死锁逐层裁决</p>
          {sqlAudits.map((a, i) => (
            <SqlAuditCard key={i} payload={a} />
          ))}
        </div>
      )}

      {/* ③ 只读执行结果 */}
      {runs.length > 0 && (
        <div className="mt-4 space-y-3">
          <p className="text-sm font-bold text-zinc-800">③ 只读执行结果（只读通道，生产数据零改动）</p>
          {runs.map((r, i) => (
            <RunCard key={i} payload={r} />
          ))}
        </div>
      )}

      {/* ④ 图表 */}
      {chart && (
        <div className="mt-4">
          <p className="mb-2 text-sm font-bold text-zinc-800">④ 可视化图表</p>
          <BarChart chart={chart} />
        </div>
      )}

      {/* ④ ROI 账单 */}
      {roi && (
        <div className="mt-4">
          <RoiBillTable bill={roi} />
        </div>
      )}

      {/* 结论 */}
      {aiText !== "" && (
        <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-4">
          <p className="text-sm font-bold text-zinc-800">结论（大白话）</p>
          <div className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-700">{aiText}</div>
          {usage && (
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <span className="rounded-full bg-zinc-100 px-2.5 py-1 font-semibold text-zinc-700">
                首字延迟 {usage.ttftMs}ms
              </span>
              <span className="rounded-full bg-emerald-50 px-2.5 py-1 font-semibold text-emerald-700">
                大模型费用 $0.00（确定性规划器，零 LLM 调用）
              </span>
            </div>
          )}
        </div>
      )}

      {/* 未命中时的能力清单 */}
      {intent && !intent.matched && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-bold text-amber-800">当前我能直接回答的题目（安全模板白名单）</p>
          <ul className="mt-2 list-inside list-disc text-sm leading-6 text-amber-900">
            {intent.capabilities.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 护栏自检 */}
      <div className="mt-8 rounded-2xl border border-zinc-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-bold text-zinc-800">安全护栏自检（不执行，只验证校验器）</p>
            <p className="mt-0.5 text-xs text-zinc-500">
              6 条攻击/合法样本逐条过五重校验器：5 条攻击应被对应层拦截，合法样本五层全过。
            </p>
          </div>
          <button
            onClick={() => void runSelfcheck()}
            disabled={selfcheckRunning}
            className="shrink-0 rounded-xl border border-zinc-900 bg-white px-5 py-2 text-sm font-bold text-zinc-900 transition-colors hover:bg-zinc-900 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {selfcheckRunning ? "自检中…" : "运行护栏自检"}
          </button>
        </div>

        {selfcheck && (
          <div className="mt-4 space-y-3">
            {selfcheck.samples.map((s) => {
              const clamped = s.ok && s.audits.some((a) => a.verdict === "clamped");
              const cardTone = !s.ok
                ? "border-rose-200 bg-rose-50/50"
                : clamped
                  ? "border-amber-200 bg-amber-50/50"
                  : "border-emerald-200 bg-emerald-50/50";
              const badgeTone = !s.ok ? "bg-rose-100 text-rose-700" : clamped ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700";
              return (
              <div key={s.name} className={`rounded-xl border p-3 ${cardTone}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-bold text-zinc-800">{s.name}</p>
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${badgeTone}`}>{s.verdictText}</span>
                </div>
                <p className="mt-1 text-xs text-zinc-500">预期：{s.expect}</p>
                <pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-950 p-2.5 text-xs leading-5 text-zinc-100">
                  {s.sql}
                </pre>
                {clamped && (
                  <pre className="mt-1.5 overflow-x-auto rounded-lg bg-zinc-950 p-2.5 text-xs leading-5 text-emerald-200">
                    钳制后：{s.finalSql}
                  </pre>
                )}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {s.audits.map((a) => (
                    <span key={a.layer} className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${verdictStyle(a.verdict)}`}>
                      {a.layer}:{verdictLabel(a.verdict)}
                    </span>
                  ))}
                </div>
              </div>
              );
            })}
            <div className="rounded-xl border border-sky-200 bg-sky-50 p-3">
              <p className="text-sm font-bold text-sky-900">
                第⑤重现状：{selfcheck.roleActive ? "专用只读角色已生效" : "降级兜底模式"}
              </p>
              <p className="mt-1 text-xs leading-5 text-sky-800">{selfcheck.mechanism}</p>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
