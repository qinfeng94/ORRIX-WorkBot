"use client";

/**
 * /security-range —— Day 30 · 红队攻防靶场面板（纵深安全防御）
 * 四块内容：
 *  1) 物理急停总电闸状态卡（环境变量真源 + 内存演习开关，合闸后 ≤1 秒锁死所有 AI 写操作）；
 *  2) 四级 RBAC 权限矩阵（访客只读 / 一线专员 / 部门审批官 / 安全管理员；write_any 对任何角色都不存在）；
 *  3) 三层纵深自检（RBAC / 电闸 / 外来内容隔离层，自检不过即拒绝服务）；
 *  4) 【一键发起 20 项黑客攻击演习】：20 项经典 Prompt 注入与越权套话攻击 × 8 类探针判卷，
 *     全部拦截 = 20 盏绿灯；台账落盘 data/evals/red-team-report.json。
 * 红线提示：本页只做只读评测与内存演习开关，全程无打款按钮、不写业务系统正式数据。
 */

import { useCallback, useEffect, useState } from "react";
import type { RedTeamReport } from "@/lib/security/red-team";

interface KillSwitchStatusView {
  envVar: string;
  envOn: boolean;
  drillOverride: boolean | null;
  effectiveOn: boolean;
}

interface RbacRoleRow {
  role: string;
  label: string;
  actions: { action: string; allowed: boolean }[];
}

interface SecuritySnapshot {
  killSwitch: KillSwitchStatusView;
  rbac: { roles: RbacRoleRow[]; actionOrder: string[] };
  selfCheck: Record<string, boolean>;
  selfCheckErrors: Record<string, string>;
  suite: {
    version: string;
    basis: string;
    passRule: string;
    total: number;
    categories: { key: string; label: string; count: number }[];
  };
  lastReport: RedTeamReport | null;
}

const ACTION_LABELS: Record<string, string> = {
  read_green: "绿区只读",
  draft_yellow: "黄区起草",
  approve_fin001: "审批放行",
  manage_security: "安全管理",
  write_any: "直写数据",
};

const PROBE_LABELS: Record<string, string> = {
  strip: "指令剥离",
  wrap: "隔离包裹",
  redzone: "红区扫描",
  core: "核心合规",
  output: "输出红线",
  rbac: "RBAC",
  killswitch: "电闸",
  dryrun: "Dry-Run 锁死",
};

const SELF_CHECK_LABELS: Record<string, string> = {
  rbac: "RBAC 权限矩阵",
  killSwitch: "物理急停电闸",
  untrusted: "外来内容隔离层",
};

function KillSwitchCard({
  ks,
  onChanged,
  busy,
}: {
  ks: KillSwitchStatusView;
  onChanged: () => void;
  busy: boolean;
}) {
  const [drilling, setDrilling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = useCallback(
    async (on: boolean) => {
      setDrilling(true);
      setError(null);
      try {
        const res = await fetch("/api/security-range", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "kill_switch_drill", on }),
        });
        const json = (await res.json()) as { ok: boolean; error?: string };
        if (!json.ok) setError(json.error ?? "电闸演习失败");
        else onChanged();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setDrilling(false);
      }
    },
    [onChanged],
  );

  return (
    <div
      className={`rounded-xl border p-4 ${
        ks.effectiveOn ? "border-red-400 bg-red-50" : "border-emerald-300 bg-emerald-50"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={`text-lg font-bold ${ks.effectiveOn ? "text-red-700" : "text-emerald-700"}`}>
          {ks.effectiveOn ? "⚡ 急停总电闸：已合闸（所有 AI 写操作锁死）" : "🔌 急停总电闸：开闸（写通道正常）"}
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => toggle(true)}
            disabled={busy || drilling || ks.drillOverride === true}
            className="rounded-lg border-2 border-red-400 bg-white px-3 py-1.5 text-sm font-bold text-red-600 transition-colors hover:bg-red-100 disabled:opacity-50"
          >
            {drilling ? "执行中…" : "合闸演习（内存开关）"}
          </button>
          <button
            onClick={() => toggle(false)}
            disabled={busy || drilling || ks.drillOverride === null}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-semibold text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-50"
          >
            复位演习开关
          </button>
        </div>
      </div>
      <ul className="mt-2 space-y-0.5 text-sm text-zinc-600">
        <li>
          环境变量真源：<code className="rounded bg-zinc-100 px-1">{ks.envVar}</code> ={" "}
          <span className={ks.envOn ? "font-bold text-red-600" : "text-zinc-600"}>
            {ks.envOn ? "已置位（运维侧合闸）" : "未置位"}
          </span>
          ，每次写操作实时读取、零缓存，置位后 ≤1 秒锁死全部 AI 写操作（AI 与前端均不可触碰）。
        </li>
        <li>
          内存演习开关：{ks.drillOverride === null ? "未干预（跟随环境变量）" : ks.drillOverride ? "演习合闸中" : "强制开闸"}
          （仅本页演示用，重启即失效；生产解锁永远走服务端环境变量）。
        </li>
      </ul>
      {error && <p className="mt-2 text-sm font-semibold text-red-700">{error}</p>}
    </div>
  );
}

function RbacMatrix({ roles, actionOrder }: { roles: RbacRoleRow[]; actionOrder: string[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-zinc-600">
            <th className="px-4 py-2 font-semibold">角色（服务端会话指派）</th>
            {actionOrder.map((a) => (
              <th key={a} className="px-3 py-2 text-center font-semibold">
                {ACTION_LABELS[a] ?? a}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {roles.map((r) => (
            <tr key={r.role} className="border-b border-zinc-100 last:border-0">
              <td className="px-4 py-2 font-semibold text-zinc-800">{r.label}</td>
              {r.actions.map((c) => (
                <td key={c.action} className="px-3 py-2 text-center">
                  {c.allowed ? (
                    <span className="text-emerald-600">✅</span>
                  ) : (
                    <span className="text-zinc-300" title="RBAC 拒绝（物理剔除）">
                      🚫
                    </span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500">
        职责分离：安全管理员管演习、不批财务单据；「直写正式数据」一列对所有角色物理剔除（不是提示词劝阻）；
        对话文本里自称的身份一律不采信，角色只认服务端会话指派。
      </p>
    </div>
  );
}

function AttackRow({ r }: { r: RedTeamReport["results"][number] }) {
  return (
    <li className="px-4 py-2.5">
      <div className="flex flex-wrap items-start gap-2">
        <span className={r.passed ? "text-emerald-600" : "text-red-600"}>{r.passed ? "✅" : "❌"}</span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-zinc-800">
            {r.id} {r.title}
          </p>
          <p className="text-xs text-zinc-400">攻击向量：{r.vector}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {r.probes.map((p) => (
              <span
                key={p.probe}
                className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                  p.passed ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                }`}
                title={p.detail}
              >
                {p.passed ? "🟢" : "🔴"} {PROBE_LABELS[p.probe] ?? p.probe}
              </span>
            ))}
          </div>
          {r.probes.some((p) => !p.passed) && (
            <ul className="mt-1 list-inside list-disc text-xs text-red-600">
              {r.probes
                .filter((p) => !p.passed)
                .map((p) => (
                  <li key={p.probe}>{p.detail}</li>
                ))}
            </ul>
          )}
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-600">
              查看引擎实际处置（判词）
            </summary>
            <p className="mt-1 whitespace-pre-wrap rounded-lg bg-zinc-50 p-2 text-xs text-zinc-600">
              {r.verdict}
            </p>
          </details>
        </div>
      </div>
    </li>
  );
}

function DrillReport({ report }: { report: RedTeamReport }) {
  const pass = report.verdict === "PASS";
  return (
    <section className="space-y-4">
      <div
        className={`rounded-xl border p-4 ${pass ? "border-emerald-300 bg-emerald-50" : "border-red-300 bg-red-50"}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={`text-lg font-bold ${pass ? "text-emerald-700" : "text-red-700"}`}>
            {pass ? "🟢 PASS · 20/20 全部拦截亮绿灯" : "🔴 BLOCKED · 存在攻击得手"}
          </p>
          <p className="text-sm font-semibold text-zinc-600">
            {String(report.counts.blocked)}/{String(report.counts.total)} 拦截 · 耗时{" "}
            {String(report.durationMs)}ms · {report.generatedAt}
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
            四道防线（包裹 → 剥离 → 合规路径 → 输出扫描）+ RBAC + 电闸全数生效；台账已写入
            data/evals/red-team-report.json。
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {report.categories.map((c) => (
          <div key={c.key} className="rounded-xl border border-zinc-200 bg-white p-3">
            <p className="text-sm font-bold text-zinc-800">{c.label}</p>
            <p className={`mt-1 text-xs font-semibold ${c.blocked === c.total ? "text-emerald-600" : "text-red-600"}`}>
              {String(c.blocked)}/{String(c.total)} 拦截
            </p>
          </div>
        ))}
      </div>

      <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white">
        {report.results.map((r) => (
          <AttackRow key={r.id} r={r} />
        ))}
      </div>
    </section>
  );
}

export default function SecurityRangePage() {
  const [snapshot, setSnapshot] = useState<SecuritySnapshot | null>(null);
  const [report, setReport] = useState<RedTeamReport | null>(null);
  const [drilling, setDrilling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSnapshot = useCallback(async () => {
    try {
      const res = await fetch("/api/security-range", { cache: "no-store" });
      const json = (await res.json()) as { ok: boolean; snapshot?: SecuritySnapshot };
      if (json.ok && json.snapshot) {
        setSnapshot(json.snapshot);
        if (json.snapshot.lastReport) setReport(json.snapshot.lastReport);
      }
    } catch {
      /* 首屏快照失败不阻塞页面 */
    }
  }, []);

  // 首屏快照：fetch 在 await 之后才 setState（React 19 set-state-in-effect 规则）
  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  const runDrill = useCallback(async () => {
    setDrilling(true);
    setError(null);
    try {
      const res = await fetch("/api/security-range", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run_drill" }),
      });
      const json = (await res.json()) as { ok: boolean; report?: RedTeamReport; error?: string };
      if (json.ok && json.report) setReport(json.report);
      else setError(json.error ?? "红队演习执行失败");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDrilling(false);
    }
  }, []);

  const ks = snapshot?.killSwitch ?? {
    envVar: "WORKBOT_KILL_SWITCH",
    envOn: false,
    drillOverride: null,
    effectiveOn: false,
  };

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold tracking-tight">红队攻防靶场（Day 30 · 纵深安全防御）</h1>
      <p className="mt-1 text-sm text-zinc-500">
        20 项经典 Prompt 注入与越权套话攻击（5 大类 × 4）：每项攻击按声明顺序过全部探针
        （隔离包裹 → 指令剥离 → 红区扫描 → 核心合规路径 → 输出红线 → RBAC → 电闸 → Dry-Run
        锁死），任一探针红灯 = 攻击得手。
        {snapshot ? ` 考卷版本：${snapshot.suite.version}` : ""}
      </p>

      {/* ① 物理急停总电闸 */}
      {snapshot && (
        <section className="mt-6 space-y-3">
          <h2 className="text-lg font-bold">① 物理急停总电闸</h2>
          <KillSwitchCard ks={ks} onChanged={() => void loadSnapshot()} busy={drilling} />
        </section>
      )}

      {/* ② 三层纵深自检 */}
      {snapshot && (
        <section className="mt-6">
          <h2 className="text-lg font-bold">② 三层纵深自检（自检不过 = 拒绝服务）</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {Object.entries(snapshot.selfCheck).map(([name, ok]) => (
              <span
                key={name}
                className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${
                  ok ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                }`}
                title={snapshot.selfCheckErrors[name] ?? ""}
              >
                {ok ? "🟢" : "🔴"} {SELF_CHECK_LABELS[name] ?? name}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* ③ 四级 RBAC 权限矩阵 */}
      {snapshot && (
        <section className="mt-6">
          <h2 className="text-lg font-bold">③ 四级 RBAC 权限矩阵</h2>
          <div className="mt-3">
            <RbacMatrix roles={snapshot.rbac.roles} actionOrder={snapshot.rbac.actionOrder} />
          </div>
        </section>
      )}

      {/* ④ 一键红队演习 */}
      <section className="mt-8">
        <h2 className="text-lg font-bold">④ 红队攻防演习（{snapshot?.suite.total ?? 20} 项）</h2>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            onClick={runDrill}
            disabled={drilling}
            className="rounded-xl bg-zinc-900 px-5 py-3 text-base font-bold text-white transition-colors hover:bg-zinc-700 disabled:opacity-50"
          >
            {drilling ? "20 项攻击演习进行中（约 40 秒）…" : "🔥 一键发起 20 项黑客攻击演习"}
          </button>
          <p className="text-xs text-zinc-400">
            全程离线高仿真、只读评测；演习不产生任何真实打款 / 落库动作，台账只增不改。
          </p>
        </div>
        {drilling && (
          <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700">
            正在逐项发起攻击并判卷（包裹 / 剥离 / 红区 / 核心 / 输出 / RBAC / 电闸 / Dry-Run），请稍候…
          </div>
        )}
        {error && (
          <div className="mt-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-700">{error}</div>
        )}
        {report && (
          <div className="mt-6">
            <DrillReport report={report} />
          </div>
        )}
      </section>
    </main>
  );
}
