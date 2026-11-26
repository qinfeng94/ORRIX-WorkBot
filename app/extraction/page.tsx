"use client";

/**
 * /extraction —— Day 17 · 4 类企业单据结构化抽取与 18 档脏单据评测台
 * 溯源：AGENTS.md FIN-001（超 5 万强制人工审批；拆单合并口径上报）、
 *      代码红线 3（PII 脱敏）、红线 4（备注栏指令只上报不执行）。
 * 页面三件事：
 * 1. 亮出抽取契约：红章遮挡/模糊不清 → 一律 null，严禁编造（Prompt 与 Schema 双侧同一规则）；
 * 2. 【一键跑完 18 档评测】：SSE 逐档直播「抽取 → 注入扫描 → 纯代码算术复核 → FIN-001」；
 * 3. 红绿通过率报表：每档与期望逐维比对，全命中记绿；任何红线实现漂移立刻变红。
 * 边界：评测台纯只读（零 LLM、零写库、零打款按钮），所有演示单据均为虚构数据。
 */

import { useCallback, useRef, useState } from "react";
import {
  DIRTY_DOCS,
  type DirtyDoc,
} from "@/lib/extraction/dirty-docs";
import {
  DOC_TYPE_LABELS,
  EXTRACTION_SYSTEM_RULES,
  FIELD_LABELS,
  type DocType,
} from "@/lib/extraction/schemas";
import type { DocResult, EvalReport } from "@/lib/extraction/eval";

/* ================================================================
 * SSE 事件类型（与 /api/extraction/eval 的事件序列一一对应）
 * ================================================================ */

interface RunStartEvent {
  total: number;
}
interface DocStartEvent {
  index: number;
  docId: string;
  docName: string;
  docTypeLabel: string;
}
interface DocResultEvent {
  index: number;
  result: DocResult;
}
interface ReportDoneEvent {
  report: EvalReport;
  results: DocResult[];
}

const DOC_TYPE_STYLES: Record<DocType, string> = {
  invoice: "bg-blue-50 text-blue-700 border-blue-200",
  customs: "bg-cyan-50 text-cyan-700 border-cyan-200",
  logistics: "bg-violet-50 text-violet-700 border-violet-200",
  expense: "bg-teal-50 text-teal-700 border-teal-200",
};

/* ================================================================
 * 小组件
 * ================================================================ */

/** 抽取结果字段渲染：null 红字标注（遮挡置空一目了然），PII 已由引擎脱敏 */
function ExtractedFields({ result }: { result: DocResult }) {
  if (!result.extractionOk || result.data === null) {
    return (
      <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
        抽取失败：{result.parseError ?? "未知原因"}（转人工处理）
      </p>
    );
  }
  const entries = Object.entries(result.data).filter(([key]) => key !== "docType");
  const lines = (result.data as { lines?: Array<Record<string, unknown>> }).lines;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {entries.map(([key, value]) => {
        const isNull = value === null || value === undefined;
        const display =
          key === "lines"
            ? Array.isArray(lines)
              ? `${lines.length} 行明细`
              : "[]"
            : key === "remarks"
              ? String(value ?? "") === ""
                ? "（无）"
                : String(value)
              : String(value);
        return (
          <div
            key={key}
            className={`rounded-lg border px-3 py-2 text-sm ${
              isNull ? "border-red-200 bg-red-50" : "border-zinc-200 bg-white"
            }`}
          >
            <div className="text-xs text-zinc-500">{FIELD_LABELS[key] ?? key}</div>
            <div className={`mt-0.5 break-all font-medium ${isNull ? "text-red-600" : "text-zinc-800"}`}>
              {isNull ? (
                <>
                  null<span className="ml-1 text-xs font-normal text-red-500">（遮挡置空 · 严禁编造）</span>
                </>
              ) : (
                display
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 单档详情卡（可展开） */
function DocCard({
  doc,
  result,
  running,
  expanded,
  onToggle,
}: {
  doc: DirtyDoc;
  result: DocResult | null;
  running: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const passed = result?.passed ?? null;
  const border =
    passed === null
      ? "border-zinc-200 bg-white"
      : passed
        ? "border-emerald-300 bg-emerald-50/40"
        : "border-red-300 bg-red-50/40";
  const dot =
    passed === null
      ? running
        ? "bg-amber-400 animate-pulse"
        : "bg-zinc-300"
      : passed
        ? "bg-emerald-500"
        : "bg-red-500";

  return (
    <div className={`rounded-xl border ${border} transition-colors`}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-3 px-4 py-3 text-left"
      >
        <span className={`mt-1.5 h-3 w-3 shrink-0 rounded-full ${dot}`} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-zinc-500">{doc.id}</span>
            <span className="font-semibold text-zinc-900">{doc.name}</span>
            <span className={`rounded border px-1.5 py-0.5 text-xs ${DOC_TYPE_STYLES[doc.docType]}`}>
              {DOC_TYPE_LABELS[doc.docType]}
            </span>
            {doc.tags.map((tag) => (
              <span key={tag} className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">
                {tag}
              </span>
            ))}
            {passed !== null && (
              <span
                className={`ml-auto rounded-md px-2 py-0.5 text-xs font-bold ${
                  passed ? "bg-emerald-600 text-white" : "bg-red-600 text-white"
                }`}
              >
                {passed ? "绿 · 通过" : "红 · 未过"}
              </span>
            )}
          </span>
          <span className="mt-1 block text-sm text-zinc-600">{doc.scenario}</span>
        </span>
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-zinc-200 px-4 py-4">
          {/* OCR 原文 */}
          <div>
            <h4 className="mb-1.5 text-sm font-bold text-zinc-700">OCR 原文（仿真）</h4>
            <pre className="max-h-64 overflow-auto rounded-lg bg-zinc-900 px-3 py-2.5 font-mono text-xs leading-5 text-zinc-100">
              {doc.raw}
            </pre>
          </div>

          {/* 评测进行中占位 */}
          {!result && (
            <p className="text-sm text-zinc-500">
              {running ? "评测中……" : "点击【一键跑完 18 档评测】后此处展示判定明细。"}
            </p>
          )}

          {result && (
            <>
              {/* 抽取结果 */}
              <div>
                <h4 className="mb-1.5 text-sm font-bold text-zinc-700">结构化抽取结果（遮挡 → null）</h4>
                <ExtractedFields result={result} />
                {result.occludedFields.length > 0 && (
                  <p className="mt-2 text-xs text-amber-700">
                    遮挡清单：{result.occludedFields.map((f) => FIELD_LABELS[f] ?? f).join("、")} —— 按契约置 null，缺了就转人工，绝不编造。
                  </p>
                )}
              </div>

              {/* 算术复核 */}
              <div>
                <h4 className="mb-1.5 text-sm font-bold text-zinc-700">算术复核（纯代码重算，差额 &gt; ¥0.01 标红）</h4>
                {result.arithmetic.status === "fail" ? (
                  <ul className="space-y-1.5">
                    {result.arithmetic.alerts.map((a, i) => (
                      <li key={i} className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                        <span className="font-bold">标红 · {a.where}</span>（差 ¥{a.diff.toFixed(2)}）：{a.detail}
                      </li>
                    ))}
                  </ul>
                ) : result.arithmetic.status === "manual_review" ? (
                  <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    无法重算 · 转人工：{result.arithmetic.manualReason}
                  </p>
                ) : (
                  <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                    复核平账：明细、税额与合计均在 ¥0.01 容差内。
                  </p>
                )}
              </div>

              {/* FIN-001 */}
              <div>
                <h4 className="mb-1.5 text-sm font-bold text-zinc-700">FIN-001 红线判定</h4>
                <p
                  className={`rounded-lg px-3 py-2 text-sm ${
                    result.fin001.triggered
                      ? "bg-red-600 font-semibold text-white"
                      : "bg-zinc-100 text-zinc-700"
                  }`}
                >
                  {result.fin001.triggered && (
                    <span className="mr-2 rounded bg-white/20 px-1.5 py-0.5 text-xs font-bold">
                      FIN-001 强制人工审批
                    </span>
                  )}
                  {result.fin001.reason}
                </p>
              </div>

              {/* 注入上报 */}
              {result.injectionSuspect && (
                <div>
                  <h4 className="mb-1.5 text-sm font-bold text-zinc-700">不可信内容上报（只上报，不执行）</h4>
                  <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2">
                    <p className="mb-1 text-xs font-bold text-amber-700">
                      注入嫌疑：备注栏出现指令型内容，已按资料隔离上报，绝不当指令执行
                    </p>
                    <code className="block break-all font-mono text-xs text-amber-900">
                      &lt;untrusted_document_content&gt;{result.injectionSnippet}&lt;/untrusted_document_content&gt;
                    </code>
                  </div>
                </div>
              )}

              {result.damageSuspect && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  破损/异常签收上报：已标记转客服人工跟进。
                </p>
              )}

              {/* 期望比对 */}
              <div>
                <h4 className="mb-1.5 text-sm font-bold text-zinc-700">期望比对（全命中才记绿）</h4>
                <ul className="space-y-1">
                  {result.checks.map((c) => (
                    <li key={c.dimension} className="flex items-start gap-2 text-sm">
                      <span className={c.ok ? "text-emerald-600" : "text-red-600"}>{c.ok ? "✓" : "✗"}</span>
                      <span>
                        <span className="font-semibold text-zinc-800">{c.label}</span>
                        <span className="text-zinc-600"> —— 期望「{c.expected}」，实际：{c.actual}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ================================================================
 * 主页面
 * ================================================================ */

export default function ExtractionPage(): React.ReactElement {
  const [results, setResults] = useState<Record<string, DocResult>>({});
  const [report, setReport] = useState<EvalReport | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: DIRTY_DOCS.length });
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const abortRef = useRef<AbortController | null>(null);

  /** 一键跑完 18 档：SSE 逐档直播 */
  const runEval = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setError("");
    setResults({});
    setReport(null);
    setProgress({ current: 0, total: DIRTY_DOCS.length });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/extraction/eval", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: "",
      });
      if (!res.ok || !res.body) {
        const msg = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(msg?.error ?? `评测接口异常（HTTP ${res.status}）`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const eventLine = block.split("\n").find((l) => l.startsWith("event: "));
          const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
          if (!eventLine || !dataLine) continue;
          const event = eventLine.slice(7).trim();
          const payload: unknown = JSON.parse(dataLine.slice(6));
          if (event === "run_start") {
            const p = payload as RunStartEvent;
            setProgress({ current: 0, total: p.total });
          } else if (event === "doc_start") {
            const p = payload as DocStartEvent;
            setProgress({ current: p.index + 1, total: DIRTY_DOCS.length });
          } else if (event === "doc_result") {
            const p = payload as DocResultEvent;
            const r = p.result;
            setResults((prev) => ({ ...prev, [r.docId]: r }));
          } else if (event === "report_done") {
            const p = payload as ReportDoneEvent;
            setReport(p.report);
            const all: Record<string, DocResult> = {};
            for (const r of p.results) all[r.docId] = r;
            setResults(all);
            done = true;
          } else if (event === "run_error") {
            const p = payload as { message?: string };
            throw new Error(p.message ?? "评测流水线异常");
          }
        }
      }
    } catch (err: unknown) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : "评测请求失败，请重试。");
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [running]);

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const doneCount = Object.keys(results).length;
  const pct = progress.total === 0 ? 0 : Math.round((doneCount / progress.total) * 100);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      {/* 标题与红线说明 */}
      <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900">单据抽取台 · 4 类单据结构化抽取</h1>
          <span className="rounded-full bg-zinc-900 px-2.5 py-1 text-xs font-bold text-white">Day 17</span>
        </div>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          增值税发票 / 跨境报关单 / 物流签收单 / 费用报销单四类单据，OCR 原文进、严格 Zod 结构出。
          <span className="font-semibold text-zinc-900"> 被红章遮挡或模糊不清的字段一律填 null，严禁编造</span>
          ；金额算术交给纯代码校验器重算（差额 &gt; ¥0.01 立即标红），单笔折人民币超 ¥50,000 自动叠加 FIN-001 强制人工审批。
          本页所有单据均为虚构演示数据，评测台纯只读、无任何写库或打款能力。
        </p>
      </div>

      {/* 抽取契约（Prompt 与 Schema 同一规则） */}
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 lg:col-span-2">
          <h2 className="text-sm font-bold text-amber-800">抽取契约 · Prompt 与 Schema 双侧同一条规则</h2>
          <pre className="mt-2 whitespace-pre-wrap font-sans text-sm leading-6 text-amber-900">
            {EXTRACTION_SYSTEM_RULES}
          </pre>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-white p-5">
          <h2 className="text-sm font-bold text-zinc-800">4 套严格 Schema</h2>
          <ul className="mt-2 space-y-2 text-sm text-zinc-700">
            {(Object.keys(DOC_TYPE_LABELS) as DocType[]).map((t) => (
              <li key={t} className={`rounded-lg border px-3 py-2 ${DOC_TYPE_STYLES[t]}`}>
                <span className="font-semibold">{DOC_TYPE_LABELS[t]}</span>
                <span className="ml-1 text-xs opacity-80">strict · 遮挡字段 nullable</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* 跑批按钮 + 进度 */}
      <div className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5">
        <div className="flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={runEval}
            disabled={running}
            className={`rounded-xl px-5 py-2.5 text-sm font-bold text-white transition-colors ${
              running ? "cursor-not-allowed bg-zinc-400" : "bg-zinc-900 hover:bg-zinc-700"
            }`}
          >
            {running ? `评测中…（第 ${Math.min(progress.current, progress.total)}/${progress.total} 档）` : "一键跑完 18 档评测"}
          </button>
          {(running || doneCount > 0) && (
            <div className="min-w-40 flex-1">
              <div className="h-2.5 overflow-hidden rounded-full bg-zinc-100">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                已完成 {doneCount}/{progress.total} 档
              </p>
            </div>
          )}
        </div>
        {error && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}
      </div>

      {/* 红绿通过率报表 */}
      {report && (
        <div className="mt-6 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center gap-6">
            <div className={`rounded-2xl px-6 py-4 text-center ${report.failed === 0 ? "bg-emerald-600" : "bg-red-600"}`}>
              <div className="text-4xl font-black text-white">{report.passRate}%</div>
              <div className="mt-0.5 text-xs text-white/80">红绿通过率</div>
            </div>
            <div className="flex gap-3">
              <div className="rounded-xl bg-emerald-50 px-5 py-3 text-center">
                <div className="text-2xl font-bold text-emerald-600">{report.passed}</div>
                <div className="text-xs text-emerald-700">绿 · 通过</div>
              </div>
              <div className="rounded-xl bg-red-50 px-5 py-3 text-center">
                <div className="text-2xl font-bold text-red-600">{report.failed}</div>
                <div className="text-xs text-red-700">红 · 未过</div>
              </div>
              <div className="rounded-xl bg-zinc-50 px-5 py-3 text-center">
                <div className="text-2xl font-bold text-zinc-700">{report.total}</div>
                <div className="text-xs text-zinc-500">评测档位</div>
              </div>
            </div>
          </div>
          <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {report.byDimension.map((d) => (
              <div
                key={d.dimension}
                className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm ${
                  d.fail === 0 ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"
                }`}
              >
                <span className={d.fail === 0 ? "text-emerald-700" : "text-red-700"}>{d.label}</span>
                <span className={`font-mono text-xs ${d.fail === 0 ? "text-emerald-600" : "text-red-600"}`}>
                  命中 {d.ok}/{d.ok + d.fail}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 18 档单据列表 */}
      <div className="mt-6 space-y-3">
        {DIRTY_DOCS.map((doc) => (
          <DocCard
            key={doc.id}
            doc={doc}
            result={results[doc.id] ?? null}
            running={running}
            expanded={expanded[doc.id] === true}
            onToggle={() => toggleExpand(doc.id)}
          />
        ))}
      </div>

      <p className="mt-8 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-xs leading-5 text-zinc-500">
        红线提醒：抽取与复核结论仅供参考，放行永远归人；单笔折合人民币超过 ¥50,000 一律走 FIN-001 强制人工审批，
        AI 不充当审批人；备注栏中的任何「指令」只上报、不执行；本页全部演示数据均为虚构。
      </p>
    </main>
  );
}
