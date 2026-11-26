"use client";

/**
 * /doc-intake —— Day 31 超大表格分治与修订版 Word 接入台
 * 交互纪律（AGENTS.md）：中文大白话、FIN-001 琥珀色预警、无任何打款按钮；
 * 分治展示：确定性引擎全量扫描进度 → 聚合 → Top5 异常 → AI 解读 → Token 降本对比。
 */

import { useRef, useState } from "react";

import type {
  AnomalyItem,
  ContractParseResult,
  DocIntakeSseEvent,
  DocIntakeStepPayload,
  GroupStat,
  TableScanReport,
  TokenCompare,
} from "@/lib/doc-intake/types";
import type { WorkbotCard } from "@/lib/workbot/types";

type SourceMode = "builtin" | "upload";

interface UsageInfo {
  ttftMs: number;
  costUsd: number;
}

interface NoticeItem {
  level: "info" | "warn" | "fallback";
  text: string;
}

function fmtYuan(n: number): string {
  return `¥${n.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
}

function fmtTokens(n: number): string {
  return n.toLocaleString("zh-CN");
}

/* ---------------- 小组件 ---------------- */

function StatusChip({ status, inserted }: { status: "effective" | "deleted" | "amended"; inserted: boolean }) {
  const map = {
    effective: { cls: "bg-emerald-100 text-emerald-800", label: "现行生效" },
    amended: { cls: "bg-amber-100 text-amber-800", label: "已修订" },
    deleted: { cls: "bg-rose-100 text-rose-700", label: "已删除 · 不生效" },
  } as const;
  const chip = map[status];
  return (
    <span className="flex items-center gap-1">
      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${chip.cls}`}>{chip.label}</span>
      {inserted && <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700">修订新增</span>}
    </span>
  );
}

function GroupTable({ title, rows }: { title: string; rows: GroupStat[] }) {
  return (
    <div className="min-w-40 flex-1 rounded-xl border border-zinc-200 bg-white p-3">
      <p className="mb-2 text-sm font-semibold text-zinc-700">{title}</p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-zinc-500">
            <th className="pb-1 font-medium">分组</th>
            <th className="pb-1 text-right font-medium">笔数</th>
            <th className="pb-1 text-right font-medium">金额</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 6).map((r) => (
            <tr key={r.key} className="border-t border-zinc-100">
              <td className="py-1 font-medium text-zinc-700">{r.key}</td>
              <td className="py-1 text-right text-zinc-600">{r.count}</td>
              <td className="py-1 text-right tabular-nums text-zinc-800">{fmtYuan(r.amountCny)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- 主页面 ---------------- */

export default function DocIntakePage() {
  const [sourceMode, setSourceMode] = useState<SourceMode>("builtin");
  const [upload, setUpload] = useState<{ csvText?: string; archiveBase64?: string; fileName?: string }>({});
  const [running, setRunning] = useState(false);
  const [phases, setPhases] = useState<string[]>([]);
  const [notices, setNotices] = useState<NoticeItem[]>([]);
  const [cards, setCards] = useState<WorkbotCard[]>([]);
  const [progress, setProgress] = useState<{ scanned: number; total: number; anomaliesSoFar: number } | null>(null);
  const [scanReport, setScanReport] = useState<TableScanReport | null>(null);
  const [aggregation, setAggregation] = useState<{ byDepartment: GroupStat[]; byMonth: GroupStat[] } | null>(null);
  const [anomalies, setAnomalies] = useState<AnomalyItem[]>([]);
  const [contract, setContract] = useState<ContractParseResult | null>(null);
  const [distilled, setDistilled] = useState<{ text: string; chars: number } | null>(null);
  const [compare, setCompare] = useState<TokenCompare | null>(null);
  const [aiText, setAiText] = useState("");
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function handleFile(file: File): Promise<void> {
    if (file.name.toLowerCase().endsWith(".csv")) {
      const text = await file.text();
      setUpload({ csvText: text, fileName: file.name });
    } else {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      setUpload({ archiveBase64: btoa(binary), fileName: file.name });
    }
  }

  function stop(): void {
    abortRef.current?.abort();
    setRunning(false);
    setNotices((prev) => [...prev, { level: "fallback", text: "已按停止键切断本次解析（Kill Switch 纪律：5 秒内可断，日志保留）。" }]);
  }

  async function run(): Promise<void> {
    if (running) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setPhases([]);
    setNotices([]);
    setCards([]);
    setProgress(null);
    setScanReport(null);
    setAggregation(null);
    setAnomalies([]);
    setContract(null);
    setDistilled(null);
    setCompare(null);
    setAiText("");
    setUsage(null);

    try {
      const res = await fetch("/api/doc-intake/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: "解读对账大表异常与合同修订要点，特别注意不要引用已删除条款",
          source: sourceMode,
          csvText: sourceMode === "upload" ? upload.csvText : undefined,
          archiveBase64: sourceMode === "upload" ? upload.archiveBase64 : undefined,
          fileName: sourceMode === "upload" ? upload.fileName : undefined,
        }),
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
          const event = JSON.parse(line.slice(6)) as DocIntakeSseEvent;
          if (event.type === "phase") {
            setPhases((prev) => [...prev, event.label]);
          } else if (event.type === "step") {
            const payload = event.payload as DocIntakeStepPayload;
            if (payload.stage === "scan_progress") setProgress({ scanned: payload.scanned, total: payload.total, anomaliesSoFar: payload.anomaliesSoFar });
            else if (payload.stage === "scan_done") setScanReport(payload.report);
            else if (payload.stage === "aggregation") setAggregation({ byDepartment: payload.byDepartment, byMonth: payload.byMonth });
            else if (payload.stage === "anomalies") setAnomalies(payload.anomalies);
            else if (payload.stage === "clauses") setContract(payload.contract);
            else if (payload.stage === "distilled_context") setDistilled({ text: payload.text, chars: payload.chars });
            else if (payload.stage === "token_compare") setCompare(payload.compare);
          } else if (event.type === "notice") {
            setNotices((prev) => [...prev, { level: event.level, text: event.text }]);
          } else if (event.type === "card") {
            setCards((prev) => [...prev, event.card]);
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
        setNotices((prev) => [...prev, { level: "fallback", text: `解析中断：${err instanceof Error ? err.message : "未知错误"}` }]);
      }
    } finally {
      setRunning(false);
    }
  }

  const fin001Count = anomalies.filter((a) => a.fin001Required).length;
  const naivePct = compare && compare.naive.inputTokens > 0 ? 100 : 0;
  const distilledPct = compare && compare.naive.inputTokens > 0 ? Math.max(0.8, (compare.distilled.inputTokens / compare.naive.inputTokens) * 100) : 0;

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-4 pb-16 pt-6 sm:px-6">
      {/* 标题区 */}
      <div className="mb-5">
        <p className="text-xs font-semibold tracking-widest text-zinc-400">DAY 31 · 超大表格分治与修订版 WORD 接入台</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-zinc-900">文档接入台</h1>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-zinc-600">
          8,500 行对账大表<b>绝不整表塞给大模型</b>：确定性代码引擎先做全量扫描、分组聚合与异常筛选，只把「摘要 + 5 条异常」的精准上下文送审 AI；
          修订版合同解析会准确区分「已删除条款」与「现行生效条款」，删掉的霸王条款绝不被当真。
        </p>
      </div>

      {/* 生成器 + 接入方式 */}
      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-2xl border border-zinc-200 bg-white p-4">
          <h2 className="text-sm font-bold text-zinc-800">① 内置生成器（一键产出样本）</h2>
          <ul className="mt-2 space-y-1 text-xs leading-5 text-zinc-600">
            <li>· 对账大表：8,500 行（2026-09-01 ~ 11-25），暗藏 <b>3 笔单笔超 ¥50,000</b>（财务部）与 <b>2 组重复扣款</b></li>
            <li>· 合同样本：修订版 V2.1，含删除线、批注；暗藏 <b>1 条整段删除的霸王条款</b>（原「5% 违约金上不封顶」已修订、原「自动扣款授权」整条废除）</li>
            <li>· 全部数据为虚构演示内容，不含任何真实客户信息</li>
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <a href="/api/doc-intake/generate?file=csv" className="rounded-lg bg-zinc-900 px-3 py-2 text-xs font-semibold text-white hover:bg-zinc-700">下载 CSV</a>
            <a href="/api/doc-intake/generate?file=xlsx" className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500">下载 XLSX</a>
            <a href="/api/doc-intake/generate?file=docx" className="rounded-lg bg-sky-600 px-3 py-2 text-xs font-semibold text-white hover:bg-sky-500">下载修订版合同 DOCX</a>
          </div>
          <p className="mt-2 text-[11px] text-zinc-400">提示：下载的 DOCX 可用 Word / WPS 打开，能直接看到修订删除线与批注气泡。</p>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-4">
          <h2 className="text-sm font-bold text-zinc-800">② 接入方式</h2>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <button
              type="button"
              onClick={() => setSourceMode("builtin")}
              className={`rounded-lg px-3 py-1.5 font-semibold ${sourceMode === "builtin" ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"}`}
            >
              内置样本（演示）
            </button>
            <button
              type="button"
              onClick={() => setSourceMode("upload")}
              className={`rounded-lg px-3 py-1.5 font-semibold ${sourceMode === "upload" ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"}`}
            >
              上传文件
            </button>
          </div>
          {sourceMode === "upload" && (
            <div className="mt-3 rounded-xl bg-zinc-50 p-3">
              <input
                type="file"
                accept=".csv,.xlsx,.docx"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFile(file);
                }}
                className="block w-full text-xs text-zinc-600"
              />
              <p className="mt-1 text-[11px] text-zinc-500">
                支持 CSV / XLSX（对账大表）与 DOCX（修订合同）；当前：
                <b>{upload.fileName ?? "未选择文件"}</b>（大表 CSV 上限 2MB，文档上限 4.5MB）
              </p>
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void run()}
              disabled={running || (sourceMode === "upload" && !upload.fileName)}
              className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-bold text-white shadow-sm transition-colors hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {running ? "解析中…" : "一键分治解析"}
            </button>
            {running && (
              <button type="button" onClick={stop} className="rounded-lg border border-rose-300 px-4 py-2 text-sm font-bold text-rose-600 hover:bg-rose-50">
                停止
              </button>
            )}
          </div>
        </section>
      </div>

      {/* 阶段 + 扫描进度 */}
      {(phases.length > 0 || progress) && (
        <section className="mt-4 rounded-2xl border border-zinc-200 bg-white p-4">
          <div className="flex flex-wrap gap-1.5">
            {phases.map((p) => (
              <span key={p} className="rounded-full bg-zinc-900 px-3 py-1 text-xs font-semibold text-white">{p}</span>
            ))}
          </div>
          {progress && (
            <div className="mt-3">
              <div className="flex justify-between text-xs text-zinc-600">
                <span>全量扫描进度：{fmtTokens(progress.scanned)} / {fmtTokens(progress.total)} 行</span>
                <span>已发现异常 {progress.anomaliesSoFar} 处（确定性引擎，不经大模型）</span>
              </div>
              <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-zinc-100">
                <div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${(progress.scanned / Math.max(progress.total, 1)) * 100}%` }} />
              </div>
            </div>
          )}
          {scanReport && (
            <p className="mt-2 text-xs text-zinc-600">
              扫描完成：共 <b>{fmtTokens(scanReport.rowCount)}</b> 行，金额合计 <b>{fmtYuan(scanReport.totalAmountCny)}</b>，不可解析行 {scanReport.corruptRows}（坏行只计数、绝不编造）。
            </p>
          )}
        </section>
      )}

      {/* Token 对比 */}
      {compare && (
        <section className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <h2 className="text-sm font-bold text-emerald-900">传统直塞 vs 分治架构 · Token 降本对比</h2>
            <p className="text-3xl font-black tabular-nums text-emerald-700">
              省 {compare.savingsPct.toFixed(1)}%
            </p>
          </div>
          <div className="mt-3 space-y-2">
            <div>
              <div className="flex justify-between text-xs text-zinc-700">
                <span>{compare.naive.label}（{fmtTokens(compare.naiveRecords)} 条记录）</span>
                <span className="tabular-nums">{fmtTokens(compare.naive.inputTokens)} tokens ≈ ${compare.naive.estCostUsd.toFixed(4)}</span>
              </div>
              <div className="mt-1 h-3 w-full rounded-full bg-rose-400" style={{ width: `${naivePct}%` }} />
            </div>
            <div>
              <div className="flex justify-between text-xs text-zinc-700">
                <span>{compare.distilled.label}（{fmtTokens(compare.distilledRecords)} 条记录）</span>
                <span className="tabular-nums">{fmtTokens(compare.distilled.inputTokens)} tokens ≈ ${compare.distilled.estCostUsd.toFixed(6)}</span>
              </div>
              <div className="mt-1 h-3 rounded-full bg-emerald-500" style={{ width: `${distilledPct}%` }} />
            </div>
          </div>
          <p className="mt-2 text-[11px] text-emerald-800">分治红利：确定性引擎先行，大模型只在精准提炼后的小上下文里解读——更快、更省、幻觉更少。</p>
        </section>
      )}

      {/* 分组聚合 */}
      {aggregation && (
        <section className="mt-4 flex flex-wrap gap-3">
          <GroupTable title="按部门聚合（Top 6）" rows={aggregation.byDepartment} />
          <GroupTable title="按月份聚合" rows={aggregation.byMonth} />
        </section>
      )}

      {/* 异常清单 */}
      {anomalies.length > 0 && (
        <section className="mt-4">
          <h2 className="mb-2 text-sm font-bold text-zinc-800">
            异常清单（Top {anomalies.length} · 其中 {fin001Count} 笔触发 FIN-001）
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            {anomalies.map((a) => (
              <div
                key={a.id}
                className={`rounded-2xl border p-3 ${a.fin001Required ? "border-amber-300 bg-amber-50 shadow-[0_0_0_1px_rgba(245,158,11,0.25)]" : "border-rose-200 bg-rose-50"}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className={`text-sm font-bold ${a.fin001Required ? "text-amber-900" : "text-rose-800"}`}>{a.title}</p>
                  {a.fin001Required && <span className="rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-black text-white">FIN-001 强制人工审批</span>}
                </div>
                <p className={`mt-1 text-xs leading-5 ${a.fin001Required ? "text-amber-800" : "text-rose-700"}`}>{a.detail}</p>
                <p className="mt-1 text-[11px] font-semibold text-zinc-500">
                  涉及行：第 {a.rowNos.join("、")} 行 · {a.fin001Required ? "仅允许具名人工审批（本页无任何打款按钮）" : "建议人工核实后走黄区退款草稿（dry-run 预演）"}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* FIN-001 审批卡（出站受控卡片） */}
      {cards.length > 0 && (
        <section className="mt-4">
          <h2 className="mb-2 text-sm font-bold text-zinc-800">FIN-001 审批卡（挂起等待具名审批人）</h2>
          <div className="flex flex-wrap gap-2">
            {cards.map((c) =>
              c.kind === "approval" ? (
                <div key={c.approvalId} className="rounded-xl border border-amber-300 bg-white px-3 py-2 text-xs">
                  <p className="font-bold text-amber-800">{c.title}</p>
                  <p className="mt-0.5 text-[11px] text-zinc-500">
                    单号 {c.approvalId} · 状态：{c.status === "pending" ? "等待具名人工审批" : c.status} · 放行永远归人
                  </p>
                </div>
              ) : (
                <div key={c.kind} className="rounded-xl border border-zinc-200 px-3 py-2 text-xs text-zinc-600">{c.kind}</div>
              ),
            )}
          </div>
        </section>
      )}

      {/* 合同条款（删除线 ≠ 生效） */}
      {contract && (
        <section className="mt-4 rounded-2xl border border-zinc-200 bg-white p-4">
          <h2 className="text-sm font-bold text-zinc-800">
            修订版合同解析：《{contract.title}》
            <span className="ml-2 text-xs font-medium text-zinc-500">
              生效 {contract.effectiveCount} 条 · 已修订 {contract.amendedCount} 条 · 已删除 {contract.deletedCount} 条 · 批注 {contract.commentCount} 条
            </span>
          </h2>
          <div className="mt-3 space-y-3">
            {contract.clauses.map((c) => (
              <div key={c.id} className={`rounded-xl border p-3 ${c.status === "deleted" ? "border-rose-200 bg-rose-50/60" : c.status === "amended" ? "border-amber-200 bg-amber-50/50" : "border-zinc-200 bg-white"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-bold text-zinc-800">第 {c.id} 条（{c.title}）</p>
                  <StatusChip status={c.status} inserted={c.inserted} />
                </div>
                {c.deletedText !== "" && (
                  <p className="mt-1 text-xs leading-5 text-rose-600 line-through decoration-rose-400 decoration-2">{c.deletedText}</p>
                )}
                {c.effectiveText !== "" && c.status !== "deleted" && (
                  <p className="mt-1 text-xs leading-5 text-zinc-700">{c.status === "amended" ? "→ 现行生效：" : ""}{c.effectiveText}</p>
                )}
                {c.status === "deleted" && <p className="mt-1 text-xs font-semibold text-rose-700">整条已删除，无任何生效文本——AI 不得引用。</p>}
                {c.comment !== "" && <p className="mt-1 rounded-lg bg-amber-100/70 px-2 py-1 text-[11px] italic text-amber-900">批注：{c.comment}</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 提示条 */}
      {notices.length > 0 && (
        <section className="mt-4 space-y-1.5">
          {notices.map((n, i) => (
            <p
              key={`${String(i)}-${n.text.slice(0, 12)}`}
              className={`rounded-lg px-3 py-2 text-xs ${
                n.level === "warn" ? "bg-amber-100 text-amber-900" : n.level === "fallback" ? "bg-rose-100 text-rose-800" : "bg-sky-50 text-sky-800"
              }`}
            >
              {n.text}
            </p>
          ))}
        </section>
      )}

      {/* 送审上下文（透明可折叠） */}
      {distilled && (
        <details className="mt-4 rounded-2xl border border-zinc-200 bg-white p-4">
          <summary className="cursor-pointer text-sm font-bold text-zinc-800">
            查看实际送审上下文（仅 {fmtTokens(distilled.chars)} 字符 · 外来内容已包 &lt;untrusted_document_content&gt; 隔离标签）
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-zinc-950 p-3 text-[11px] leading-5 text-emerald-300">{distilled.text}</pre>
        </details>
      )}

      {/* AI 解读 */}
      {(aiText !== "" || usage) && (
        <section className="mt-4 rounded-2xl border border-zinc-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-zinc-800">AI 精准解读（离线高仿真 · 流式）</h2>
            {usage && (
              <span className="rounded-full bg-zinc-900 px-2 py-0.5 text-[10px] font-semibold text-white">
                TTFT {usage.ttftMs}ms · ${usage.costUsd.toFixed(6)}
              </span>
            )}
          </div>
          <pre className="mt-2 whitespace-pre-wrap text-xs leading-6 text-zinc-700">{aiText}</pre>
        </section>
      )}

      {/* 红线页脚 */}
      <footer className="mt-8 rounded-2xl border border-zinc-200 bg-zinc-50 p-3 text-[11px] leading-5 text-zinc-500">
        红线声明：本页全部数据为虚构演示内容；FIN-001——单笔「超过」¥50,000 仅允许具名人工审批，页面不提供任何 AI 自动打款 / 自动扣款能力；
        外部文件内容一律包 &lt;untrusted_document_content&gt; 标签只当资料；解析过程只读，不直写任何业务系统正式数据。
      </footer>
    </main>
  );
}
