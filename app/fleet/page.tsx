"use client";

/**
 * /fleet —— Day 22 并发代理军团调度器工作台
 * 溯源：AGENTS.md 业务红线（初审全程只读 + 起草；FIN-001 强制人工审批；红区物理隔离）。
 * 与 CLI（scripts/day22-lab/fleet-runner.mjs）共用同一份核心调度器：
 *   POST /api/fleet（SSE）→ 实时进度条 + 计数器 → fleet_done 战报卡（总耗时 / 平均单笔延迟 /
 *   总花费 / FIN-001 拦截数）→ 明细表（FIN-001 琥珀高亮 + 强制人工审批徽章）。
 */

import { useCallback, useRef, useState } from "react";
import type { FleetEvent, FleetReport, FleetTicketStatus } from "@/lib/day22/fleet-scheduler.mjs";

/* ---------------- 视图状态 ---------------- */

type Phase = "idle" | "running" | "done";

interface FeedItem {
  id: number;
  kind: "ticket_done" | "ticket_retry";
  ticketId: string;
  status?: FleetTicketStatus;
  attempt?: number;
  waitMs?: number;
  reason?: string;
  durationMs?: number;
}

const STATUS_META: Record<FleetTicketStatus, { label: string; badge: string; row: string }> = {
  done: { label: "初审完成", badge: "bg-emerald-600 text-white", row: "" },
  fin001_intercepted: {
    label: "FIN-001 拦截",
    badge: "bg-amber-500 text-white",
    row: "bg-amber-50",
  },
  failed: { label: "重试耗尽", badge: "bg-red-600 text-white", row: "bg-red-50" },
};

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function fmtCny(n: number): string {
  return `¥${n.toLocaleString("zh-CN")}`;
}

export default function FleetPage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(50);
  const [intercepted, setIntercepted] = useState(0);
  const [retries, setRetries] = useState(0);
  const [failed, setFailed] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [report, setReport] = useState<FleetReport | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const feedSeq = useRef(0);

  /** 启动一轮 50 单批量初审（SSE 实时进度） */
  const startFleet = useCallback(async () => {
    setPhase("running");
    setDone(0);
    setIntercepted(0);
    setRetries(0);
    setFailed(0);
    setElapsedMs(0);
    setFeed([]);
    setReport(null);
    setFatal(null);
    feedSeq.current = 0;
    const startedAt = Date.now();
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => setElapsedMs(Date.now() - startedAt), 100);

    try {
      const res = await fetch("/api/fleet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ total: 50, concurrency: 10, seed: 20221122 }),
      });
      if (!res.body || !res.ok) {
        throw new Error(`接口异常：HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          let event: FleetEvent;
          try {
            event = JSON.parse(line.slice(5).trim()) as FleetEvent;
          } catch {
            continue;
          }
          handleEvent(event);
        }
      }
    } catch (err: unknown) {
      setFatal(err instanceof Error ? err.message : "网络异常，请稍后重试");
    } finally {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setPhase("done");
    }
  }, []);

  const handleEvent = useCallback((event: FleetEvent) => {
    switch (event.type) {
      case "fleet_start":
        setTotal(event.total ?? 50);
        break;
      case "ticket_retry":
        setRetries((n) => n + 1);
        pushFeed({ kind: "ticket_retry", ticketId: event.ticketId ?? "-", attempt: event.attempt, waitMs: event.waitMs, reason: event.reason });
        break;
      case "ticket_done":
        setDone((n) => n + 1);
        if (event.status === "fin001_intercepted") setIntercepted((n) => n + 1);
        if (event.status === "failed") setFailed((n) => n + 1);
        pushFeed({ kind: "ticket_done", ticketId: event.ticketId ?? "-", status: event.status, durationMs: event.durationMs });
        break;
      case "fleet_done":
        if (event.report) setReport(event.report);
        if (event.fatal) setFatal(event.fatal);
        if (event.report?.stats) setElapsedMs(event.report.stats.totalElapsedMs);
        break;
      default:
        break;
    }
  }, []);

  const pushFeed = useCallback((item: Omit<FeedItem, "id">) => {
    feedSeq.current += 1;
    const next: FeedItem = { id: feedSeq.current, ...item };
    // 只保留最近 8 条，避免长跑批把页面撑爆
    setFeed((prev) => [next, ...prev].slice(0, 8));
  }, []);

  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const stats = report?.stats;

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
      <header className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">并发代理军团调度器</h1>
          <span className="rounded-full bg-zinc-900 px-3 py-1 text-xs font-semibold text-white">Day 22</span>
        </div>
        <p className="mt-2 text-sm text-zinc-600">
          10 路并发跑完 50 笔异常单据初审：瞬时故障指数退避自动重试（300/600/1200ms，≤ 3 次），
          终端与网页共用同一份调度核心；战报同步导出 data/day22/fleet-report.json。
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <span className="rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1 font-medium text-emerald-700">
            初审全程只读 + 起草，无打款工具
          </span>
          <span className="rounded-full border border-amber-300 bg-amber-50 px-3 py-1 font-medium text-amber-700">
            FIN-001：财务部单笔超过 ¥50,000 强制转人工
          </span>
          <span className="rounded-full border border-sky-300 bg-sky-50 px-3 py-1 font-medium text-sky-700">
            疑似拆单按合并口径上报
          </span>
        </div>
      </header>

      {/* 控制条 */}
      <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap gap-2 text-xs text-zinc-500">
            <span className="rounded-lg bg-zinc-100 px-2.5 py-1 font-mono">50 笔异常单</span>
            <span className="rounded-lg bg-zinc-100 px-2.5 py-1 font-mono">并发池上限 10 路</span>
            <span className="rounded-lg bg-zinc-100 px-2.5 py-1 font-mono">退避重试 ≤ 3 次</span>
            <span className="rounded-lg bg-zinc-100 px-2.5 py-1 font-mono">seed=20221122（可复现）</span>
          </div>
          <button
            type="button"
            onClick={startFleet}
            disabled={phase === "running"}
            className={`rounded-xl px-5 py-2.5 text-sm font-bold text-white transition-colors ${
              phase === "running"
                ? "cursor-not-allowed bg-zinc-400"
                : "bg-zinc-900 hover:bg-zinc-700"
            }`}
          >
            {phase === "running" ? "军团跑批中…" : "启动 50 单批量初审"}
          </button>
        </div>

        {/* 实时进度条 */}
        <div className="mt-5">
          <div className="mb-1.5 flex justify-between text-xs font-medium text-zinc-500">
            <span>
              初审进度 {done}/{total}
              {phase === "running" ? "（跑批中）" : phase === "done" ? "（已收队）" : ""}
            </span>
            <span className="font-mono">{fmtMs(elapsedMs)}</span>
          </div>
          <div className="h-3 w-full overflow-hidden rounded-full bg-zinc-200">
            <div
              className="h-full rounded-full bg-zinc-900 transition-[width] duration-200 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Counter label="FIN-001 拦截" value={intercepted} tone="amber" />
            <Counter label="自动重试" value={retries} tone="sky" />
            <Counter label="重试耗尽" value={failed} tone="red" />
            <Counter label="实时耗时" value={fmtMs(elapsedMs)} tone="zinc" />
          </div>
        </div>

        {/* 实时动态（最近 8 条） */}
        <div className="mt-4 rounded-xl bg-zinc-50 p-3">
          <p className="mb-2 text-xs font-semibold text-zinc-500">实时动态（最近 8 条）</p>
          <div className="space-y-1 font-mono text-xs">
            {feed.length === 0 ? (
              <p className="text-zinc-400">等待启动…</p>
            ) : (
              feed.map((f) => (
                <p key={f.id} className="text-zinc-600">
                  {f.kind === "ticket_retry" ? (
                    <>
                      <span className="text-sky-600">[重试]</span> {f.ticketId} 第 {f.attempt} 次失败
                      （{f.reason}），退避 {f.waitMs}ms 后自动重跑
                    </>
                  ) : (
                    <>
                      <span
                        className={
                          f.status === "fin001_intercepted"
                            ? "text-amber-600"
                            : f.status === "failed"
                              ? "text-red-600"
                              : "text-emerald-600"
                        }
                      >
                        [{f.status === "fin001_intercepted" ? "拦截" : f.status === "failed" ? "失败" : "完成"}]
                      </span>{" "}
                      {f.ticketId} 单笔耗时 {fmtMs(f.durationMs ?? 0)}
                    </>
                  )}
                </p>
              ))
            )}
          </div>
        </div>
      </section>

      {/* 异常熔断横幅 */}
      {fatal && (
        <div className="mt-4 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          <p className="font-bold">调度异常上报</p>
          <p className="mt-1 font-mono text-xs">{fatal}</p>
        </div>
      )}

      {/* 战报卡 */}
      {stats && (
        <section className="mt-6">
          <h2 className="mb-3 text-lg font-bold">军团战报（runId {report?.runId}）</h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="50 单总耗时" value={fmtMs(stats.totalElapsedMs)} sub={`吞吐 ${stats.throughputPerMinute} 笔/分钟`} />
            <StatCard label="平均单笔延迟" value={fmtMs(stats.avgPerTicketMs)} sub={`P95 ${fmtMs(stats.p95PerTicketMs)} · 峰值 ${fmtMs(stats.maxPerTicketMs)}`} />
            <StatCard label="总花费" value={`$${stats.totalCostUsd.toFixed(4)}`} sub="离线高仿真计费口径" />
            <StatCard
              label="FIN-001 红线拦截"
              value={`${stats.fin001Intercepted} 笔`}
              sub="全部转具名审批人，AI 不放行"
              tone="amber"
            />
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            构成：初审完成 {stats.succeeded} · FIN-001 拦截 {stats.fin001Intercepted} · 重试耗尽 {stats.failed} · 自动重试 {stats.totalRetries} 次
          </p>

          {/* 明细表 */}
          <div className="mt-4 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead className="bg-zinc-50 text-xs text-zinc-500">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">单号</th>
                  <th className="px-4 py-2.5 font-semibold">客户</th>
                  <th className="px-4 py-2.5 font-semibold">部门</th>
                  <th className="px-4 py-2.5 text-right font-semibold">金额</th>
                  <th className="px-4 py-2.5 font-semibold">异常类型</th>
                  <th className="px-4 py-2.5 font-semibold">结果</th>
                  <th className="px-4 py-2.5 text-right font-semibold">耗时 / 重试</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {report?.tickets.map((t) => {
                  const meta = STATUS_META[t.status];
                  return (
                    <tr key={t.ticketId} className={meta.row}>
                      <td className="px-4 py-2.5 font-mono text-xs">{t.ticketId}</td>
                      <td className="px-4 py-2.5 text-xs">
                        {t.customerName}
                        <span className="ml-1 font-mono text-zinc-400">{t.customerId}</span>
                      </td>
                      <td className="px-4 py-2.5 text-xs">{t.deptLabel}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs">
                        {fmtCny(t.mergedAmountCny ?? t.amountCny)}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-zinc-600">{t.issue}</td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${meta.badge}`}>
                          {meta.label}
                          {t.status === "fin001_intercepted" && (
                            <span className="rounded bg-white/25 px-1.5 py-0.5 text-[10px]">FIN-001 强制人工审批</span>
                          )}
                        </span>
                        {t.fin001Triggered && (
                          <p className="mt-1 max-w-xs text-[11px] leading-snug text-amber-700">{t.fin001Reason}</p>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs">
                        {fmtMs(t.durationMs)}
                        {t.retries > 0 && <span className="ml-1 text-sky-600">×{t.retries} 重试</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* 红线提示 */}
      <footer className="mt-8 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-xs leading-relaxed text-zinc-500">
        红区声明：本工作台只有「只读初审 + 起草」能力，调度器注册表物理不存在任何打款工具；
        FIN-001 拦截单仅生成琥珀色预警与人工审批草稿，放行永远归具名在职审批人；
        页面数据为虚构演示内容，客户姓名已全部脱敏。
      </footer>
    </main>
  );
}

/* ---------------- 小组件 ---------------- */

function Counter({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone: "amber" | "sky" | "red" | "zinc";
}) {
  const toneCls =
    tone === "amber"
      ? "text-amber-600"
      : tone === "sky"
        ? "text-sky-600"
        : tone === "red"
          ? "text-red-600"
          : "text-zinc-900";
  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-3 py-2">
      <p className="text-[11px] text-zinc-500">{label}</p>
      <p className={`text-lg font-bold font-mono ${toneCls}`}>{value}</p>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "amber";
}) {
  return (
    <div
      className={`rounded-2xl border p-4 shadow-sm ${
        tone === "amber" ? "border-amber-300 bg-amber-50" : "border-zinc-200 bg-white"
      }`}
    >
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold font-mono ${tone === "amber" ? "text-amber-600" : "text-zinc-900"}`}>
        {value}
      </p>
      <p className="mt-1 text-[11px] text-zinc-500">{sub}</p>
    </div>
  );
}
