"use client";

/**
 * AuditExperience —— /arch-audit 的交互层（Day 26 架构体检看板）
 * 三块：① 五维红黄绿灯体检卡；② 双迁移前后对比条；③ 零代码规则沙盒。
 * 数据由服务端页面读 .fde/day26-arch-audit.json 与 .fde/day26-migration-metrics.json 传入。
 * 红线：沙盒只在内存覆盖配置副本，绝不改文件、不落库、无任何打款动作。
 */

import { useCallback, useState } from "react";

export interface AuditHit {
  file: string;
  rule: string;
  count: number;
}

export interface AuditDimension {
  id: string;
  name: string;
  score: number;
  status: "GREEN" | "YELLOW" | "RED";
  finding: string;
  recommendation: string;
  hits: AuditHit[];
}

export interface AuditReport {
  auditedAt: string;
  targetDirectory: string;
  totalFilesScanned: number;
  overallScore: number;
  grade: string;
  baseline: { capturedAt: string; overallScore: number; grade: string; note: string };
  lightLegend: string;
  dimensions: AuditDimension[];
}

export interface MigrationMetrics {
  generatedAt: string;
  migrations: {
    id: string;
    name: string;
    before: Record<string, string | number>;
    after: Record<string, string | number>;
    delta?: Record<string, number>;
    latencyNote?: string;
  }[];
  ciGate25: {
    total: number;
    passed: number;
    passRatePct: number;
    zeroRegression: boolean;
    autosxsWinRatePct?: number | null;
    gateDurationMs?: number | null;
    failures: string[];
  };
}

const LIGHT: Record<AuditDimension["status"], { icon: string; ring: string; text: string }> = {
  GREEN: { icon: "🟢", ring: "border-emerald-300 bg-emerald-50", text: "text-emerald-700" },
  YELLOW: { icon: "🟡", ring: "border-amber-300 bg-amber-50", text: "text-amber-700" },
  RED: { icon: "🔴", ring: "border-red-300 bg-red-50", text: "text-red-700" },
};

interface SandboxResult {
  thresholdCny: number;
  amountCny: number;
  department: string;
  decision: { ruleId: string; action: string; blocked: boolean; humanApprovalRequired: boolean; reason: string };
}

function CompareBar({ label, before, after, unit }: { label: string; before: number; after: number; unit: string }) {
  const max = Math.max(before, after, 1);
  const down = after <= before;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="font-semibold text-zinc-700">{label}</span>
        <span className={`font-mono text-xs ${down ? "text-emerald-700" : "text-red-600"}`}>
          {before.toLocaleString("en-US")} → {after.toLocaleString("en-US")} {unit}
        </span>
      </div>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="w-10 shrink-0 text-xs text-zinc-400">术前</span>
          <div className="h-3 w-full rounded bg-zinc-100">
            <div className="h-3 rounded bg-zinc-400" style={{ width: `${(before / max) * 100}%` }} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-10 shrink-0 text-xs text-zinc-400">术后</span>
          <div className="h-3 w-full rounded bg-zinc-100">
            <div
              className={`h-3 rounded ${down ? "bg-emerald-500" : "bg-red-500"}`}
              style={{ width: `${(after / max) * 100}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function PolicySandbox() {
  const [threshold, setThreshold] = useState(50000);
  const [amount, setAmount] = useState(52800);
  const [department, setDepartment] = useState("财务部");
  const [result, setResult] = useState<SandboxResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/arch-audit/test-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thresholdCny: threshold, amountCny: amount, department }),
      });
      const data = (await res.json()) as SandboxResult & { error?: string };
      if (!res.ok) {
        setError(data.error ?? "沙盒调用失败");
        setResult(null);
      } else {
        setResult(data);
      }
    } catch {
      setError("网络异常，请重试");
    } finally {
      setBusy(false);
    }
  }, [threshold, amount, department]);

  const quick = (t: number) => {
    setThreshold(t);
    setResult(null);
  };

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-5">
      <h2 className="text-lg font-bold">零代码规则沙盒：改阈值不改源码</h2>
      <p className="mt-1 text-sm text-zinc-600">
        把审批红线改成任意值，同一笔金额立刻重判——这就是「财务想把 5 万调 3 万不用等三天发版」。
        沙盒只在内存覆盖配置副本，<span className="font-semibold text-zinc-900">不改任何文件、不落库</span>。
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block font-semibold text-zinc-600">审批红线（元）</span>
          <input
            type="number"
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="w-40 rounded-lg border border-zinc-300 px-3 py-1.5 font-mono text-sm focus:border-zinc-900 focus:outline-none"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-semibold text-zinc-600">待判金额（元）</span>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
            className="w-40 rounded-lg border border-zinc-300 px-3 py-1.5 font-mono text-sm focus:border-zinc-900 focus:outline-none"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-semibold text-zinc-600">部门</span>
          <select
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
          >
            <option value="财务部">财务部</option>
            <option value="运营部">运营部</option>
            <option value="客服部">客服部</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 disabled:opacity-50"
        >
          {busy ? "判定中…" : "立刻试判"}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {[30000, 50000, 100000].map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => quick(t)}
            className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
              threshold === t
                ? "border-zinc-900 bg-zinc-900 text-white"
                : "border-zinc-300 text-zinc-600 hover:bg-zinc-100"
            }`}
          >
            改用 {t.toLocaleString("en-US")} 红线
          </button>
        ))}
      </div>

      {error !== "" && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {result !== null && (
        <div
          className={`mt-4 rounded-lg border p-4 ${
            result.decision.blocked
              ? "border-red-300 bg-red-50"
              : result.decision.humanApprovalRequired
                ? "border-amber-300 bg-amber-50"
                : "border-emerald-300 bg-emerald-50"
          }`}
        >
          <p className="text-sm font-bold">
            {result.decision.blocked
              ? "🔴 拦截"
              : result.decision.humanApprovalRequired
                ? "🟠 FIN-001 强制人工审批"
                : "🟢 常规放行"}{" "}
            <span className="font-mono text-xs text-zinc-500">（{result.decision.ruleId}）</span>
          </p>
          <p className="mt-1 text-sm text-zinc-700">{result.decision.reason}</p>
          <p className="mt-1 font-mono text-xs text-zinc-500">
            {result.department} · ¥{result.amountCny.toLocaleString("en-US")} / 红线 ¥
            {result.thresholdCny.toLocaleString("en-US")}
          </p>
        </div>
      )}
    </section>
  );
}

export default function AuditExperience({
  audit,
  metrics,
}: {
  audit: AuditReport;
  metrics: MigrationMetrics;
}) {
  const ci = metrics.ciGate25;
  const tokenMigration = metrics.migrations.find((m) => m.id === "MIGRATION_B");
  const delta = tokenMigration?.delta ?? {};
  const before = tokenMigration?.before ?? {};
  const after = tokenMigration?.after ?? {};

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          {
            label: "架构体检总分",
            value: `${String(audit.overallScore)}/100`,
            sub: `术前 ${String(audit.baseline?.overallScore ?? "—")} → 评级 ${audit.grade}`,
            tone: "text-emerald-700",
          },
          {
            label: "对话工具数",
            value: `${String(after.toolCount ?? 0)} 把`,
            sub: `术前 ${String(before.toolCount ?? 0)} 把 · 降 ${String(delta.toolCountReductionPct ?? 0)}%`,
            tone: "text-emerald-700",
          },
          {
            label: "每轮输入 Token",
            value: `${String(after.inputTokensPerTurn ?? 0)}`,
            sub: `术前 ${String(before.inputTokensPerTurn ?? 0)} · 省 ${String(delta.tokenReductionPct ?? 0)}%`,
            tone: "text-emerald-700",
          },
          {
            label: "25 题 CI 门禁",
            value: `${String(ci.passed)}/${String(ci.total)}`,
            sub: ci.zeroRegression ? "全绿零退步 · Merge 解锁" : "红灯锁死合入",
            tone: ci.zeroRegression ? "text-emerald-700" : "text-red-600",
          },
        ].map((k) => (
          <div key={k.label} className="rounded-xl border border-zinc-200 bg-white p-4">
            <p className="text-xs font-semibold text-zinc-500">{k.label}</p>
            <p className={`mt-1 text-2xl font-bold ${k.tone}`}>{k.value}</p>
            <p className="mt-1 text-xs text-zinc-500">{k.sub}</p>
          </div>
        ))}
      </div>

      <section>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-bold">五维放灯：一眼看清哪里健康、哪里有病灶</h2>
          <p className="text-xs text-zinc-500">{audit.lightLegend}</p>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          {audit.dimensions.map((d) => {
            const light = LIGHT[d.status];
            return (
              <article key={d.id} className={`rounded-xl border p-4 ${light.ring}`}>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-bold text-zinc-900">
                    {light.icon} {d.name}
                  </h3>
                  <span className={`shrink-0 font-mono text-sm font-bold ${light.text}`}>{d.score} 分</span>
                </div>
                <p className="mt-2 text-sm text-zinc-700">{d.finding}</p>
                <p className="mt-2 text-xs text-zinc-600">
                  <span className="font-semibold">处方：</span>
                  {d.recommendation}
                </p>
                {d.hits.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs font-semibold text-zinc-500">
                      扫描明细（{d.hits.length} 条）
                    </summary>
                    <ul className="mt-1 space-y-0.5">
                      {d.hits.slice(0, 8).map((h, i) => (
                        <li key={`${h.file}-${String(i)}`} className="truncate font-mono text-[11px] text-zinc-500">
                          {h.file} · {h.rule} · {h.count}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </article>
            );
          })}
        </div>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-5">
        <h2 className="text-lg font-bold">两处手术前后对比</h2>
        <p className="mt-1 text-sm text-zinc-600">
          手术① 业务规则外置：改规则触碰源码文件 <span className="font-semibold">4 → 0 个</span>，生效从 3 天发版变成改配置 5 秒。
          手术② 工具聚合与提示词瘦身：见下方量化条。
        </p>
        <div className="mt-4 grid gap-5 sm:grid-cols-3">
          <CompareBar
            label="对话工具数"
            before={Number(before.toolCount ?? 0)}
            after={Number(after.toolCount ?? 0)}
            unit="把"
          />
          <CompareBar
            label="每轮输入 Token"
            before={Number(before.inputTokensPerTurn ?? 0)}
            after={Number(after.inputTokensPerTurn ?? 0)}
            unit="tokens"
          />
          <CompareBar
            label="单次派发耗时"
            before={Number(before.avgLatencyMs ?? 0)}
            after={Number(after.avgLatencyMs ?? 0)}
            unit="ms"
          />
        </div>
        {tokenMigration?.latencyNote !== undefined && (
          <p className="mt-3 text-xs text-zinc-500">{tokenMigration.latencyNote}</p>
        )}
      </section>

      <PolicySandbox />

      <section className="rounded-xl border border-zinc-200 bg-white p-5">
        <h2 className="text-lg font-bold">CI 验收战报（Day 25 · 25 题）</h2>
        <ul className="mt-2 space-y-1 text-sm text-zinc-700">
          <li>
            通过：{ci.passed}/{ci.total}（{ci.passRatePct}%）· 零退步：{ci.zeroRegression ? "是" : "否"}
          </li>
          <li>
            AutoSxS 盲测胜率：{ci.autosxsWinRatePct ?? "—"}% · 门禁耗时：
            {ci.gateDurationMs != null ? `${String(Math.round(ci.gateDurationMs / 1000))} 秒` : "—"}
          </li>
          <li>失败题：{ci.failures.length === 0 ? "无（25/25 全绿）" : ci.failures.join("、")}</li>
        </ul>
        <p className="mt-2 text-xs text-zinc-500">
          复查命令：<code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono">pnpm eval:ci</code>
          ；体检重跑：<code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono">node scripts/day26-lab/01-five-dim-arch-audit.mjs</code>
        </p>
      </section>
    </div>
  );
}
