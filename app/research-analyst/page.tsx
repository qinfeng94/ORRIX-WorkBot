"use client";

/**
 * /research-analyst —— Day 15 企业尽调与研究分析台
 * 溯源：AGENTS.md 业务红线（全程只读 / 结论强制证据链 / 无任何打款按钮）；
 *      三阶段编排全程直播：查 ACL 知识库 → 抓沙盒老 ERP → 交叉核对异常单据；
 *      自愈容错可视化：告警、重试、降级缓存全部实时上屏，绝不中途崩溃。
 * 红区承诺：本台无任何「自动打款/付款/放款」按钮；超 ¥50,000 事项一律转 FIN-001 强制人工审批。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { PhaseId, ResearchReport, SourceAlert } from "@/lib/research-analyst/engine";

/* ---------------- 编排可视化状态 ---------------- */

interface SourceView {
  label: string;
  status: "running" | "ok" | "degraded" | "empty";
  summary: string;
  alertsCount: number;
}

interface ArchiveSummary {
  id: number;
  reportId: string;
  topic: string;
  overallScore: number;
  overallLevel: string;
  fin001Gaps: number;
  alertsCount: number;
  degradedSources: string;
  archivedBy: string;
  createdAt: string;
}

const PHASE_ORDER: PhaseId[] = ["acl_kb", "erp_history", "cross_check"];

const PRESET_TOPICS = [
  "评估华东区 3 家物流供应商的异常赔付风险与合规缺口",
  "核查 CUST-8842 重复扣款事件的赔付合规与审批缺口",
  "复盘双 11 大促期间华东区运力保障与超期赔付风险",
];

const PHASE_NAMES: Record<PhaseId, string> = {
  acl_kb: "① 查内部 52 档 ACL 知识库",
  erp_history: "② 抓沙盒老 ERP 历史记录",
  cross_check: "③ 交叉核对异常单据",
};

const LEVEL_STYLE: Record<string, string> = {
  高: "bg-red-600",
  中: "bg-amber-500",
  低: "bg-emerald-600",
};

const LEVEL_TEXT: Record<string, string> = {
  高: "text-red-700",
  中: "text-amber-700",
  低: "text-emerald-700",
};

const PRIORITY_STYLE: Record<string, string> = {
  P1: "bg-red-600 text-white",
  P2: "bg-amber-500 text-white",
  P3: "bg-zinc-500 text-white",
};

function scoreColor(score: number): string {
  return score >= 60 ? "bg-red-500" : score >= 30 ? "bg-amber-500" : "bg-emerald-500";
}

/* ---------------- 单源状态胶囊 ---------------- */

function SourcePill({ s }: { s: SourceView }): React.ReactElement {
  const text =
    s.status === "running"
      ? "查询中…"
      : s.status === "ok"
        ? "已完成"
        : s.status === "degraded"
          ? "已降级"
          : "无数据";
  const cls =
    s.status === "running"
      ? "bg-blue-600"
      : s.status === "ok"
        ? "bg-emerald-600"
        : s.status === "degraded"
          ? "bg-amber-500"
          : "bg-zinc-400";
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold text-white ${cls}`}>
      {text}
      {s.alertsCount > 0 && (
        <span className="rounded bg-white/25 px-1">告警 {String(s.alertsCount)}</span>
      )}
    </span>
  );
}

/* ---------------- 页面 ---------------- */

export default function ResearchAnalystPage(): React.ReactElement {
  const [topic, setTopic] = useState(PRESET_TOPICS[0]);
  const [simulateFaults, setSimulateFaults] = useState(false);
  const [running, setRunning] = useState(false);
  const [phaseStatus, setPhaseStatus] = useState<Partial<Record<PhaseId, { started: boolean; done: boolean; summary: string }>>>({});
  const [sources, setSources] = useState<Record<string, SourceView>>({});
  const [alerts, setAlerts] = useState<SourceAlert[]>([]);
  const [narrative, setNarrative] = useState("");
  const [report, setReport] = useState<ResearchReport | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState("");
  const [archiveMsg, setArchiveMsg] = useState("");
  const [archives, setArchives] = useState<ArchiveSummary[]>([]);
  const liveRef = useRef(true);

  const loadArchives = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/research-analyst/archive", { cache: "no-store" });
      const data: unknown = await res.json();
      if (data && typeof data === "object" && Array.isArray((data as { archives?: unknown }).archives)) {
        setArchives((data as { archives: ArchiveSummary[] }).archives);
      }
    } catch {
      // 清单读取失败不阻塞页面（本地未接库时静默降级）
    }
  }, []);

  useEffect(() => {
    void loadArchives();
  }, [loadArchives]);

  const upsertSource = useCallback((key: string, patch: Partial<SourceView>): void => {
    setSources((prev) => ({
      ...prev,
      [key]: {
        label: patch.label ?? prev[key]?.label ?? key,
        status: patch.status ?? prev[key]?.status ?? "running",
        summary: patch.summary ?? prev[key]?.summary ?? "",
        alertsCount: patch.alertsCount ?? prev[key]?.alertsCount ?? 0,
      },
    }));
  }, []);

  const startResearch = useCallback(async (): Promise<void> => {
    const t = topic.trim();
    if (t.length === 0 || running) return;
    setRunning(true);
    setError("");
    setArchiveMsg("");
    setNarrative("");
    setReport(null);
    setAlerts([]);
    setElapsedMs(0);
    setPhaseStatus({});
    setSources({});
    liveRef.current = true;

    try {
      const res = await fetch("/api/research-analyst", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: t,
          simulateFaults,
          sessionId: `ra-${Date.now()}`,
        }),
      });
      if (!res.ok || res.body === null) {
        const errData: unknown = await res.json().catch(() => null);
        throw new Error(
          errData && typeof errData === "object" && "error" in errData
            ? String((errData as { error?: unknown }).error)
            : `接口返回 ${String(res.status)}`,
        );
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
          } catch {
            continue;
          }
          switch (event.type) {
            case "phase_start":
              setPhaseStatus((prev) => ({
                ...prev,
                [String(event.phase)]: { started: true, done: false, summary: "" },
              }));
              break;
            case "phase_done":
              setPhaseStatus((prev) => ({
                ...prev,
                [String(event.phase)]: { started: true, done: true, summary: String(event.summary ?? "") },
              }));
              break;
            case "source_start":
              upsertSource(`${String(event.phase)}:${String(event.source)}`, {
                label: String(event.label ?? ""),
                status: "running",
              });
              break;
            case "source_alert": {
              const a = event.alert as SourceAlert;
              setAlerts((prev) => [...prev, a]);
              upsertSource(`${a.phase}:${a.source}`, {
                alertsCount: (a.attempt ?? 1),
              });
              break;
            }
            case "source_result":
              upsertSource(`${String(event.phase)}:${String(event.source)}`, {
                status: event.degraded === true ? "degraded" : "ok",
                summary: String(event.summary ?? ""),
              });
              break;
            case "text_delta":
              setNarrative((prev) => prev + String(event.text ?? ""));
              break;
            case "report_done":
              setReport(event.report as ResearchReport);
              setElapsedMs(Number(event.elapsedMs ?? 0));
              break;
            case "fallback_notice":
              setAlerts((prev) => [
                ...prev,
                {
                  ts: new Date().toISOString(),
                  phase: "cross_check",
                  source: "narrative",
                  level: "warn",
                  message: `叙事模型主厂商故障，已秒切备用（${String(event.from ?? "")} → ${String(event.to ?? "")}：${String(event.reason ?? "")}）`,
                  attempt: 1,
                  action: "主→备自动切换",
                },
              ]);
              break;
            case "fatal_error":
              setError(String(event.message ?? "编排异常终止"));
              break;
            default:
              break;
          }
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "尽调请求失败");
    } finally {
      setRunning(false);
      void loadArchives();
    }
  }, [topic, running, simulateFaults, upsertSource, loadArchives]);

  const archiveReport = useCallback(async (): Promise<void> => {
    if (!report) return;
    setArchiveMsg("");
    try {
      const res = await fetch("/api/research-analyst/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: report.topic, report, archivedBy: "demo-林总" }),
      });
      const data: unknown = await res.json();
      if (data && typeof data === "object" && "error" in data) {
        setArchiveMsg(`归档失败：${String((data as { error?: unknown }).error)}`);
        return;
      }
      const ok = data as { reportId?: string; duplicate?: boolean; note?: string };
      setArchiveMsg(
        ok.duplicate
          ? `该简报此前已归档（${ok.reportId}），只增不改、不产生重复档案。`
          : `归档成功：${ok.reportId} 已入 research_reports 表（只增不改，触发器物理拒绝篡改）。`,
      );
      void loadArchives();
    } catch (err: unknown) {
      setArchiveMsg(`归档失败：${err instanceof Error ? err.message : "网络异常"}`);
    }
  }, [report, loadArchives]);

  const exportMarkdown = useCallback((): void => {
    if (!report) return;
    const blob = new Blob([report.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${report.reportId}-尽调简报.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [report]);

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-4 py-8 sm:px-6">
      {/* 页头 */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">企业尽调与研究分析台</h1>
          <p className="mt-1 text-sm text-zinc-500">
            三阶段编排 · 自愈容错 · 高管尽调简报（引文可溯源 · 一键归档 · Markdown 导出）
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
          <span className="rounded-lg bg-emerald-50 px-3 py-1.5 text-emerald-700 ring-1 ring-emerald-200">
            🟢 全程只读 · 无任何打款能力
          </span>
          <span className="rounded-lg bg-amber-50 px-3 py-1.5 text-amber-700 ring-1 ring-amber-200">
            超 ¥50,000 一律 FIN-001 强制人工审批
          </span>
        </div>
      </div>

      {/* 课题输入 */}
      <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <label htmlFor="topic" className="mb-2 block text-sm font-bold text-zinc-700">
          尽调课题
        </label>
        <textarea
          id="topic"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          rows={2}
          disabled={running}
          placeholder="输入复杂业务课题，如：评估华东区 3 家物流供应商的异常赔付风险与合规缺口"
          className="w-full resize-none rounded-xl border border-zinc-300 px-4 py-3 text-sm leading-6 outline-none focus:border-zinc-900 disabled:bg-zinc-50"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {PRESET_TOPICS.map((p) => (
            <button
              key={p}
              type="button"
              disabled={running}
              onClick={() => setTopic(p)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${
                topic === p
                  ? "bg-zinc-900 text-white"
                  : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-600">
            <input
              type="checkbox"
              checked={simulateFaults}
              disabled={running}
              onChange={(e) => setSimulateFaults(e.target.checked)}
              className="h-4 w-4 accent-amber-500"
            />
            注入数据源故障演习（格式错误 / 超时 / 结算函接口永久故障 → 验证自愈降级）
          </label>
          <button
            type="button"
            onClick={() => void startResearch()}
            disabled={running || topic.trim().length === 0}
            className="rounded-xl bg-zinc-900 px-6 py-2.5 text-sm font-bold text-white transition-colors hover:bg-zinc-700 disabled:opacity-50"
          >
            {running ? "编排进行中…" : "启动尽调编排"}
          </button>
        </div>
        {error.length > 0 && (
          <p className="mt-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">{error}</p>
        )}
      </section>

      {/* 三阶段编排直播 */}
      {(running || report !== null || alerts.length > 0) && (
        <section className="mt-6 grid gap-4 md:grid-cols-3">
          {PHASE_ORDER.map((phase) => {
            const st = phaseStatus[phase];
            const phaseSources = Object.entries(sources).filter(([k]) => k.startsWith(`${phase}:`));
            const phaseAlerts = alerts.filter((a) => a.phase === phase);
            return (
              <div
                key={phase}
                className={`rounded-2xl border bg-white p-4 shadow-sm transition-colors ${
                  st?.done ? "border-emerald-300" : st?.started ? "border-blue-300" : "border-zinc-200"
                }`}
              >
                <p className="flex items-center justify-between text-sm font-bold text-zinc-800">
                  {PHASE_NAMES[phase]}
                  {st?.done ? (
                    <span className="rounded-md bg-emerald-600 px-2 py-0.5 text-xs font-semibold text-white">完成</span>
                  ) : st?.started ? (
                    <span className="rounded-md bg-blue-600 px-2 py-0.5 text-xs font-semibold text-white">运行中</span>
                  ) : (
                    <span className="rounded-md bg-zinc-200 px-2 py-0.5 text-xs font-semibold text-zinc-500">待启动</span>
                  )}
                </p>
                <div className="mt-3 space-y-2">
                  {phaseSources.length === 0 && (
                    <p className="text-xs text-zinc-400">等待编排调度…</p>
                  )}
                  {phaseSources.map(([key, s]) => (
                    <div key={key} className="rounded-xl bg-zinc-50 px-3 py-2">
                      <p className="flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-zinc-700">
                        {s.label}
                        <SourcePill s={s} />
                      </p>
                      {s.summary.length > 0 && (
                        <p className="mt-1 text-xs leading-5 text-zinc-500">{s.summary}</p>
                      )}
                    </div>
                  ))}
                  {phaseAlerts.map((a, i) => (
                    <p
                      key={`${a.ts}-${String(i)}`}
                      className={`rounded-lg px-2 py-1 text-xs leading-5 ${
                        a.level === "error"
                          ? "bg-red-50 text-red-700"
                          : "bg-amber-50 text-amber-700"
                      }`}
                    >
                      ⚠ {a.message}（{a.action}）
                    </p>
                  ))}
                  {st?.done && st.summary.length > 0 && (
                    <p className="text-xs font-semibold text-emerald-700">✓ {st.summary}</p>
                  )}
                </div>
              </div>
            );
          })}
        </section>
      )}

      {/* 高管叙事（流式） */}
      {narrative.length > 0 && (
        <section className="mt-6 rounded-2xl border border-indigo-200 bg-indigo-50 p-5">
          <p className="text-xs font-bold text-indigo-700">高管结论速览（流式生成）</p>
          <p className="mt-2 text-sm leading-7 text-indigo-900">{narrative}</p>
        </section>
      )}

      {/* 结构化尽调简报 */}
      {report && (
        <section className="mt-6 space-y-4">
          {/* 报头 */}
          <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold text-zinc-400">
                  简报编号 {report.reportId} · 生成于 {new Date(report.generatedAt).toLocaleString("zh-CN")} ·
                  编排耗时 {(elapsedMs / 1000).toFixed(1)}s
                </p>
                <h2 className="mt-1 text-lg font-bold text-zinc-900">{report.topic}</h2>
                <p className="mt-2 max-w-3xl text-sm leading-7 text-zinc-600">{report.narrative || report.summaryText}</p>
              </div>
              <div className="flex flex-col items-center rounded-2xl bg-zinc-900 px-5 py-3 text-white">
                <span className="text-3xl font-black tabular-nums">{String(report.overallScore)}</span>
                <span className="text-xs text-zinc-300">总体风险评分 / 100</span>
                <span className={`mt-1 rounded px-2 py-0.5 text-xs font-bold ${LEVEL_STYLE[report.overallLevel] ?? "bg-zinc-500"}`}>
                  {report.overallLevel}风险
                </span>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void archiveReport()}
                className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-emerald-500"
              >
                一键归档进数据库
              </button>
              <button
                type="button"
                onClick={exportMarkdown}
                className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-bold text-zinc-700 transition-colors hover:bg-zinc-100"
              >
                导出 Markdown
              </button>
              <span className="text-xs text-zinc-400">
                数据覆盖：ACL 引文 {String(report.dataCoverage.aclHits)} 条 · ERP 记录 {String(report.dataCoverage.erpRecords)} 条
                {report.dataCoverage.degradedSources.length > 0
                  ? ` · 降级源：${report.dataCoverage.degradedSources.join("、")}`
                  : " · 无降级源"}
              </span>
            </div>
            {archiveMsg.length > 0 && (
              <p className="mt-3 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800 ring-1 ring-emerald-200">
                {archiveMsg}
              </p>
            )}
          </div>

          {/* 供应商风险评分卡 */}
          <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
            <h3 className="text-sm font-bold text-zinc-800">供应商风险评分卡</h3>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              {report.suppliers.map((s) => (
                <div key={s.supplierId} className="rounded-xl border border-zinc-200 p-4">
                  <p className="flex items-center justify-between text-sm font-bold text-zinc-800">
                    {s.name}
                    <span className={`rounded px-2 py-0.5 text-xs font-bold text-white ${LEVEL_STYLE[s.level] ?? "bg-zinc-500"}`}>
                      {s.level}风险 {String(s.score)}分
                    </span>
                  </p>
                  <p className="mt-1 font-mono text-[10px] text-zinc-400">{s.supplierId}</p>
                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-zinc-100">
                    <div className={`h-full rounded-full ${scoreColor(s.score)}`} style={{ width: `${String(Math.min(Math.max(s.score, 0), 100))}%` }} />
                  </div>
                  <p className="mt-2 text-xs text-zinc-500">
                    赔付 {String(s.metrics.claims)} 单 / ¥{String(s.metrics.claimTotalCny)} · 超期{" "}
                    {String(s.metrics.overdueIncidents)} 次 · 违规 {String(s.metrics.policyViolations)} 项 · FIN-001 待审{" "}
                    {String(s.metrics.fin001Pending)} 单
                  </p>
                  {s.findings.length > 0 && (
                    <ul className="mt-2 space-y-1.5">
                      {s.findings.map((f, i) => (
                        <li key={String(i)} className="text-xs leading-5 text-zinc-600">
                          · {f.text}
                          {f.citations.length > 0 && (
                            <span className="ml-1 font-mono text-[10px] font-semibold text-indigo-600">
                              {f.citations.join(" ")}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 合规缺口 */}
          <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
            <h3 className="text-sm font-bold text-zinc-800">
              合规缺口清单（{String(report.complianceGaps.length)} 项）
            </h3>
            <div className="mt-3 space-y-2">
              {report.complianceGaps.map((g) => (
                <div key={g.recordId} className="rounded-xl bg-amber-50 px-4 py-3 ring-1 ring-amber-200">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-amber-800">
                    <span className="rounded bg-amber-500 px-1.5 py-0.5 font-mono text-[10px] text-white">{g.recordId}</span>
                    {g.title}
                    {g.title.includes("FIN-001") && (
                      <span className="rounded bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white">
                        FIN-001 强制人工审批
                      </span>
                    )}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-amber-900">{g.detail}</p>
                  {g.citations.length > 0 && (
                    <p className="mt-1 font-mono text-[10px] font-semibold text-amber-700">引文：{g.citations.join("、")}</p>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 行动建议 + 引文出处 */}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
              <h3 className="text-sm font-bold text-zinc-800">行动建议</h3>
              <ul className="mt-3 space-y-2">
                {report.actions.map((a, i) => (
                  <li key={String(i)} className="flex items-start gap-2 text-sm leading-6 text-zinc-700">
                    <span className={`mt-1 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${PRIORITY_STYLE[a.priority] ?? "bg-zinc-500 text-white"}`}>
                      {a.priority}
                    </span>
                    <span>
                      {a.text}
                      {a.citations.length > 0 && (
                        <span className="ml-1 font-mono text-[10px] font-semibold text-indigo-600">{a.citations.join(" ")}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
              <h3 className="text-sm font-bold text-zinc-800">引文出处（{String(report.citations.length)} 条，全部可溯源）</h3>
              <ul className="mt-3 space-y-2">
                {report.citations.map((c) => (
                  <li key={c.ref} className="rounded-lg bg-zinc-50 px-3 py-2 text-xs leading-5 text-zinc-600">
                    <span className="font-mono font-bold text-indigo-700">{c.ref}</span>《{c.title}》
                    <br />
                    {c.snippet}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* 自愈容错留痕 */}
          {report.alerts.length > 0 && (
            <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
              <h3 className="text-sm font-bold text-zinc-800">
                自愈容错留痕（{String(report.alerts.length)} 条告警，全部自动处置，未中断编排）
              </h3>
              <ul className="mt-3 space-y-1.5">
                {report.alerts.map((a, i) => (
                  <li key={String(i)} className="text-xs leading-5 text-zinc-600">
                    <span className={a.level === "error" ? "font-bold text-red-600" : "font-bold text-amber-600"}>
                      【{a.level === "error" ? "错误" : "预警"}】
                    </span>
                    {a.source}：{a.message}（第 {String(a.attempt)} 次尝试 · 处置：{a.action}）
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 红区承诺 */}
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-xs leading-6 text-emerald-800">
            红区承诺：本台全程只读，不直写业务系统正式数据，无任何「自动打款/付款/放款」能力；涉及超 ¥50,000
            的事项一律转 FIN-001 强制人工审批，AI 不审批、不打款。简报全部数据为虚构演示内容，归档表只增不改。
          </div>
        </section>
      )}

      {/* 历史归档清单 */}
      {archives.length > 0 && (
        <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-bold text-zinc-800">历史归档（最近 {String(archives.length)} 份，只增不改）</h3>
          <div className="mt-3 space-y-2">
            {archives.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
                <span className="font-mono font-bold text-zinc-800">{a.reportId}</span>
                <span className="max-w-md truncate">{a.topic}</span>
                <span className={`rounded px-1.5 py-0.5 font-bold text-white ${LEVEL_STYLE[a.overallLevel] ?? "bg-zinc-500"}`}>
                  {String(a.overallScore)}分 · {a.overallLevel}风险
                </span>
                <span>
                  FIN-001 缺口 {String(a.fin001Gaps)} · 告警 {String(a.alertsCount)}
                  {a.degradedSources.length > 0 ? " · 含降级源" : ""}
                </span>
                <span className="text-zinc-400">
                  {new Date(a.createdAt).toLocaleString("zh-CN")} · {a.archivedBy}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
