"use client";

/**
 * /browser-lab —— Day 14 受控浏览器自动化任务台
 * 两大任务：
 *   A. 一键「自动跨 3 页抓取超期单据并结构化入库」（全程只读 GET，只写 WorkBot 副本表）；
 *   B. 「预填老 ERP 表单」——在【提交保存】前强制暂停，弹出红框等具名人工确认后才能提交，
 *      且提交目标永远是仿真沙盒（进程内存），老 ERP 生产库零触碰。
 * 透明化：每一步的「操作快照」（复古浏览器窗口回放）与状态日志实时滚动展示。
 */

import { useCallback, useRef, useState } from "react";
import type {
  BrowserLabEvent,
  BrowserSnapshot,
  LegacyErpInvoice,
  PrefillDraft,
  SubmitReceipt,
} from "@/lib/browser-lab/types";

type Phase =
  | "idle"
  | "running-scrape"
  | "running-prefill"
  | "awaiting-human"
  | "running-submit"
  | "done";

interface LogLine {
  level: "info" | "warn" | "success" | "redline";
  text: string;
  at: string;
}

const LEVEL_STYLE: Record<LogLine["level"], string> = {
  info: "text-zinc-600",
  warn: "text-amber-600",
  success: "text-emerald-600",
  redline: "text-red-600 font-semibold",
};

const LEVEL_PREFIX: Record<LogLine["level"], string> = {
  info: "·",
  warn: "⚠",
  success: "✔",
  redline: "⛔",
};

function nowClock(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

/* ---------- 快照回放卡片（复古浏览器窗口） ---------- */

function SnapshotCard({ snapshot }: { snapshot: BrowserSnapshot }) {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-300 shadow-sm">
      {/* 窗口标题栏 */}
      <div className="flex items-center gap-2 border-b border-zinc-200 bg-zinc-100 px-3 py-1.5">
        <span className="flex gap-1">
          <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
        </span>
        <span className="text-xs font-semibold text-zinc-700">{snapshot.title}</span>
      </div>
      {/* 地址栏 */}
      <div className="border-b border-zinc-200 bg-white px-3 py-1">
        <span className="rounded-md bg-zinc-100 px-2 py-0.5 font-mono text-[10px] text-zinc-500">
          🔒 {snapshot.url}
        </span>
      </div>
      {/* 内容区 */}
      <div className="bg-white px-3 py-2.5">
        {snapshot.kind === "table" && snapshot.headers && snapshot.rows && (
          <table className="w-full border-collapse text-[11px]">
            <thead>
              <tr className="border-b border-zinc-200 text-zinc-500">
                {snapshot.headers.map((h) => (
                  <th key={h} className="px-2 py-1 text-left font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {snapshot.rows.map((row, ri) => (
                <tr
                  key={ri}
                  className={`border-b border-zinc-100 ${row.some((c) => c.includes("超期")) ? "bg-amber-50" : ""}`}
                >
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      className={`px-2 py-1 ${cell.includes("超期") ? "font-semibold text-amber-700" : "text-zinc-700"}`}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {snapshot.kind === "form" && snapshot.fields && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
            {snapshot.fields.map((f) => (
              <div key={f.label} className="flex items-baseline gap-2">
                <span className="w-20 shrink-0 text-zinc-500">{f.label}</span>
                <span
                  className={`min-w-0 flex-1 truncate rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 font-mono ${
                    f.value === "（空）" ? "text-zinc-300" : "text-zinc-800"
                  }`}
                >
                  {f.value}
                </span>
              </div>
            ))}
          </div>
        )}
        {snapshot.caption && (
          <p className="mt-2 text-[10px] text-zinc-400">{snapshot.caption}</p>
        )}
      </div>
    </div>
  );
}

/* ---------- 页面主体 ---------- */

export default function BrowserLabPage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [snapshots, setSnapshots] = useState<BrowserSnapshot[]>([]);
  const [currentStep, setCurrentStep] = useState("");
  const [resultInvoices, setResultInvoices] = useState<LegacyErpInvoice[]>([]);
  const [persistedCount, setPersistedCount] = useState<number | null>(null);
  const [pausedDraft, setPausedDraft] = useState<PrefillDraft | null>(null);
  const [pausedSession, setPausedSession] = useState<{ sessionId: string; taskId: string } | null>(null);
  const [approver, setApprover] = useState("");
  const [receipt, setReceipt] = useState<SubmitReceipt | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const logBoxRef = useRef<HTMLDivElement>(null);

  const appendLog = useCallback((level: LogLine["level"], text: string) => {
    setLogs((prev) => [...prev.slice(-160), { level, text, at: nowClock() }]);
    requestAnimationFrame(() =>
      logBoxRef.current?.scrollTo({ top: logBoxRef.current.scrollHeight, behavior: "smooth" }),
    );
  }, []);

  const reset = useCallback(() => {
    setLogs([]);
    setSnapshots([]);
    setCurrentStep("");
    setResultInvoices([]);
    setPersistedCount(null);
    setPausedDraft(null);
    setPausedSession(null);
    setReceipt(null);
    setErrorMsg("");
  }, []);

  /** SSE 消费：解析 data: 行 → 事件分发 */
  const runStream = useCallback(
    async (payload: Record<string, unknown>): Promise<void> => {
      const res = await fetch("/api/browser-lab", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok || !res.body) {
        const data: unknown = await res.json().catch(() => null);
        throw new Error((data as { error?: string })?.error ?? `接口异常（HTTP ${res.status}）`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const line = chunk.trim();
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6)) as BrowserLabEvent;
            handleEvent(event);
          } catch {
            // 忽略不完整帧
          }
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appendLog],
  );

  const handleEvent = (event: BrowserLabEvent): void => {
    switch (event.type) {
      case "step_start":
        setCurrentStep(event.step);
        appendLog("info", `▶ ${event.step} —— ${event.detail}`);
        break;
      case "log":
        appendLog(event.level, event.text);
        break;
      case "snapshot":
        setSnapshots((prev) => [...prev, event.snapshot]);
        break;
      case "scraped_page":
        appendLog("info", `第 ${event.page} 页：识别 ${event.found} 条 / 超期 ${event.overdue} 条`);
        break;
      case "result":
        setResultInvoices(event.invoices);
        setPersistedCount(event.persistedCount);
        appendLog("success", event.summary);
        break;
      case "paused":
        setPausedSession({ sessionId: event.sessionId, taskId: event.taskId });
        setPausedDraft(event.draft);
        setPhase("awaiting-human");
        break;
      case "submitted":
        setReceipt(event.receipt);
        break;
      case "done":
        setCurrentStep("");
        // awaiting-human 状态不被 done 事件打断（该态由确认按钮或过期错误收敛）
        setPhase((p) => (p === "awaiting-human" ? p : "done"));
        break;
      case "error":
        setErrorMsg(event.message);
        appendLog("warn", `✘ ${event.message}`);
        break;
    }
  };

  const runScrape = useCallback(async () => {
    reset();
    setPhase("running-scrape");
    appendLog("info", "任务 A 启动：自动跨 3 页抓取超期单据并结构化入库");
    try {
      await runStream({ action: "scrape" });
      setPhase("done");
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "任务失败");
      setPhase("idle");
    }
  }, [appendLog, reset, runStream]);

  const runPrefill = useCallback(async () => {
    reset();
    setPhase("running-prefill");
    appendLog("info", "任务 B 启动：预填老 ERP 表单（提交前强制暂停等人工确认）");
    try {
      await runStream({ action: "prefill" });
      // paused 事件已把 phase 切到 awaiting-human；若没有 paused（异常终止）保持
      setPhase((p) => (p === "running-prefill" ? "idle" : p));
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "任务失败");
      setPhase("idle");
    }
  }, [appendLog, reset, runStream]);

  const confirmSubmit = useCallback(async () => {
    if (!pausedSession) return;
    if (approver.trim().length === 0) {
      setErrorMsg("请先填写具名审批人（AI / 匿名 / 部门 / 值班一律无效）。");
      return;
    }
    setErrorMsg("");
    setPhase("running-submit");
    appendLog("info", `人工确认放行：${approver.trim()} → 继续执行【提交保存】`);
    try {
      await runStream({
        action: "confirm-submit",
        sessionId: pausedSession.sessionId,
        approver: approver.trim(),
      });
      setPhase("done");
      setPausedDraft(null);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "提交失败");
      setPhase("awaiting-human");
    }
  }, [appendLog, approver, pausedSession, runStream]);

  const busy = phase === "running-scrape" || phase === "running-prefill" || phase === "running-submit";
  const totalOverdueAmount = resultInvoices.reduce((s, i) => s + i.amount, 0);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      {/* ===== 页头与红线横幅 ===== */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">浏览器实验室（受控自动化）</h1>
        <p className="mt-1 text-sm text-zinc-600">
          受控浏览器自动化：跨页抓取老 ERP 仿真页的超期单据 + 预填手工录入表单。全程每一步快照与日志实时直播。
        </p>
        <div className="mt-3 rounded-xl border border-red-300 bg-red-50 p-3 text-xs leading-relaxed text-red-800">
          <strong>Day 2 红线 · 不直写老 ERP 生产库：</strong>
          抓取只发只读 GET；预填在【提交保存】前<strong>强制暂停</strong>，必须具名人工确认放行；
          确认后的提交目标永远是<strong>仿真沙盒</strong>（进程内存，重启即清空）。
          WorkBot 的工具列表中<strong>物理不存在</strong>任何写老 ERP 生产库的接口。
        </div>
      </div>

      {/* ===== 任务卡 ===== */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-zinc-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-bold">任务 A · 跨 3 页抓取超期单据</h2>
            <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[10px] font-semibold text-emerald-700">
              绿区 · 只读
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            自动翻页抓取 <a className="underline" href="/sandbox-legacy-erp" target="_blank">/sandbox-legacy-erp</a>{" "}
            3 页发票表 → 解析超期单据 → 结构化写入 WorkBot 副本表。
          </p>
          <button
            onClick={runScrape}
            disabled={busy}
            className="mt-3 w-full rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-50"
          >
            {phase === "running-scrape" ? "执行中…" : "一键执行抓取"}
          </button>
          {persistedCount !== null && (
            <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              ✔ 已入库 {persistedCount} 条超期单据，合计 ¥{totalOverdueAmount.toLocaleString("zh-CN")}
            </p>
          )}
        </div>

        <div className="rounded-2xl border border-zinc-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-bold">任务 B · 预填老 ERP 表单</h2>
            <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[10px] font-semibold text-amber-700">
              黄区 · 起草+人工确认
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            自动选定超期最久的单据 → 逐字段预填仿真表单 → 在【提交保存】前强制暂停，
            弹出红框等待具名人工确认。
          </p>
          <button
            onClick={runPrefill}
            disabled={busy}
            className="mt-3 w-full rounded-xl bg-amber-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-amber-500 disabled:opacity-50"
          >
            {phase === "running-prefill" ? "预填中…" : "一键预填（提交前暂停）"}
          </button>
        </div>
      </div>

      {/* ===== 红框人工确认（任务 B 暂停态） ===== */}
      {phase === "awaiting-human" && pausedDraft && pausedSession && (
        <div className="mt-6 rounded-2xl border-4 border-red-500 bg-red-50 p-5 shadow-[0_0_20px_rgba(239,68,68,0.25)]">
          <div className="flex items-center gap-2">
            <span className="rounded bg-red-600 px-2 py-0.5 text-xs font-bold text-white">
              ⛔ 强制暂停 · 等待人工确认
            </span>
            <span className="text-xs text-red-700">任务 {pausedSession.taskId}</span>
            {pausedDraft.isFin001 && (
              <span className="rounded bg-amber-500 px-2 py-0.5 text-xs font-bold text-white">
                FIN-001 强制人工审批
              </span>
            )}
          </div>
          <p className="mt-2 text-sm text-red-800">
            自动化已完成全部字段预填，下一步就是点击老 ERP 的<strong>【提交保存】</strong>按钮。
            按红线要求，这一步必须由<strong>具名在职人员</strong>确认放行后才会执行（提交目标为仿真沙盒，非生产库）。
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs md:grid-cols-3">
            <div><dt className="inline text-zinc-500">发票号：</dt><dd className="inline font-mono font-semibold">{pausedDraft.invoiceNo}</dd></div>
            <div><dt className="inline text-zinc-500">供应商：</dt><dd className="inline">{pausedDraft.supplier}</dd></div>
            <div><dt className="inline text-zinc-500">金额：</dt><dd className="inline font-semibold text-red-700">¥{pausedDraft.amount.toLocaleString("zh-CN")}</dd></div>
            <div><dt className="inline text-zinc-500">到期日：</dt><dd className="inline">{pausedDraft.dueDate}</dd></div>
            <div><dt className="inline text-zinc-500">已超期：</dt><dd className="inline font-semibold text-amber-700">{pausedDraft.daysOverdue} 天</dd></div>
          </dl>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <input
              value={approver}
              onChange={(e) => setApprover(e.target.value)}
              placeholder="具名审批人姓名（如：林总）"
              className="w-56 rounded-lg border border-red-300 bg-white px-3 py-2 text-sm outline-none focus:border-red-500"
            />
            <button
              onClick={confirmSubmit}
              disabled={busy}
              className="rounded-lg bg-red-600 px-5 py-2 text-sm font-bold text-white hover:bg-red-500 disabled:opacity-50"
            >
              {busy ? "提交中…" : "人工确认放行，继续【提交保存】"}
            </button>
            <span className="text-[11px] text-red-600">AI / 匿名 / 部门 / 值班身份一律无效；放行将留痕 approval_audit_logs（只增不改）。</span>
          </div>
          {errorMsg.length > 0 && (
            <p className="mt-2 text-xs font-semibold text-red-700">✘ {errorMsg}</p>
          )}
        </div>
      )}

      {/* ===== 提交回执（任务 B 完成态） ===== */}
      {receipt && (
        <div className="mt-6 rounded-2xl border border-emerald-300 bg-emerald-50 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-emerald-600 px-2 py-0.5 text-xs font-bold text-white">
              ✅ 提交完成（仿真沙盒）
            </span>
            <span className="text-xs text-emerald-700">回执号 {receipt.receiptNo}</span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-emerald-800">
            提交目标：{receipt.target} · 沙盒累计 {receipt.sandboxTotal} 笔 ·
            审计留痕 approval_audit_logs #{receipt.auditLogId}。
            <strong>老 ERP 生产库全程零触碰。</strong>
          </p>
        </div>
      )}

      {/* ===== 结果表（任务 A 抓取入库结果） ===== */}
      {resultInvoices.length > 0 && (
        <div className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5">
          <h3 className="mb-3 font-bold">超期单据结构化结果（已入库）</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-zinc-500">
                  <th className="px-2 py-1.5">发票号</th>
                  <th className="px-2 py-1.5">供应商</th>
                  <th className="px-2 py-1.5 text-right">金额(元)</th>
                  <th className="px-2 py-1.5">到期日</th>
                  <th className="px-2 py-1.5 text-right">超期天数</th>
                  <th className="px-2 py-1.5 text-center">来源页</th>
                </tr>
              </thead>
              <tbody>
                {resultInvoices.map((inv) => (
                  <tr key={inv.invoiceNo} className="border-b border-zinc-100">
                    <td className="px-2 py-1.5 font-mono">{inv.invoiceNo}</td>
                    <td className="px-2 py-1.5">{inv.supplier}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{inv.amount.toLocaleString("zh-CN")}</td>
                    <td className="px-2 py-1.5">{inv.dueDate}</td>
                    <td className="px-2 py-1.5 text-right font-semibold text-amber-600">{inv.daysOverdue}</td>
                    <td className="px-2 py-1.5 text-center text-zinc-400">第 {inv.sourcePage} 页</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ===== 实时直播：快照回放 + 状态日志 ===== */}
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-zinc-200 bg-white p-5">
          <h3 className="mb-3 flex items-center justify-between font-bold">
            操作快照回放
            <span className="text-[10px] font-normal text-zinc-400">每步浏览器画面快照（最新在上方）</span>
          </h3>
          {snapshots.length === 0 ? (
            <p className="py-8 text-center text-xs text-zinc-400">尚无快照 —— 点上方任务按钮开始。</p>
          ) : (
            <div className="max-h-[420px] space-y-3 overflow-y-auto pr-1">
              {[...snapshots].reverse().map((s, i) => (
                <SnapshotCard key={`${s.url}-${snapshots.length - i}`} snapshot={s} />
              ))}
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-5">
          <h3 className="mb-3 flex items-center justify-between font-bold">
            状态日志
            {busy && (
              <span className="flex items-center gap-1.5 text-[11px] font-normal text-zinc-500">
                <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
                {currentStep || "执行中"}
              </span>
            )}
          </h3>
          <div
            ref={logBoxRef}
            className="h-[420px] overflow-y-auto rounded-lg bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed"
          >
            {logs.length === 0 ? (
              <p className="text-zinc-600">等待任务启动…</p>
            ) : (
              logs.map((l, i) => (
                <p key={i} className={LEVEL_STYLE[l.level]}>
                  <span className="mr-2 text-zinc-700">[{l.at}]</span>
                  {LEVEL_PREFIX[l.level]} {l.text}
                </p>
              ))
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
