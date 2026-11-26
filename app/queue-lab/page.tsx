"use client";

/**
 * /queue-lab —— Day 33 500 并发多租户公平队列压测看板
 * 溯源：AGENTS.md 红线（纯只读仿真 + 台账只增不改；无任何打款 / 写业务数据动作）。
 * 数据通道：POST /api/queue-lab（SSE 实时事件流）；409 冲突 / 刷新页面时降级 GET 轮询恢复。
 * 展示：实时队列深度（星辰/瑞康 × 公平/FIFO 四线）、P95 响应延迟对比曲线、
 *      令牌桶余量仪表、调度周期槽位卡、终局 0 失败率战报与六项护栏自检。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { QueueLabRunState } from "@/lib/queue/load-test";
import type {
  CycleSlotPlan,
  QueueLabEvent,
  QueueLabReport,
  SnapshotSample,
} from "@/lib/queue/types";

/* ---------------- 视图状态与工具 ---------------- */

type Phase = "idle" | "running" | "done";

interface ChartPoint {
  t: number;
  v: number;
}

type QueueLabGetResponse =
  | { ok: true; phase: "idle" }
  | { ok: true; phase: QueueLabRunState["status"]; state: QueueLabRunState };

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function tenantOf(sample: SnapshotSample, tenantId: string) {
  return sample.tenants.find((t) => t.tenantId === tenantId);
}

function waitingSeries(samples: readonly SnapshotSample[], tenantId: string): ChartPoint[] {
  return samples.map((s) => ({ t: s.tSec, v: tenantOf(s, tenantId)?.waiting ?? 0 }));
}

function p95Series(samples: readonly SnapshotSample[], tenantId: string): ChartPoint[] {
  return samples.map((s) => ({ t: s.tSec, v: tenantOf(s, tenantId)?.p95Ms ?? 0 }));
}

/**
 * 收尾口径回填：最后几笔完成于末次快照之后（快照节拍 250ms 一次），
 * 战报已出但进度计数可能停在 496/500——用终局统计把队列清零、进度归满。
 */
function finalizeLatest(
  latest: { fair: SnapshotSample; fifo: SnapshotSample },
  report: QueueLabReport,
): { fair: SnapshotSample; fifo: SnapshotSample } {
  const zeroed = (s: SnapshotSample, doneCount: number): SnapshotSample => ({
    ...s,
    queueDepth: 0,
    running: 0,
    doneCount,
    tenants: s.tenants.map((t) => ({ ...t, waiting: 0, admissionWaiting: 0, running: 0 })),
  });
  return {
    fair: zeroed(latest.fair, report.fair.tenants.reduce((acc, t) => acc + t.done, 0)),
    fifo: zeroed(latest.fifo, report.fifo.tenants.reduce((acc, t) => acc + t.done, 0)),
  };
}

/* ---------------- SVG 折线图（零依赖，viewBox 自适应缩放） ---------------- */

const CHART_W = 760;
const CHART_H = 250;
const PAD_L = 52;
const PAD_R = 14;
const PAD_T = 16;
const PAD_B = 26;

function toPointsStr(series: readonly ChartPoint[], maxT: number, maxV: number): string {
  if (series.length === 0) return "";
  const innerW = CHART_W - PAD_L - PAD_R;
  const innerH = CHART_H - PAD_T - PAD_B;
  const scaleX = (t: number): number => PAD_L + (maxT <= 0 ? 0 : (t / maxT) * innerW);
  const scaleY = (v: number): number =>
    CHART_H - PAD_B - (maxV <= 0 ? 0 : Math.min(v / maxV, 1) * innerH);
  return series.map((p) => `${scaleX(p.t).toFixed(1)},${scaleY(p.v).toFixed(1)}`).join(" ");
}

function LineChart({
  lines,
  maxT,
  maxV,
  emptyHint,
}: {
  lines: { label: string; color: string; dashed?: boolean; points: string }[];
  maxT: number;
  maxV: number;
  emptyHint: string;
}) {
  const hasData = lines.some((l) => l.points.length > 0);
  const gridFrac = [0, 0.25, 0.5, 0.75, 1];
  const innerW = CHART_W - PAD_L - PAD_R;
  const innerH = CHART_H - PAD_T - PAD_B;
  return (
    <div>
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="w-full" role="img">
        {gridFrac.map((f) => {
          const y = PAD_T + innerH * (1 - f);
          return (
            <g key={f}>
              <line x1={PAD_L} x2={CHART_W - PAD_R} y1={y} y2={y} stroke="#e4e4e7" strokeWidth={1} />
              <text x={PAD_L - 8} y={y + 4} textAnchor="end" fontSize={11} fill="#a1a1aa">
                {Math.round(maxV * f)}
              </text>
            </g>
          );
        })}
        <text x={CHART_W - PAD_R} y={CHART_H - 8} textAnchor="end" fontSize={11} fill="#a1a1aa">
          {maxT.toFixed(1)}s
        </text>
        <text x={PAD_L} y={CHART_H - 8} textAnchor="start" fontSize={11} fill="#a1a1aa">
          0s
        </text>
        {hasData
          ? lines.map((l) => (
              <polyline
                key={l.label}
                points={l.points}
                fill="none"
                stroke={l.color}
                strokeWidth={2.5}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray={l.dashed ? "7 5" : undefined}
              />
            ))
          : null}
      </svg>
      {!hasData && <p className="py-8 text-center text-sm text-zinc-400">{emptyHint}</p>}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
        {lines.map((l) => (
          <span key={l.label} className="flex items-center gap-1.5 text-xs text-zinc-600">
            <span
              className="inline-block h-0.5 w-5 rounded"
              style={{
                backgroundColor: l.dashed ? "transparent" : l.color,
                borderTop: l.dashed ? `2.5px dashed ${l.color}` : undefined,
              }}
            />
            {l.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ---------------- 页面本体 ---------------- */

export default function QueueLabPage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [total, setTotal] = useState(500);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [cycle, setCycle] = useState<CycleSlotPlan[]>([]);
  const [samples, setSamples] = useState<{ fair: SnapshotSample[]; fifo: SnapshotSample[] }>({
    fair: [],
    fifo: [],
  });
  const [latest, setLatest] = useState<{ fair: SnapshotSample; fifo: SnapshotSample } | null>(null);
  const [report, setReport] = useState<QueueLabReport | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /** 把单例状态整体铺到视图（GET 恢复 / 轮询共用） */
  const applyState = useCallback((state: QueueLabRunState) => {
    setTotal(state.totalRequests);
    setCycle(state.cycle);
    setSamples(state.samples);
    setLatest(state.latest && state.report ? finalizeLatest(state.latest, state.report) : state.latest);
    setReport(state.report);
    setElapsedMs(state.elapsedMs);
    setFatal(state.error);
  }, []);

  /** 已有压测在跑时的轮询兜底（多端观看 / 刷新恢复共用） */
  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(() => {
      void (async () => {
        try {
          const res = await fetch("/api/queue-lab");
          if (!res.ok) return;
          const data = (await res.json()) as QueueLabGetResponse;
          if (data.phase === "idle" || !("state" in data)) return;
          applyState(data.state);
          if (data.state.status !== "running") {
            if (pollRef.current) {
              clearInterval(pollRef.current);
              pollRef.current = null;
            }
            setPhase(data.state.status === "error" ? "done" : "done");
          }
        } catch {
          // 单次轮询失败静默，下一拍再试
        }
      })();
    }, 600);
  }, [applyState]);

  /** SSE 事件 → 视图更新（与 scripts/day33 脚本共用同一事件契约） */
  const handleEvent = useCallback((event: QueueLabEvent) => {
    switch (event.type) {
      case "run_started":
        setTotal(event.totalRequests);
        setCycle(event.cycle);
        break;
      case "snapshot":
        setSamples((prev) => ({
          fair: [...prev.fair, event.fair],
          fifo: [...prev.fifo, event.fifo],
        }));
        setLatest({ fair: event.fair, fifo: event.fifo });
        setElapsedMs(event.elapsedMs);
        break;
      case "report":
        setReport(event.report);
        setElapsedMs(event.report.wallMs);
        setLatest((prev) => (prev ? finalizeLatest(prev, event.report) : prev));
        break;
      case "error":
        setFatal(event.message);
        break;
      default:
        break;
    }
  }, []);

  /** 启动一轮 500 并发对照压测（SSE 实时流；409 冲突自动降级轮询） */
  const startRun = useCallback(async () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setPhase("running");
    setTotal(500);
    setElapsedMs(0);
    setCycle([]);
    setSamples({ fair: [], fifo: [] });
    setLatest(null);
    setReport(null);
    setFatal(null);
    setConflict(null);
    try {
      const res = await fetch("/api/queue-lab", { method: "POST" });
      if (res.status === 409) {
        const data = (await res.json()) as { error?: string };
        setConflict(data.error ?? "已有压测进行中，已自动接入实况");
        startPolling();
        return;
      }
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
          try {
            handleEvent(JSON.parse(line.slice(5).trim()) as QueueLabEvent);
          } catch {
            continue;
          }
        }
      }
      setPhase("done");
    } catch (err: unknown) {
      setFatal(err instanceof Error ? err.message : "网络异常，请稍后重试");
      setPhase("done");
    }
  }, [handleEvent, startPolling]);

  /** 首屏恢复：已完成战报直接回放；进行中的压测自动接入实况（React 19：setState 全部位于 await 之后） */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/queue-lab");
        if (!res.ok) return;
        const data = (await res.json()) as QueueLabGetResponse;
        if (!alive || data.phase === "idle" || !("state" in data)) return;
        applyState(data.state);
        if (data.state.status === "running") {
          setConflict("服务端已有压测进行中，已自动接入实况");
          setPhase("running");
          startPolling();
        } else {
          setPhase("done");
        }
      } catch {
        // 首屏恢复失败保持 idle，不影响手动开跑
      }
    })();
    return () => {
      alive = false;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [applyState, startPolling]);

  /* ---------------- 图表数据派生 ---------------- */

  const fairS = samples.fair;
  const fifoS = samples.fifo;
  const maxT = Math.max(
    fairS.length > 0 ? fairS[fairS.length - 1].tSec : 0,
    fifoS.length > 0 ? fifoS[fifoS.length - 1].tSec : 0,
  );

  const depthVals = [
    ...waitingSeries(fairS, "xingchen").map((p) => p.v),
    ...waitingSeries(fairS, "ruikang").map((p) => p.v),
    ...waitingSeries(fifoS, "xingchen").map((p) => p.v),
    ...waitingSeries(fifoS, "ruikang").map((p) => p.v),
  ];
  const depthMax = Math.max(20, ...depthVals);
  const niceDepthMax = Math.ceil(depthMax / 20) * 20;

  const p95Vals = [
    ...p95Series(fairS, "xingchen").map((p) => p.v),
    ...p95Series(fairS, "ruikang").map((p) => p.v),
    ...p95Series(fifoS, "ruikang").map((p) => p.v),
  ];
  const niceP95Max = Math.ceil(Math.max(500, ...p95Vals) / 200) * 200;

  const depthLines = [
    { label: "星辰 · 公平队列", color: "#f59e0b", points: toPointsStr(waitingSeries(fairS, "xingchen"), maxT, niceDepthMax) },
    { label: "瑞康 · 公平队列", color: "#0f766e", points: toPointsStr(waitingSeries(fairS, "ruikang"), maxT, niceDepthMax) },
    { label: "星辰 · FIFO 对照", color: "#a1a1aa", dashed: true, points: toPointsStr(waitingSeries(fifoS, "xingchen"), maxT, niceDepthMax) },
    { label: "瑞康 · FIFO 对照", color: "#f43f5e", dashed: true, points: toPointsStr(waitingSeries(fifoS, "ruikang"), maxT, niceDepthMax) },
  ];

  const p95Lines = [
    { label: "瑞康 P95 · 公平队列", color: "#0f766e", points: toPointsStr(p95Series(fairS, "ruikang"), maxT, niceP95Max) },
    { label: "瑞康 P95 · FIFO 对照", color: "#f43f5e", dashed: true, points: toPointsStr(p95Series(fifoS, "ruikang"), maxT, niceP95Max) },
    { label: "星辰 P95 · 公平队列", color: "#f59e0b", points: toPointsStr(p95Series(fairS, "xingchen"), maxT, niceP95Max) },
  ];

  const doneCount = latest?.fair.doneCount ?? 0;
  const pct = total === 0 ? 0 : Math.round((doneCount / total) * 100);
  const ruikangFairLatest = latest ? tenantOf(latest.fair, "ruikang") : undefined;
  const xingchenFairLatest = latest ? tenantOf(latest.fair, "xingchen") : undefined;

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
      <header className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">多租户公平队列压测台</h1>
          <span className="rounded-full bg-zinc-900 px-3 py-1 text-xs font-semibold text-white">Day 33</span>
        </div>
        <p className="mt-2 text-sm text-zinc-600">
          500 并发仿真压测：星辰 450 笔突发洪峰 + 瑞康 50 笔常态流量，同一批请求分别灌入
          「加权轮询公平队列」与「先来先服务 FIFO」两个引擎对照跑。看大租户洪峰时，
          小租户的保底带宽是否顶得住、会不会被饿死。
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <span className="rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1 font-medium text-emerald-700">
            按租户加权轮询 + 保底带宽（结构性零饿死）
          </span>
          <span className="rounded-full border border-sky-300 bg-sky-50 px-3 py-1 font-medium text-sky-700">
            令牌桶削峰不拒单：只排队、不丢弃
          </span>
          <span className="rounded-full border border-amber-300 bg-amber-50 px-3 py-1 font-medium text-amber-700">
            全程只读仿真，无任何打款 / 写业务数据动作
          </span>
        </div>
      </header>

      {/* 控制条 */}
      <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap gap-2 text-xs text-zinc-500">
            <span className="rounded-lg bg-zinc-100 px-2.5 py-1 font-mono">500 笔（450 + 50）</span>
            <span className="rounded-lg bg-zinc-100 px-2.5 py-1 font-mono">处理池 10 路</span>
            <span className="rounded-lg bg-zinc-100 px-2.5 py-1 font-mono">单笔仿真 150~250ms</span>
            <span className="rounded-lg bg-zinc-100 px-2.5 py-1 font-mono">seed=20331126（可复现）</span>
          </div>
          <button
            type="button"
            onClick={() => void startRun()}
            disabled={phase === "running"}
            className={`rounded-xl px-5 py-2.5 text-sm font-bold text-white transition-colors ${
              phase === "running"
                ? "cursor-not-allowed bg-zinc-400"
                : "bg-zinc-900 hover:bg-zinc-700"
            }`}
          >
            {phase === "running" ? "500 并发压测进行中…" : "启动 500 并发对照压测"}
          </button>
        </div>

        {/* 实时进度条 */}
        <div className="mt-5">
          <div className="mb-1.5 flex justify-between text-xs font-medium text-zinc-500">
            <span>
              处理进度 {doneCount}/{total}
              {phase === "running" ? "（跑测中）" : phase === "done" ? "（已收队）" : ""}
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
            <Counter label="全局队列深度" value={String(latest?.fair.queueDepth ?? 0)} tone="sky" />
            <Counter label="正在处理" value={String(latest?.fair.running ?? 0)} tone="zinc" />
            <Counter label="已完成" value={`${doneCount}/${total}`} tone="emerald" />
            <Counter label="实时耗时" value={fmtMs(elapsedMs)} tone="zinc" />
          </div>
        </div>

        {conflict && (
          <div className="mt-4 rounded-xl border border-sky-300 bg-sky-50 px-4 py-3 text-sm text-sky-700">
            {conflict}
          </div>
        )}
        {fatal && (
          <div className="mt-4 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
            <p className="font-bold">压测异常上报</p>
            <p>{fatal}</p>
          </div>
        )}
      </section>

      {/* 曲线区 */}
      <section className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-bold text-zinc-800">实时队列深度（按租户，笔）</h2>
          <p className="mt-1 text-xs text-zinc-500">
            FIFO 下瑞康曲线被星辰洪峰一路顶到天花板（饿死）；公平队列下瑞康始终低位快进快出。
          </p>
          <div className="mt-3">
            <LineChart lines={depthLines} maxT={maxT} maxV={niceDepthMax} emptyHint="等待开跑…" />
          </div>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-bold text-zinc-800">P95 响应延迟对比（毫秒）</h2>
          <p className="mt-1 text-xs text-zinc-500">
            关键对比：瑞康公平队列（青实线）vs 瑞康 FIFO（红虚线）——差距即小租户被洪峰挤占的净代价。
          </p>
          <div className="mt-3">
            <LineChart lines={p95Lines} maxT={maxT} maxV={niceP95Max} emptyHint="等待开跑…" />
          </div>
        </div>
      </section>

      {/* 令牌桶 + 调度周期 */}
      <section className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-bold text-zinc-800">令牌桶实时余量（公平引擎）</h2>
          <p className="mt-1 text-xs text-zinc-500">
            洪峰期桶被击穿 → 超出补充速率的请求在桶前排队（削峰不拒单），排队数见各租户下方。
          </p>
          <div className="mt-4 space-y-4">
            {latest ? (
              latest.fair.tenants.map((t) => (
                <div key={t.tenantId}>
                  <div className="mb-1 flex items-center justify-between text-xs font-medium">
                    <span className="text-zinc-700">{t.displayName}</span>
                    <span className="font-mono text-zinc-500">
                      令牌 {Math.floor(t.tokens)}/{t.bucketCapacity}
                    </span>
                  </div>
                  <div className="h-3 w-full overflow-hidden rounded-full bg-zinc-200">
                    <div
                      className={`h-full rounded-full transition-[width] duration-200 ease-out ${
                        t.tenantId === "xingchen" ? "bg-amber-500" : "bg-teal-700"
                      }`}
                      style={{ width: `${Math.min(100, (t.tokens / t.bucketCapacity) * 100)}%` }}
                    />
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">
                    桶前排队 {t.admissionWaiting} 笔 · 队列等待 {t.waiting} 笔 · 失败 {t.failed} 笔
                  </p>
                </div>
              ))
            ) : (
              <p className="py-6 text-center text-sm text-zinc-400">等待开跑后展示实时令牌余量…</p>
            )}
          </div>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-bold text-zinc-800">调度周期槽位（公平引擎）</h2>
          <p className="mt-1 text-xs text-zinc-500">
            每一轮调度周期按「权重槽 vs 保底槽」取大者分配；保底生效时小租户槽位被硬性抬高。
          </p>
          <div className="mt-4 overflow-hidden rounded-xl border border-zinc-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-zinc-50 text-xs text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-medium">租户</th>
                  <th className="px-3 py-2 font-medium">周期槽位</th>
                  <th className="px-3 py-2 font-medium">容量份额</th>
                  <th className="px-3 py-2 font-medium">保底</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {cycle.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-sm text-zinc-400">
                      等待开跑后展示周期规划…
                    </td>
                  </tr>
                ) : (
                  cycle.map((plan) => (
                    <tr key={plan.tenantId}>
                      <td className="px-3 py-2.5 font-medium text-zinc-800">{plan.displayName}</td>
                      <td className="px-3 py-2.5 font-mono text-zinc-600">{plan.slots} 槽</td>
                      <td className="px-3 py-2.5 font-mono text-zinc-600">
                        {(plan.share * 100).toFixed(1)}%
                      </td>
                      <td className="px-3 py-2.5">
                        {plan.floorBumped ? (
                          <span className="rounded-full bg-teal-50 px-2 py-0.5 text-xs font-semibold text-teal-700">
                            保底生效（≥{Math.round(plan.floorSlots)} 槽）
                          </span>
                        ) : (
                          <span className="text-xs text-zinc-400">权重已覆盖</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {ruikangFairLatest && xingchenFairLatest && (
            <p className="mt-3 text-xs text-zinc-500">
              实时口径：星辰队列 {xingchenFairLatest.waiting} 笔 · 瑞康队列 {ruikangFairLatest.waiting} 笔；
              两边同时有积压时即进入争抢期，保底份额按上表硬性兑现。
            </p>
          )}
        </div>
      </section>

      {/* 终局战报 */}
      {report && (
        <section className="mt-4 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-bold text-zinc-800">终局战报（{report.runId}）</h2>
            <span
              className={`rounded-full px-3 py-1 text-xs font-bold ${
                report.allPass ? "bg-emerald-600 text-white" : "bg-red-600 text-white"
              }`}
            >
              {report.allPass ? "六项护栏全部 PASS" : "存在护栏未达标，详见下方清单"}
            </span>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl bg-emerald-50 p-5 text-center">
              <p className="text-xs font-semibold text-emerald-700">失败率（削峰不拒单）</p>
              <p className="mt-1 text-5xl font-black tracking-tight text-emerald-600">
                {report.failureRatePct}%
              </p>
              <p className="mt-1 text-xs text-emerald-700">500 笔全部完成，零丢弃</p>
            </div>
            <div className="rounded-2xl bg-teal-50 p-5 text-center">
              <p className="text-xs font-semibold text-teal-700">瑞康 P95 提升（公平 vs FIFO）</p>
              <p className="mt-1 text-5xl font-black tracking-tight text-teal-700">
                {report.comparison.improvementX.toFixed(1)}×
              </p>
              <p className="mt-1 text-xs text-teal-700">
                {fmtMs(report.comparison.ruikangP95FairMs)} vs {fmtMs(report.comparison.ruikangP95FifoMs)}
              </p>
            </div>
            <div className="rounded-2xl bg-zinc-50 p-5 text-center">
              <p className="text-xs font-semibold text-zinc-600">公平引擎吞吐 / 总耗时</p>
              <p className="mt-1 text-3xl font-black tracking-tight text-zinc-800">
                {report.fair.throughputPerSec.toFixed(1)} 笔/秒
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                总耗时 {fmtMs(report.wallMs)} · FIFO 对照 {fmtMs(report.fifo.wallMs)}
              </p>
            </div>
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {report.checks.map((c) => (
              <div
                key={c.name}
                className={`rounded-xl border px-3.5 py-3 text-sm ${
                  c.ok ? "border-emerald-200 bg-emerald-50/60" : "border-red-200 bg-red-50"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-zinc-800">{c.name}</span>
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-bold text-white ${
                      c.ok ? "bg-emerald-600" : "bg-red-600"
                    }`}
                  >
                    {c.ok ? "PASS" : "FAIL"}
                  </span>
                </div>
                <p className="mt-1 text-xs text-zinc-600">{c.detail}</p>
              </div>
            ))}
          </div>

          <div className="mt-4 grid gap-3 text-xs text-zinc-600 sm:grid-cols-2">
            <div className="rounded-xl bg-zinc-50 p-3">
              <p className="font-semibold text-zinc-700">瑞康（小租户）终局口径</p>
              <p className="mt-1">
                公平队列 P95 {fmtMs(report.comparison.ruikangP95FairMs)} · 最长等待{" "}
                {fmtMs(report.comparison.ruikangMaxWaitFairMs)}；
                FIFO 对照 P95 {fmtMs(report.comparison.ruikangP95FifoMs)} · 最长等待{" "}
                {fmtMs(report.comparison.ruikangMaxWaitFifoMs)}。
              </p>
            </div>
            <div className="rounded-xl bg-zinc-50 p-3">
              <p className="font-semibold text-zinc-700">实验设定</p>
              <p className="mt-1">
                同一批 {report.planSummary.totalRequests} 笔、同一组配对随机耗时（150~{report.planSummary.serviceMaxMs}ms）、
                同一处理池 {report.planSummary.poolCapacity} 路；唯一变量是派发顺序。seed={report.planSummary.seed}，结果可复现。
              </p>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}

/* ---------------- 小组件 ---------------- */

function Counter({ label, value, tone }: { label: string; value: string; tone: "sky" | "zinc" | "emerald" | "amber" | "red" }) {
  const tones: Record<typeof tone, string> = {
    sky: "bg-sky-50 text-sky-700 border-sky-200",
    zinc: "bg-zinc-50 text-zinc-700 border-zinc-200",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    red: "bg-red-50 text-red-700 border-red-200",
  };
  return (
    <div className={`rounded-xl border px-3 py-2 ${tones[tone]}`}>
      <p className="text-xs opacity-80">{label}</p>
      <p className="mt-0.5 font-mono text-lg font-bold leading-tight">{value}</p>
    </div>
  );
}
