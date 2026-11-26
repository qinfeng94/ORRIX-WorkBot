"use client";

/**
 * /adoption-ops —— Day 38 灰度采用监控台
 * 老板看板只放四个硬指标：平均审单周期 / 人工返工率 / 绕行回 Excel 逃逸率 / 真实拦截止损额。
 * Token 消耗、调用次数等过程虚荣指标物理不进本页。
 * 三阶段信任阶梯：Shadow 影子 → Assisted 辅助 → Supervised 全员扩量；
 * 【一键运行 20 单影子模式对拍】直观对比老员工历史结果与 WorkBot 后台静默结果。
 * 红线：影子对拍只读快照、WorkBot 结果绝不推送给业务；无打款按钮；台账只增不改。
 */

import { useCallback, useEffect, useState } from "react";
import type {
  AdoptionSnapshot,
  HardMetric,
  RescueTrendPoint,
  ShadowReport,
} from "@/lib/workbot/adoption-ops";

type Bus = "idle" | "running";

function fmtMoney(n: number): string {
  return `¥${n.toLocaleString("zh-CN")}`;
}

function fmtRate(rate: number): string {
  return `${String(Math.round(rate * 100))}%`;
}

/** 危机横幅：试点首周数据（虚构演示口径，与 .fde/day38-pilot-rescue-plan.md 一致） */
function CrisisBanner() {
  return (
    <div className="mt-4 rounded-xl border-2 border-red-300 bg-red-50 p-4">
      <p className="font-bold text-red-700">
        试点危机回退中：首周人工返工率 38% · 绕行回 Excel 逃逸率 45%
      </p>
      <p className="mt-1 text-sm text-red-600">
        林总已叫停全员推广，全量回退 Shadow 影子模式，按 7 天抢救方案重新攀登信任阶梯（见下方阶梯与
        .fde/day38-pilot-rescue-plan.md）。 WorkBot 影子判定全程后台静默，业务人员无感。
      </p>
    </div>
  );
}

/** 单张硬指标卡：只有业务结果，没有虚荣指标 */
function MetricCard({ m, trend }: { m: HardMetric; trend: RescueTrendPoint[] }) {
  const up = m.goodDirection === "up";
  const betterNow = up ? m.current > m.crisis : m.current < m.crisis;
  const bars =
    m.key === "reworkRate"
      ? trend.map((t) => t.reworkRate)
      : m.key === "bypassRate"
        ? trend.map((t) => t.bypassRate)
        : null;
  const barMax = bars ? Math.max(...bars, 1) : 1;

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-bold text-zinc-800">{m.label}</p>
        <span
          className={`rounded-lg px-2 py-0.5 text-xs font-bold ${
            betterNow ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
          }`}
        >
          {betterNow ? (up ? "↑ 变好" : "↓ 变好") : up ? "↓ 预警" : "↑ 预警"}
        </span>
      </div>
      <p className="mt-2 text-3xl font-bold tracking-tight text-zinc-900">
        {m.key === "interceptedLoss" ? fmtMoney(m.current) : `${String(m.current)}${m.unit === "%" ? "%" : ""}`}
        {m.key === "interceptedLoss" || m.unit === "%" ? null : <span className="ml-1 text-sm font-semibold text-zinc-400">{m.unit}</span>}
      </p>
      <ul className="mt-2 space-y-1 text-xs text-zinc-500">
        <li>纯人工基线（试点前 30 天）：{m.key === "interceptedLoss" ? fmtMoney(m.baseline) : `${String(m.baseline)}${m.unit}`}</li>
        <li>
          试点首周危机值：
          <span className="font-bold text-red-600">
            {m.key === "interceptedLoss" ? fmtMoney(m.crisis) : `${String(m.crisis)}${m.unit}`}
          </span>
        </li>
        <li>{m.note}</li>
      </ul>
      {bars && (
        <div className="mt-3 flex items-end gap-1" title="抢救周 D1~D7 逐日">
          {bars.map((v, i) => (
            <div key={i} className="flex flex-1 flex-col items-center gap-0.5">
              <div
                className="w-full rounded-t bg-amber-400"
                style={{ height: `${String(Math.round((v / barMax) * 40))}px` }}
              />
              <span className="text-[10px] text-zinc-400">{`D${String(i + 1)}`}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 三阶段信任阶梯：总进度条 + 三张阶段卡 */
function TrustLadder({ snapshot }: { snapshot: AdoptionSnapshot }) {
  const stageColor = (status: string) =>
    status === "done"
      ? "bg-emerald-500"
      : status === "active"
        ? "bg-blue-500"
        : "bg-zinc-300";

  return (
    <section className="mt-8">
      <h2 className="text-xl font-bold text-zinc-900">三阶段信任阶梯</h2>
      <p className="mt-1 text-sm text-zinc-500">
        危机回退后从 Shadow 重新起步；每一级晋级都由硬指标说了算，不由任何人的感觉说了算。
      </p>

      {/* 总进度条 */}
      <div className="mt-4 flex h-6 w-full overflow-hidden rounded-full bg-zinc-200">
        {snapshot.stages.map((s) => (
          <div
            key={s.key}
            className="relative h-full"
            style={{ width: `${(100 / snapshot.stages.length).toFixed(2)}%` }}
          >
            <div
              className={`h-full ${stageColor(s.status)}`}
              style={{ width: `${String(Math.min(s.progressPct, 100))}%` }}
            />
            <span className="absolute inset-0 grid place-items-center text-[11px] font-bold text-white drop-shadow">
              {s.name.split(" ")[0]}
            </span>
          </div>
        ))}
      </div>

      {/* 三张阶段卡 */}
      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
        {snapshot.stages.map((s) => (
          <div
            key={s.key}
            className={`rounded-xl border p-4 ${
              s.status === "active"
                ? "border-blue-300 bg-blue-50"
                : s.status === "done"
                  ? "border-emerald-300 bg-emerald-50"
                  : "border-zinc-200 bg-white opacity-70"
            }`}
          >
            <div className="flex items-center justify-between">
              <p className="font-bold text-zinc-800">{s.name}</p>
              <span
                className={`rounded-lg px-2 py-0.5 text-xs font-bold ${
                  s.status === "done"
                    ? "bg-emerald-600 text-white"
                    : s.status === "active"
                      ? "bg-blue-600 text-white"
                      : "bg-zinc-400 text-white"
                }`}
              >
                {s.status === "done" ? "已通过" : s.status === "active" ? "当前阶段" : "未解锁"}
              </span>
            </div>
            <p className="mt-1 text-xs text-zinc-500">{s.subtitle}</p>
            <p className="mt-2 rounded-lg bg-white/70 p-2 text-xs font-semibold text-zinc-700">
              {s.progressLabel}
            </p>
            <div className="mt-3 space-y-2 text-xs">
              <div>
                <p className="font-bold text-zinc-600">晋级硬门槛（exit）</p>
                <ul className="mt-1 list-inside list-disc space-y-0.5 text-zinc-500">
                  {s.exitCriteria.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="font-bold text-red-600">回退触发器（一票回退）</p>
                <ul className="mt-1 list-inside list-disc space-y-0.5 text-zinc-500">
                  {s.rollbackTriggers.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** 对拍结果：裁定横幅 + 分歧复盘表 + 20 单明细 */
function ShadowReportView({ report }: { report: ShadowReport }) {
  const pass = report.consistencyRate >= report.passThreshold;
  return (
    <section className="mt-6 space-y-4">
      <div
        className={`rounded-xl border-2 p-4 ${
          pass ? "border-emerald-300 bg-emerald-50" : "border-amber-300 bg-amber-50"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={`text-lg font-bold ${pass ? "text-emerald-700" : "text-amber-700"}`}>
            第 {String(report.round)} 轮影子对拍 · 一致率 {fmtRate(report.consistencyRate)}
            （{String(report.matched)}/{String(report.total)}）
            {pass ? " · 达晋级线" : " · 未达 90% 晋级线"}
          </p>
          <p className="text-sm font-semibold text-zinc-600">
            连续达标 {String(report.consecutivePassRounds)}/2 轮 ·{" "}
            {report.promotionReady ? "Shadow 晋级门槛已满足" : "继续对拍"}
          </p>
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          <span className="rounded-lg bg-white px-2.5 py-1 font-semibold text-zinc-700">
            WorkBot 多拦争议金额：<span className="text-emerald-700">{fmtMoney(report.botExtraIntercepted)}</span>
          </span>
          <span className="rounded-lg bg-white px-2.5 py-1 font-semibold text-zinc-700">
            老员工平均 {String(Math.round(report.humanAvgMinutes))} 分钟/单
          </span>
          <span className="rounded-lg bg-white px-2.5 py-1 font-semibold text-zinc-700">
            WorkBot 静默 {String(Math.round(report.botAvgSeconds))} 秒/单（不出结果给业务）
          </span>
          {report.aliasKnowledgeApplied && (
            <span className="rounded-lg bg-purple-100 px-2.5 py-1 font-semibold text-purple-700">
              已应用 D4 供应商别名知识卡
            </span>
          )}
        </div>
      </div>

      {/* 分歧复盘 */}
      <div className="rounded-xl border border-zinc-200 bg-white">
        <div className="border-b border-zinc-100 px-4 py-2.5">
          <p className="font-bold text-zinc-800">
            分歧复盘（{String(report.divergences.length)} 处）—— 每一处都给出裁决与处置，不和稀泥
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-xs text-zinc-500">
                <th className="px-4 py-2">单号</th>
                <th className="px-4 py-2">分歧点</th>
                <th className="px-4 py-2">老员工结论</th>
                <th className="px-4 py-2">WorkBot 静默结论</th>
                <th className="px-4 py-2">裁决</th>
                <th className="px-4 py-2">处置</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {report.divergences.map((d) => (
                <tr key={d.id}>
                  <td className="px-4 py-2 font-semibold text-zinc-800">{d.id}</td>
                  <td className="px-4 py-2 text-zinc-600">{d.summary}</td>
                  <td className="px-4 py-2 text-zinc-600">
                    <span className="font-semibold">{d.humanVerdict}</span> · {d.humanReason}
                  </td>
                  <td className="px-4 py-2 text-zinc-600">
                    <span className="font-semibold">{d.botVerdict}</span> · {d.botReason}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`rounded-lg px-2 py-0.5 text-xs font-bold ${
                        d.winner === "bot"
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-purple-100 text-purple-700"
                      }`}
                    >
                      {d.winner === "bot" ? "WorkBot 对" : "老员工对"}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-zinc-500">{d.disposition}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 20 单明细 */}
      <details className="rounded-xl border border-zinc-200 bg-white p-4">
        <summary className="cursor-pointer font-bold text-zinc-800">
          展开 20 单对拍明细（老员工历史结果 vs WorkBot 后台静默结果）
        </summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-xs text-zinc-500">
                <th className="py-2 pr-3">单号</th>
                <th className="py-2 pr-3">类型</th>
                <th className="py-2 pr-3">供应商（虚构）</th>
                <th className="py-2 pr-3 text-right">金额</th>
                <th className="py-2 pr-3">老员工</th>
                <th className="py-2 pr-3">WorkBot</th>
                <th className="py-2">一致</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {report.pairs.map((p) => (
                <tr key={p.id}>
                  <td className="py-2 pr-3 font-semibold text-zinc-800">{p.id}</td>
                  <td className="py-2 pr-3 text-zinc-500">{p.kind}</td>
                  <td className="py-2 pr-3 text-zinc-500">{p.vendor}</td>
                  <td className="py-2 pr-3 text-right text-zinc-700">{fmtMoney(p.amount)}</td>
                  <td className="py-2 pr-3 text-zinc-600">
                    {p.humanVerdict}
                    <span className="ml-1 text-xs text-zinc-400">{String(p.humanMinutes)}min</span>
                  </td>
                  <td className="py-2 pr-3 text-zinc-600">
                    {p.botVerdict}
                    <span className="ml-1 text-xs text-zinc-400">{String(p.botSeconds)}s</span>
                  </td>
                  <td className="py-2">
                    {p.match ? (
                      <span className="text-emerald-600">✅</span>
                    ) : (
                      <span className="text-amber-600" title={p.disposition}>
                        ⚠ {p.winner === "bot" ? "机对" : "人对"}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

export default function AdoptionOpsPage() {
  const [snapshot, setSnapshot] = useState<AdoptionSnapshot | null>(null);
  const [report, setReport] = useState<ShadowReport | null>(null);
  const [bus, setBus] = useState<Bus>("idle");
  const [error, setError] = useState<string | null>(null);

  // 首屏快照：fetch 在 await 之后才 setState（React 19 set-state-in-effect 规则）
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await fetch("/api/adoption-ops", { cache: "no-store" });
        const json = (await res.json()) as { ok: boolean; snapshot?: AdoptionSnapshot };
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

  const runShadow = useCallback(async () => {
    setBus("running");
    setError(null);
    try {
      const res = await fetch("/api/adoption-ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "shadow-run" }),
      });
      const json = (await res.json()) as { ok: boolean; report?: ShadowReport; error?: string };
      if (json.ok && json.report) {
        setReport(json.report);
        // 顺手刷新阶梯进度（不阻塞主报告展示）
        const snapRes = await fetch("/api/adoption-ops", { cache: "no-store" });
        const snapJson = (await snapRes.json()) as { ok: boolean; snapshot?: AdoptionSnapshot };
        if (snapJson.ok && snapJson.snapshot) setSnapshot(snapJson.snapshot);
      } else {
        setError(json.error ?? "影子对拍执行失败");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBus("idle");
    }
  }, []);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold tracking-tight">灰度采用监控台（Day 38）</h1>
      <p className="mt-1 text-sm text-zinc-500">
        只放老板真正在乎的四个硬指标——不放 Token 消耗、调用次数这类过程虚荣指标。
        采用不靠宣传靠证据：影子对拍一致率决定能不能晋级，硬指标回退一票打回上一级。
      </p>

      {snapshot && <CrisisBanner />}

      {/* 四硬指标 */}
      <section className="mt-6">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(snapshot?.metrics ?? []).map((m) => (
            <MetricCard key={m.key} m={m} trend={snapshot?.trend ?? []} />
          ))}
        </div>
        <p className="mt-2 text-xs text-zinc-400">
          数据口径：只读工单池快照 + 通道埋点实测；示例数据均为虚构演示内容。
          本看板刻意不展示 Token 消耗 / 调用次数——过程指标只进工程内部分析页（/observability）。
        </p>
      </section>

      {/* 信任阶梯 */}
      {snapshot && <TrustLadder snapshot={snapshot} />}

      {/* 影子对拍 */}
      <section className="mt-8">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={runShadow}
            disabled={bus !== "idle"}
            className="rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 disabled:opacity-50"
          >
            {bus === "running"
              ? "20 单影子对拍进行中…"
              : "一键运行 20 单影子模式对拍（老员工 vs WorkBot 静默）"}
          </button>
          {snapshot && (
            <span className="text-xs text-zinc-500">
              已累计 {String(snapshot.totalRuns)} 轮对拍 · 台账 data/day38/shadow_comparisons.jsonl 只增不改
            </span>
          )}
        </div>
        <p className="mt-2 text-xs text-zinc-400">
          红线提示：影子对拍全程只读工单池快照，WorkBot 判定结果绝不推送给业务人员（避免无监督误导）；
          对拍不产生任何打款 / 写业务数据动作；第 2 轮起自动应用抢救方案 D4 回流的供应商别名知识卡。
        </p>
      </section>

      {bus === "running" && (
        <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700">
          正在回放 20 单历史工单快照并逐单对拍（离线高仿真）…
        </div>
      )}
      {error && (
        <div className="mt-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {report && <ShadowReportView report={report} />}

      <footer className="mt-10 border-t border-zinc-200 pt-4 text-xs text-zinc-400">
        本页所有工单、供应商与金额均为虚构演示数据；红线约束见 AGENTS.md（FIN-001 超 ¥50,000 强制人工审批、
        严禁自动打款、严禁直写业务系统正式数据、审计台账只增不改）。
      </footer>
    </main>
  );
}
