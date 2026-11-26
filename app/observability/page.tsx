"use client";

/**
 * /observability —— Day 19 生产可观测性大屏
 * 溯源：AGENTS.md 日志红线（只增不改）+ 代码红线 3（PII 绝不明文落库）；
 *      04 号文档 CISO 条款 4（全过程留痕）。
 * 三大板块：
 * ① 提示词版本管理：3 秒一键热回滚至 v1.0（纯数据操作，无需重新部署，下一次对话立即生效）；
 * ② 延迟与成本仪表盘 + 全链路 Trace 列表（瀑布图可展开）；
 * ③ PII 脱敏监控日志（写入前已过 scrubPii，页面可现场验证脱敏效果）。
 * 边界：本页面只有只读数据展示 + 提示词版本切换 + 脱敏演示，绝不出现任何打款类按钮。
 */

import { useCallback, useEffect, useState } from "react";

/* ---------------- 类型（与 /api/observability GET 响应同源） ---------------- */

interface SpanRow {
  seq: number;
  role: string;
  attempt: number;
  label: string;
  status: string;
  durationMs: number;
  costUsd: string;
  detail: string;
}

interface TraceRow {
  traceId: string;
  questionLabel: string;
  status: string;
  reworkCount: number;
  totalDurationMs: number;
  totalCostUsd: string;
  escalateReason: string;
  createdAt: string;
  spans: SpanRow[];
}

interface UsageSummary {
  callCount: number;
  avgTtftMs: number;
  maxTtftMs: number;
  avgTotalMs: number;
  totalUsdCost: number;
  fallbackCount: number;
  byProvider: { providerId: string; calls: number; usdCost: number }[];
  recent: {
    providerId: string;
    model: string;
    mode: string;
    ttftMs: number;
    totalMs: number;
    usdCost: string;
    wasFallback: boolean;
    questionLabel: string;
    createdAt: string;
  }[];
}

interface MonitorRow {
  id: number;
  sessionId: string;
  questionLabel: string;
  promptVersion: string;
  requestText: string;
  responseText: string;
  piiRedactions: number;
  latencyMs: number;
  createdAt: string;
}

interface PromptRow {
  version: string;
  label: string;
  content: string;
  isFaulty: boolean;
  isActive: boolean;
  activatedAt: string | null;
}

interface ObservationData {
  traces: TraceRow[];
  usage: UsageSummary;
  monitors: MonitorRow[];
  prompts: PromptRow[];
}

/* ---------------- 小组件 ---------------- */

function KpiCard(props: { label: string; value: string; sub?: string; tone?: "default" | "amber" | "green" | "red" }) {
  const tone =
    props.tone === "amber"
      ? "border-amber-300 bg-amber-50"
      : props.tone === "green"
        ? "border-emerald-300 bg-emerald-50"
        : props.tone === "red"
          ? "border-red-300 bg-red-50"
          : "border-zinc-200 bg-white";
  return (
    <div className={`rounded-xl border p-4 ${tone}`}>
      <div className="text-xs font-semibold text-zinc-500">{props.label}</div>
      <div className="mt-1 text-2xl font-bold tracking-tight text-zinc-900">{props.value}</div>
      {props.sub ? <div className="mt-0.5 text-xs text-zinc-500">{props.sub}</div> : null}
    </div>
  );
}

function TraceStatusBadge(props: { status: string }) {
  const map: Record<string, string> = {
    completed: "bg-emerald-100 text-emerald-800",
    escalated: "bg-amber-100 text-amber-800",
    blocked: "bg-red-100 text-red-800",
  };
  const label: Record<string, string> = {
    completed: "质检放行",
    escalated: "转人工",
    blocked: "入口拦截",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${map[props.status] ?? "bg-zinc-100 text-zinc-700"}`}>
      {label[props.status] ?? props.status}
    </span>
  );
}

function SpanStatusDot(props: { status: string }) {
  const map: Record<string, string> = {
    ok: "bg-emerald-500",
    rejected: "bg-amber-500",
    rewritten: "bg-amber-500",
    escalated: "bg-amber-600",
    blocked: "bg-red-500",
  };
  return <span className={`inline-block h-2 w-2 rounded-full ${map[props.status] ?? "bg-zinc-400"}`} />;
}

/* ---------------- 主页面 ---------------- */

/** 拉取观测数据（纯请求，无 setState——effect 与手动刷新共用同一取数逻辑） */
async function fetchObservations(): Promise<ObservationData> {
  const res = await fetch("/api/observability", { cache: "no-store" });
  const json: unknown = await res.json();
  if (!res.ok) {
    const detail =
      typeof json === "object" && json !== null && "detail" in json
        ? String((json as { detail?: unknown }).detail ?? "")
        : "";
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return json as ObservationData;
}

export default function ObservabilityPage() {
  const [data, setData] = useState<ObservationData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);

  const [rolling, setRolling] = useState(false);
  const [rollbackMsg, setRollbackMsg] = useState("");
  const [rollbackOk, setRollbackOk] = useState<boolean | null>(null);

  const [scrubInput, setScrubInput] = useState("");
  const [scrubResult, setScrubResult] = useState("");
  const [scrubStats, setScrubStats] = useState("");
  const [expandedTrace, setExpandedTrace] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      setData(await fetchObservations());
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : "观测数据加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  // 首屏加载：所有 setState 都发生在 await 之后（react-hooks/set-state-in-effect 合规）
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await fetchObservations();
        if (alive) setData(d);
      } catch (err: unknown) {
        if (alive) setLoadError(err instanceof Error ? err.message : "观测数据加载失败");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /** 切换提示词版本（热回滚 / 故障演练共用同一入口，服务端实测耗时） */
  const activateVersion = useCallback(
    async (version: string) => {
      setRolling(true);
      setRollbackMsg("");
      setRollbackOk(null);
      try {
        const res = await fetch("/api/observability", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "activate", version }),
        });
        const json: unknown = await res.json();
        const ok = typeof json === "object" && json !== null && "ok" in json && (json as { ok?: unknown }).ok === true;
        const message =
          typeof json === "object" && json !== null && "message" in json
            ? String((json as { message?: unknown }).message ?? "")
            : "";
        const elapsed =
          typeof json === "object" && json !== null && "elapsedMs" in json
            ? Number((json as { elapsedMs?: unknown }).elapsedMs ?? 0)
            : 0;
        if (!ok) {
          const errMsg =
            typeof json === "object" && json !== null && "error" in json
              ? String((json as { error?: unknown }).error ?? "")
              : `HTTP ${res.status}`;
          throw new Error(errMsg);
        }
        setRollbackOk(true);
        setRollbackMsg(
          elapsed > 0
            ? `${message}（服务端实测 ${elapsed}ms）`
            : message,
        );
        await load();
      } catch (err: unknown) {
        setRollbackOk(false);
        setRollbackMsg(err instanceof Error ? err.message : "切换失败");
      } finally {
        setRolling(false);
      }
    },
    [load],
  );

  const runScrubTest = useCallback(async () => {
    setScrubResult("");
    setScrubStats("");
    try {
      const res = await fetch("/api/observability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "scrub_test", text: scrubInput }),
      });
      const json: unknown = await res.json();
      if (!res.ok) {
        const errMsg =
          typeof json === "object" && json !== null && "error" in json
            ? String((json as { error?: unknown }).error ?? "")
            : `HTTP ${res.status}`;
        throw new Error(errMsg);
      }
      const obj = json as { scrubbed?: unknown; stats?: { total?: unknown } };
      setScrubResult(String(obj.scrubbed ?? ""));
      const total = Number(obj.stats?.total ?? 0);
      setScrubStats(total > 0 ? `共拦下 ${total} 处 PII` : "未发现 PII");
    } catch (err: unknown) {
      setScrubResult("");
      setScrubStats(err instanceof Error ? err.message : "脱敏演示失败");
    }
  }, [scrubInput]);

  const prompts = data?.prompts ?? [];
  const stableVersion = prompts.find((p) => !p.isFaulty);
  const activeVersion = prompts.find((p) => p.isActive);
  const stableActive = stableVersion?.isActive ?? false;
  const usage = data?.usage;
  const maxProviderCost =
    usage && usage.byProvider.length > 0
      ? Math.max(...usage.byProvider.map((p) => p.usdCost), 0.0001)
      : 1;

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
      {/* 页头 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900">生产可观测性大屏</h1>
          <p className="mt-1 text-sm text-zinc-600">
            全链路 Trace · 延迟与成本 · PII 脱敏监控（落库前强制脱敏）· 3 秒 Prompt 热回滚（无需重新部署）
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50"
        >
          {loading ? "刷新中…" : "刷新数据"}
        </button>
      </div>

      {loadError ? (
        <div className="mt-4 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-700">
          观测数据加载失败：{loadError}（请确认数据库已接入后重试）
        </div>
      ) : null}

      {/* ① 提示词版本管理 + 热回滚 */}
      <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-zinc-900">提示词版本管理</h2>
          <div className="text-xs text-zinc-500">
            当前激活：
            <span className={`ml-1 rounded-full px-2 py-0.5 font-semibold ${activeVersion?.isFaulty ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"}`}>
              {activeVersion ? `${activeVersion.version}（${activeVersion.label}）` : "未知"}
            </span>
          </div>
        </div>

        {/* 3 秒热回滚主按钮 */}
        <div className="mt-4 rounded-xl border-2 border-dashed border-amber-400 bg-amber-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-amber-900">
              <span className="font-bold">3 秒一键热回滚：</span>
              点击后无需重新部署代码，下一次对话立即恢复 v1.0 稳定表现（纯数据切换，审计留痕）。
            </div>
            <button
              onClick={() => stableVersion && void activateVersion(stableVersion.version)}
              disabled={rolling || stableActive || !stableVersion}
              className="rounded-lg bg-amber-500 px-5 py-2.5 text-sm font-bold text-white shadow transition-colors hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {rolling ? "回滚中…" : stableActive ? "✓ 已在 v1.0 稳定版" : "3 秒一键热回滚至 v1.0"}
            </button>
          </div>
          {rollbackMsg ? (
            <div className={`mt-3 rounded-lg px-3 py-2 text-sm ${rollbackOk ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>
              {rollbackMsg}
            </div>
          ) : null}
          {activeVersion?.isFaulty ? (
            <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              当前激活的是故障演练版：对话会引用已废止的旧版 10 万额度制度并越权承诺 AI 直接退款（违反 FIN-001）。可去对话工作台问「CUST-8842 重复扣款」观察故障表现，再点上面按钮热回滚对比。
            </div>
          ) : null}
        </div>

        {/* 版本清单 */}
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {prompts.map((p) => (
            <div
              key={p.version}
              className={`rounded-xl border p-4 ${p.isActive ? (p.isFaulty ? "border-red-400 bg-red-50" : "border-emerald-400 bg-emerald-50") : "border-zinc-200 bg-white"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="font-bold text-zinc-900">
                  {p.version} · {p.label}
                </div>
                {p.isActive ? (
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${p.isFaulty ? "bg-red-600 text-white" : "bg-emerald-600 text-white"}`}>
                    {p.isFaulty ? "激活中（故障）" : "激活中（稳定）"}
                  </span>
                ) : (
                  <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-600">未激活</span>
                )}
              </div>
              <p className="mt-2 line-clamp-3 text-xs leading-5 text-zinc-600">{p.content}</p>
              <div className="mt-2 text-xs text-zinc-500">
                最近激活：{p.activatedAt ? new Date(p.activatedAt).toLocaleString("zh-CN") : "从未激活"}
              </div>
              {!p.isActive ? (
                <button
                  onClick={() => void activateVersion(p.version)}
                  disabled={rolling}
                  className={`mt-2 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${p.isFaulty ? "border border-red-300 text-red-600 hover:bg-red-50" : "border border-zinc-300 text-zinc-700 hover:bg-zinc-50"}`}
                >
                  {p.isFaulty ? "演练：切换到此故障版" : "激活此版本"}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      {/* ② 延迟与成本仪表盘 */}
      <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5">
        <h2 className="text-lg font-bold text-zinc-900">延迟与成本仪表盘</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <KpiCard label="调用次数（近 50 条）" value={String(usage?.callCount ?? 0)} />
          <KpiCard label="平均首字延迟" value={`${usage?.avgTtftMs ?? 0} ms`} />
          <KpiCard
            label="最大首字延迟"
            value={`${usage?.maxTtftMs ?? 0} ms`}
            tone={(usage?.maxTtftMs ?? 0) > 2000 ? "amber" : "default"}
          />
          <KpiCard label="平均总耗时" value={`${usage?.avgTotalMs ?? 0} ms`} />
          <KpiCard label="总成本（美元）" value={`$${(usage?.totalUsdCost ?? 0).toFixed(4)}`} tone="green" />
          <KpiCard
            label="主→备故障切换"
            value={`${usage?.fallbackCount ?? 0} 次`}
            tone={(usage?.fallbackCount ?? 0) > 0 ? "amber" : "default"}
          />
        </div>

        {/* 分厂商成本条 */}
        {usage && usage.byProvider.length > 0 ? (
          <div className="mt-4 space-y-2">
            {usage.byProvider.map((p) => (
              <div key={p.providerId} className="flex items-center gap-3 text-sm">
                <span className="w-24 font-semibold text-zinc-700">{p.providerId}</span>
                <div className="h-3 flex-1 overflow-hidden rounded-full bg-zinc-100">
                  <div
                    className="h-full rounded-full bg-zinc-800"
                    style={{ width: `${Math.max((p.usdCost / maxProviderCost) * 100, 2)}%` }}
                  />
                </div>
                <span className="w-44 text-right text-xs text-zinc-500">
                  {p.calls} 次调用 · ${p.usdCost.toFixed(4)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm text-zinc-500">暂无调用记录——去对话工作台问一句话，这里就会出现数据。</p>
        )}

        {/* 最近调用明细 */}
        {usage && usage.recent.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-xs text-zinc-500">
                  <th className="py-2 pr-3 font-semibold">时间</th>
                  <th className="py-2 pr-3 font-semibold">厂商 / 模型</th>
                  <th className="py-2 pr-3 font-semibold">模式</th>
                  <th className="py-2 pr-3 font-semibold">首字延迟</th>
                  <th className="py-2 pr-3 font-semibold">总耗时</th>
                  <th className="py-2 pr-3 font-semibold">花费</th>
                  <th className="py-2 pr-3 font-semibold">业务流</th>
                </tr>
              </thead>
              <tbody>
                {usage.recent.map((r, i) => (
                  <tr key={i} className="border-b border-zinc-100">
                    <td className="py-2 pr-3 text-xs text-zinc-500">{new Date(r.createdAt).toLocaleTimeString("zh-CN")}</td>
                    <td className="py-2 pr-3">
                      {r.providerId} / {r.model}
                      {r.wasFallback ? <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">已切换</span> : null}
                    </td>
                    <td className="py-2 pr-3 text-xs">{r.mode}</td>
                    <td className="py-2 pr-3">{r.ttftMs} ms</td>
                    <td className="py-2 pr-3">{r.totalMs} ms</td>
                    <td className="py-2 pr-3">${r.usdCost}</td>
                    <td className="py-2 pr-3 text-xs text-zinc-600">{r.questionLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {/* ③ 全链路 Trace 列表 */}
      <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5">
        <h2 className="text-lg font-bold text-zinc-900">全链路 Trace 列表（客服专班流水线）</h2>
        {data && data.traces.length > 0 ? (
          <div className="mt-3 space-y-2">
            {data.traces.map((t) => (
              <div key={t.traceId} className="rounded-xl border border-zinc-200">
                <button
                  onClick={() => setExpandedTrace(expandedTrace === t.traceId ? null : t.traceId)}
                  className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left transition-colors hover:bg-zinc-50"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-zinc-900">{t.traceId}</span>
                    <TraceStatusBadge status={t.status} />
                    {t.reworkCount > 0 ? (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">返工 {t.reworkCount} 次</span>
                    ) : null}
                    <span className="text-xs text-zinc-600">{t.questionLabel}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-zinc-500">
                    <span>{t.totalDurationMs} ms</span>
                    <span>${t.totalCostUsd}</span>
                    <span>{new Date(t.createdAt).toLocaleString("zh-CN")}</span>
                    <span className="font-bold">{expandedTrace === t.traceId ? "收起 ▲" : `展开 ${t.spans.length} 步 ▼`}</span>
                  </div>
                </button>
                {expandedTrace === t.traceId && t.spans.length > 0 ? (
                  <div className="border-t border-zinc-100 px-4 py-3">
                    <div className="space-y-1.5">
                      {t.spans.map((s) => {
                        const maxSpanMs = Math.max(...t.spans.map((x) => x.durationMs), 1);
                        return (
                          <div key={`${t.traceId}-${s.seq}-${s.attempt}`} className="flex items-center gap-2 text-xs">
                            <SpanStatusDot status={s.status} />
                            <span className="w-28 shrink-0 font-semibold text-zinc-700">{s.label}</span>
                            <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-zinc-100">
                              <div
                                className={`h-full rounded-full ${s.status === "ok" ? "bg-emerald-500" : s.status === "blocked" ? "bg-red-500" : "bg-amber-500"}`}
                                style={{ width: `${Math.max((s.durationMs / maxSpanMs) * 100, 3)}%` }}
                              />
                            </div>
                            <span className="w-20 text-right text-zinc-500">{s.durationMs} ms</span>
                            <span className="w-16 text-right text-zinc-400">${s.costUsd}</span>
                            <span className="hidden w-64 truncate text-zinc-500 md:inline">{s.detail}</span>
                          </div>
                        );
                      })}
                    </div>
                    {t.escalateReason ? (
                      <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">转人工原因：{t.escalateReason}</div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-sm text-zinc-500">暂无 Trace——去「客服专班」跑一次流水线，这里就会出现瀑布图。</p>
        )}
      </section>

      {/* ④ PII 脱敏监控日志 */}
      <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-bold text-zinc-900">PII 脱敏监控日志</h2>
          <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-semibold text-zinc-600">
            写入前强制过 scrubPii · 手机号 / 身份证号 / 银行卡号 → [REDACTED_PII] · 只增不改
          </span>
        </div>

        {/* 现场脱敏演示 */}
        <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 p-4">
          <div className="text-xs font-semibold text-zinc-600">现场验证脱敏（确定性工具，不经过大模型）</div>
          <div className="mt-2 grid gap-2 text-xs leading-5 text-zinc-600 md:grid-cols-3">
            <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2">
              <span className="font-bold text-zinc-800">第 1 步 · 贴文本</span>
              <br />
              在下方输入框贴一段含敏感信息的文本（占位提示里有一键可抄的示例，均为虚构演示数据）。
            </div>
            <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2">
              <span className="font-bold text-zinc-800">第 2 步 · 点运行</span>
              <br />
              点「运行 scrubPii 演示」——服务器端确定性正则即时处理，全流程不调用大模型。
            </div>
            <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2">
              <span className="font-bold text-zinc-800">第 3 步 · 对结果</span>
              <br />
              绿色框回显脱敏后文本，敏感串已变 <span className="font-mono">[REDACTED_PII]</span>，旁标统计「共拦下 N 处 PII」。
            </div>
          </div>
          <div className="mt-2 rounded-lg bg-white px-3 py-2 text-xs leading-5 text-zinc-600">
            <span className="font-bold text-zinc-800">识别范围：</span>
            手机号（1 开头第 2 位 3-9 的 11 位）· 身份证号（18 位，含尾号 X）· 银行卡号（13~19 位，支持空格 / 连字符分组）。
            <span className="font-bold text-zinc-800">绝不误杀：</span>
            工单号 TCK-xxxx、客户号 CUST-xxxx、审批单 AP-xxxx、日期与金额等业务编号原样保留。
            <span className="font-bold text-zinc-800">演示边界：</span>
            本演示只在内存即时回显，不写任何表；真正落库的监控日志（下方列表）在写入前强制过同一把 scrubPii，落库后只增不改。
          </div>
          <textarea
            value={scrubInput}
            onChange={(e) => setScrubInput(e.target.value)}
            rows={2}
            placeholder="随便贴一段含手机号 / 身份证号 / 银行卡号的文本，例如：客户 13812345678，卡号 6222 0212 3456 7890"
            className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 focus:border-zinc-500 focus:outline-none"
          />
          <div className="mt-2 flex items-center gap-3">
            <button
              onClick={() => void runScrubTest()}
              disabled={scrubInput.trim().length === 0}
              className="rounded-lg bg-zinc-900 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-zinc-700 disabled:opacity-40"
            >
              运行 scrubPii 演示
            </button>
            {scrubStats ? <span className="text-xs font-semibold text-zinc-600">{scrubStats}</span> : null}
          </div>
          {scrubResult ? (
            <div className="mt-2 break-all rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 font-mono text-xs text-emerald-900">
              {scrubResult}
            </div>
          ) : null}
        </div>

        {/* 监控日志列表 */}
        {data && data.monitors.length > 0 ? (
          <div className="mt-4 space-y-2">
            {data.monitors.map((m) => (
              <div key={m.id} className="rounded-xl border border-zinc-200 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <span className="font-mono font-semibold text-zinc-700">#{m.id}</span>
                  <span>{new Date(m.createdAt).toLocaleString("zh-CN")}</span>
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-700">{m.questionLabel}</span>
                  <span className={`rounded px-1.5 py-0.5 ${m.promptVersion.includes("v1.1") ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"}`}>
                    提示词 {m.promptVersion}
                  </span>
                  <span className={`rounded px-1.5 py-0.5 ${m.piiRedactions > 0 ? "bg-amber-100 text-amber-800" : "bg-zinc-100 text-zinc-600"}`}>
                    拦截 PII {m.piiRedactions} 处
                  </span>
                  <span>{m.latencyMs} ms</span>
                </div>
                <div className="mt-2 text-xs text-zinc-700">
                  <span className="font-semibold text-zinc-500">请求：</span>
                  <span className="break-all">{m.requestText}</span>
                </div>
                {m.responseText ? (
                  <div className="mt-1 line-clamp-3 text-xs text-zinc-700">
                    <span className="font-semibold text-zinc-500">响应：</span>
                    <span className="break-all">{m.responseText}</span>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm text-zinc-500">暂无监控日志——去对话工作台问一句话（可以故意带上手机号试试），这里就会出现脱敏后的留痕。</p>
        )}
      </section>

      {/* 页脚红线提示 */}
      <footer className="mt-8 rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-xs text-zinc-500">
        红线提示：本页所有日志均为只增不改（数据库触发器物理拒绝篡改）；监控日志落库前已确定性脱敏，PII 绝不明文落库；
        热回滚只切换提示词版本配置，不触碰审批 / 审计数据；全站不存在「AI 自动打款」类按钮。
      </footer>
    </main>
  );
}
