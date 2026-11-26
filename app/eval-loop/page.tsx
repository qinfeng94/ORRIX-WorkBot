"use client";

/**
 * /eval-loop —— Day 25 收官 · 黄金评测门禁闭环看板
 * 三种体验：
 *  1) fast 快速门禁（前 2 层 12 题，秒级）；
 *  2) full 全量 25 题 4 层（前 3 层 100% 强制阻塞，第 4 层 AutoSxS 胜率放行）；
 *  3) 一键破坏演习闭环：故意改坏 5 万元红线（内存注入，不动源文件）→ 全量考试
 *     → 红灯拦住 → 自动生成失败派单简报 → AI 读简报自动修复 → 复考转绿。
 * 红线提示：本页只做只读评测，全程无打款按钮、不写业务系统正式数据。
 */

import { useCallback, useEffect, useState } from "react";
import type {
  ChaosLoopResult,
  EvalLoopSnapshot,
  GateLayerResult,
  GateReport,
} from "@/lib/workbot/eval-gate";

type Bus = "idle" | "gate-fast" | "gate-full" | "chaos";

const LAYER_DESC = [
  { layer: 1, name: "安全防注入", rule: "6 题 · 逐题全对才放行（100% 强制阻塞）" },
  { layer: 2, name: "算术与脏数据防编造", rule: "6 题 · 逐题全对才放行（100% 强制阻塞）" },
  { layer: 3, name: "双供应商容灾", rule: "6 题 · 演习逐题全对才放行（100% 强制阻塞）" },
  { layer: 4, name: "复杂推理与防幻觉", rule: "7 题 · AutoSxS 胜率 ≥ 80% 放行" },
] as const;

function VerdictBanner({ report }: { report: GateReport }) {
  const pass = report.verdict === "PASS";
  return (
    <div
      className={`rounded-xl border p-4 ${pass ? "border-emerald-300 bg-emerald-50" : "border-red-300 bg-red-50"}`}
    >
      <div className="flex items-center justify-between">
        <p className={`text-lg font-bold ${pass ? "text-emerald-700" : "text-red-700"}`}>
          {pass ? "🟢 PASS · 门禁放行" : "🔴 BLOCKED · 红灯拦截"}
        </p>
        <p className="text-sm font-semibold text-zinc-600">
          {String(report.counts.passed)}/{String(report.counts.total)} 合格 · 耗时{" "}
          {String(report.durationMs)}ms · 模式 {report.mode}
        </p>
      </div>
      {report.blockReasons.length > 0 && (
        <ul className="mt-2 list-inside list-disc text-sm text-red-700">
          {report.blockReasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {pass && (
        <p className="mt-1 text-sm text-emerald-700">
          台账已写入 data/evals/gate-report.json；红灯派单简报与 AutoSxS 报告见下方。
        </p>
      )}
    </div>
  );
}

function LayerTable({ layer }: { layer: GateLayerResult }) {
  const allPass = layer.passed === layer.total;
  return (
    <div className="rounded-xl border border-zinc-200 bg-white">
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-2.5">
        <p className="font-bold text-zinc-800">
          第 {String(layer.layer)} 层 {layer.layerName}
        </p>
        <p className={`text-sm font-semibold ${allPass ? "text-emerald-600" : "text-red-600"}`}>
          {String(layer.passed)}/{String(layer.total)} · {layer.blockingRule}
        </p>
      </div>
      <ul className="divide-y divide-zinc-100">
        {layer.results.map((q) => (
          <li key={q.id} className="px-4 py-2 text-sm">
            <div className="flex items-start gap-2">
              <span className={q.passed ? "text-emerald-600" : "text-red-600"}>
                {q.passed ? "✅" : "❌"}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-zinc-800">
                  {q.id} {q.title}
                </p>
                <p className={`break-all ${q.passed ? "text-zinc-500" : "text-red-600"}`}>
                  {q.detail}
                </p>
                {!q.passed && q.actualAnswer.length > 0 && (
                  <p className="mt-1 rounded-lg bg-zinc-50 p-2 text-xs text-zinc-500">
                    引擎实际回答（截断）：{q.actualAnswer.slice(0, 120)}…
                  </p>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AutoSxsCard({ report }: { report: NonNullable<GateReport["autosxs"]> }) {
  const pct = Math.round(report.winRate * 100);
  const ok = report.verdict === "PASS";
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <p className="font-bold text-zinc-800">AutoSxS 胜率报告（第 4 层 · 候选 vs 基线坏答案）</p>
        <p className={`font-bold ${ok ? "text-emerald-600" : "text-red-600"}`}>
          {String(pct)}% · 放行线 {String(Math.round(report.threshold * 100))}% · {report.verdict}
        </p>
      </div>
      <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-zinc-100">
        <div
          className={`h-full rounded-full ${ok ? "bg-emerald-500" : "bg-red-500"}`}
          style={{ width: `${String(pct)}%` }}
        />
      </div>
      <ul className="mt-3 space-y-1 text-sm">
        {report.pairs.map((p) => (
          <li key={p.id} className="flex items-center gap-2 text-zinc-700">
            <span>{p.verdict === "win" ? "✅" : "❌"}</span>
            <span className="font-semibold">{p.id}</span>
            <span>{p.title}</span>
            <span className="ml-auto text-xs text-zinc-400">
              候选{p.candidatePass ? "合格" : "不合格"} / 基线{p.baselinePass ? "合格" : "不合格"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChaosTimeline({ loop }: { loop: ChaosLoopResult }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <p className="font-bold text-zinc-800">破坏演习闭环：改坏红线 → 红灯拦住 → AI 读简报修绿</p>
      <ol className="mt-3 space-y-3">
        {loop.steps.map((s) => (
          <li key={String(s.step)} className="flex items-start gap-3">
            <span
              className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-sm font-bold text-white ${
                s.status === "green"
                  ? "bg-emerald-500"
                  : s.status === "red"
                    ? "bg-red-500"
                    : "bg-zinc-400"
              }`}
            >
              {String(s.step)}
            </span>
            <div>
              <p className="font-semibold text-zinc-800">{s.title}</p>
              <p className="break-all text-sm text-zinc-600">{s.detail}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap gap-2 text-sm">
        <span className={`rounded-lg px-2.5 py-1 font-semibold ${loop.caught ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
          门禁拦截坏红线：{loop.caught ? "成功" : "失败"}
        </span>
        <span className={`rounded-lg px-2.5 py-1 font-semibold ${loop.repaired ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
          AI 读简报修复：{loop.repaired ? "成功" : "失败"}
        </span>
        <span className={`rounded-lg px-2.5 py-1 font-semibold ${loop.secondReport.verdict === "PASS" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
          复考：{loop.secondReport.verdict === "PASS" ? "绿灯放行" : "仍为红灯"}
        </span>
      </div>
    </div>
  );
}

function BriefsCard({ snapshot }: { snapshot: EvalLoopSnapshot }) {
  const briefs = snapshot.briefs;
  if (!briefs || briefs.briefs.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-4">
        <p className="font-bold text-zinc-800">失败派单简报（data/evals/failure-briefs.json）</p>
        <p className="mt-1 text-sm text-zinc-500">
          {briefs && briefs.verdict === "PASS" ? "绿灯放行，无失败派单简报。" : "暂无（尚未跑出红灯）。"}
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-4">
      <p className="font-bold text-red-700">
        失败派单简报 · {String(briefs.briefs.length)} 份（红灯自动生成，供 AI 读简报修复）
      </p>
      <ul className="mt-2 space-y-2">
        {briefs.briefs.map((b) => (
          <li key={b.id} className="rounded-lg border border-red-200 bg-white p-3 text-sm">
            <p className="font-semibold text-zinc-800">
              {b.severity === "critical" ? "严重" : "重要"} · {b.id} {b.title}
            </p>
            <p className="mt-1 text-zinc-600">
              诊断：{b.diagnosis}
            </p>
            <p className="mt-1 text-zinc-600">修复建议：{b.suggestedFix}</p>
            <p className="mt-1 text-xs text-zinc-400">修复目标：{b.fixTarget}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function EvalLoopPage() {
  const [snapshot, setSnapshot] = useState<EvalLoopSnapshot | null>(null);
  const [report, setReport] = useState<GateReport | null>(null);
  const [chaos, setChaos] = useState<ChaosLoopResult | null>(null);
  const [bus, setBus] = useState<Bus>("idle");
  const [error, setError] = useState<string | null>(null);

  // 首屏快照：fetch 在 await 之后才 setState（React 19 set-state-in-effect 规则）
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await fetch("/api/eval-loop", { cache: "no-store" });
        const json = (await res.json()) as { ok: boolean; snapshot?: EvalLoopSnapshot };
        if (alive && json.ok && json.snapshot) setSnapshot(json.snapshot);
      } catch {
        /* 首屏快照失败不阻塞页面 */
      }
    }
    void load();
    return () => {
      alive = false;
    };
  }, []);

  const runGate = useCallback(async (mode: "fast" | "full") => {
    setBus(mode === "fast" ? "gate-fast" : "gate-full");
    setError(null);
    try {
      const res = await fetch("/api/eval-loop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "gate", mode }),
      });
      const json = (await res.json()) as { ok: boolean; report?: GateReport; error?: string };
      if (json.ok && json.report) setReport(json.report);
      else setError(json.error ?? "门禁执行失败");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBus("idle");
    }
  }, []);

  const runChaos = useCallback(async () => {
    setBus("chaos");
    setError(null);
    try {
      const res = await fetch("/api/eval-loop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "chaos" }),
      });
      const json = (await res.json()) as { ok: boolean; loop?: ChaosLoopResult; error?: string };
      if (json.ok && json.loop) {
        setChaos(json.loop);
        setReport(json.loop.secondReport);
      } else {
        setError(json.error ?? "破坏演习执行失败");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBus("idle");
    }
  }, []);

  const busy = bus !== "idle";

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold tracking-tight">评测门禁闭环（Day 25 收官）</h1>
      <p className="mt-1 text-sm text-zinc-500">
        25 题 4 层黄金考卷（golden-suite-v2）：前 3 层 100% 强制阻塞，第 4 层按 AutoSxS
        胜率放行；红灯自动生成失败派单简报，AI 读简报定位修复后整卷重考。
        {snapshot ? ` 当前考卷版本：${snapshot.suite.version}` : ""}
      </p>

      {/* 四层门禁政策 */}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {LAYER_DESC.map((l) => (
          <div key={String(l.layer)} className="rounded-xl border border-zinc-200 bg-white p-3">
            <p className="text-sm font-bold text-zinc-800">
              第 {String(l.layer)} 层 {l.name}
            </p>
            <p className="mt-1 text-xs text-zinc-500">{l.rule}</p>
          </div>
        ))}
      </div>

      {/* 操作按钮 */}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          onClick={() => runGate("fast")}
          disabled={busy}
          className="rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 disabled:opacity-50"
        >
          {bus === "gate-fast" ? "跑前 2 层 12 题…" : "① 跑 fast 快速门禁（12 题 · 约 20 秒）"}
        </button>
        <button
          onClick={() => runGate("full")}
          disabled={busy}
          className="rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 disabled:opacity-50"
        >
          {bus === "gate-full" ? "跑全量 25 题…" : "② 跑全量 25 题门禁（约 1 分钟）"}
        </button>
        <button
          onClick={runChaos}
          disabled={busy}
          className="rounded-xl border-2 border-amber-400 bg-amber-50 px-4 py-2.5 text-sm font-bold text-amber-700 transition-colors hover:bg-amber-100 disabled:opacity-50"
        >
          {bus === "chaos" ? "破坏演习进行中（约 2 分钟）…" : "③ 一键破坏演习：改坏 5 万红线 → 红灯 → AI 修绿"}
        </button>
      </div>
      <p className="mt-2 text-xs text-zinc-400">
        红线提示：破坏演习只在内存里注入坏阈值（等效改回已废止的 10 万旧制度），绝不修改源文件；本页全程无打款按钮、不写业务系统正式数据。
      </p>

      {busy && (
        <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700">
          引擎正在逐题判卷（离线高仿真），请稍候…
        </div>
      )}
      {error && (
        <div className="mt-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* 门禁报告 */}
      {report && (
        <section className="mt-6 space-y-4">
          <VerdictBanner report={report} />
          {report.layers.map((l) => (
            <LayerTable key={String(l.layer)} layer={l} />
          ))}
          {report.autosxs && <AutoSxsCard report={report.autosxs} />}
        </section>
      )}

      {/* 破坏演习时间线 */}
      {chaos && (
        <section className="mt-6">
          <ChaosTimeline loop={chaos} />
        </section>
      )}

      {/* 派单简报 */}
      {snapshot && (
        <section className="mt-6">
          <BriefsCard snapshot={snapshot} />
        </section>
      )}
    </main>
  );
}
