"use client";

/**
 * /workflows —— Day 18 跨重启持久化审批流 + MCP Tasks 演示台
 * 三大看点：
 *   1. 星辰大额审批流三步状态灯：入库校验 → 挂起等林总（最长 7 天，不占内存）→ 凭据 + 通知下游；
 *   2. 【模拟服务器崩溃重启】演习：挂起后杀掉 dev 服务器再重启，点「林总批准」流程照样走完；
 *   3. MCP Tasks 异步长任务：创建即回 taskId，轮询实时进度，重启照常续算。
 * 红线：FIN-001 大额必须具名人工批准；全站零「自动打款」按钮（批准只生成审计凭据）。
 */

import { useCallback, useEffect, useState } from "react";
import type {
  WorkflowArithmeticDetail,
} from "@/db/schema";

/* ---------- 与服务端同构的类型（type-only 导入，不打包服务端代码） ---------- */

type Phase =
  | "queued"
  | "invalid"
  | "awaiting_approval"
  | "completed"
  | "rejected"
  | "expired";

interface RunView {
  runId: string;
  ticketNo: string;
  department: string;
  customerNameMasked: string;
  amountClaimed: number;
  isFin001: boolean;
  engine: "postgres" | "inngest";
  phase: Phase;
  arithmeticOk: boolean;
  arithmeticDetail: WorkflowArithmeticDetail;
  auditCredential: string;
  approver: string;
  suspendedAt: string | null;
  waitExpiresAt: string | null;
  createdAt: string;
  lights: Array<{
    key: string;
    label: string;
    status: "ok" | "waiting" | "failed" | "pending";
    hint: string;
  }>;
  crossedRestart: boolean;
  events: Array<{ id: number; eventType: string; detail: string; createdAt: string }>;
}

interface TaskProgress {
  taskId: string;
  label: string;
  status: "running" | "completed";
  progress: number;
  currentStep: string;
  elapsedMs: number;
  totalMs: number;
  result: Record<string, unknown> | null;
}

/* ---------- 预设案例（数据均为虚构演示，PII 已脱敏口径） ---------- */

interface Preset {
  key: string;
  title: string;
  desc: string;
  payload: {
    ticketNo: string;
    department: string;
    customerName: string;
    amountClaimed: number;
    items: Array<{ desc: string; qty: number; unitPrice: number }>;
  };
}

const PRESETS: Preset[] = [
  {
    key: "fin001",
    title: "大额 · FIN-001",
    desc: "¥52,800 超 5 万红线：挂起等待林总，批准后走完全程（推荐演习案例）",
    payload: {
      ticketNo: "T-2026-1101",
      department: "财务部",
      customerName: "张晓雅",
      amountClaimed: 52800,
      items: [
        { desc: "跨境头程物流费", qty: 12, unitPrice: 3400 },
        { desc: "清关代理服务费", qty: 1, unitPrice: 12000 },
      ],
    },
  },
  {
    key: "small",
    title: "小额常规",
    desc: "¥3,800 未超 5 万：同样挂起等具名审批（审批流对所有单据不放行自动化）",
    payload: {
      ticketNo: "T-2026-1105",
      department: "财务部",
      customerName: "李成",
      amountClaimed: 3800,
      items: [{ desc: "欧洲站仓储费", qty: 2, unitPrice: 1900 }],
    },
  },
  {
    key: "mismatch",
    title: "算术错单",
    desc: "明细合计 ¥51,300 ≠ 申报 ¥52,800：步骤 1 直接红灯拦截，不进入挂起",
    payload: {
      ticketNo: "T-2026-1109",
      department: "财务部",
      customerName: "王家旺",
      amountClaimed: 52800,
      items: [
        { desc: "跨境头程物流费", qty: 12, unitPrice: 3400 },
        { desc: "清关代理服务费", qty: 1, unitPrice: 10500 },
      ],
    },
  },
];

/* ---------- 小组件 ---------- */

const LIGHT_STYLE: Record<"ok" | "waiting" | "failed" | "pending", { dot: string; text: string }> = {
  ok: { dot: "bg-emerald-500", text: "text-emerald-700" },
  waiting: { dot: "bg-amber-400 animate-pulse", text: "text-amber-700" },
  failed: { dot: "bg-red-500", text: "text-red-700" },
  pending: { dot: "bg-zinc-300", text: "text-zinc-400" },
};

const PHASE_LABEL: Record<Phase, string> = {
  queued: "已受理 · 等引擎领取",
  invalid: "步骤 1 拦截",
  awaiting_approval: "挂起等待审批",
  completed: "已完成",
  rejected: "已退回",
  expired: "已过期",
};

const PHASE_STYLE: Record<Phase, string> = {
  queued: "bg-zinc-100 text-zinc-600",
  invalid: "bg-red-100 text-red-700",
  awaiting_approval: "bg-amber-100 text-amber-700",
  completed: "bg-emerald-100 text-emerald-700",
  rejected: "bg-red-100 text-red-700",
  expired: "bg-zinc-200 text-zinc-600",
};

const EVENT_PREFIX: Record<string, string> = {
  run_created: "受理",
  step1_intake: "校验",
  step1_invalid: "拦截",
  suspended: "挂起",
  approval_received: "批准",
  audit_written: "凭据",
  downstream_notified: "通知",
  rejected: "退回",
  expired: "过期",
};

function StepLight({
  status,
  label,
  hint,
}: {
  status: "ok" | "waiting" | "failed" | "pending";
  label: string;
  hint: string;
}) {
  const s = LIGHT_STYLE[status];
  return (
    <div className="flex items-start gap-2.5">
      <span className={`mt-1 h-3 w-3 shrink-0 rounded-full ${s.dot}`} />
      <div className="min-w-0">
        <p className={`text-xs font-semibold ${s.text}`}>{label}</p>
        <p className="text-[11px] leading-relaxed text-zinc-500">{hint}</p>
      </div>
    </div>
  );
}

function RunCard({
  run,
  approver,
  onDecide,
  busy,
}: {
  run: RunView;
  approver: string;
  onDecide: (runId: string, action: "approve" | "reject") => void;
  busy: boolean;
}) {
  const [showDetail, setShowDetail] = useState(false);
  const decidable = run.phase === "awaiting_approval";
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-bold text-zinc-800">{run.runId}</span>
        <span className="text-xs text-zinc-500">工单 {run.ticketNo}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${PHASE_STYLE[run.phase]}`}
        >
          {PHASE_LABEL[run.phase]}
        </span>
        {run.isFin001 && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-700 ring-1 ring-amber-300">
            FIN-001 强制人工审批
          </span>
        )}
        <span className="rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-[11px] text-zinc-500">
          {run.engine === "inngest" ? "engine: inngest" : "engine: postgres 等价演练"}
        </span>
        <span className="ml-auto text-sm font-bold text-zinc-800">
          ¥{run.amountClaimed.toLocaleString("zh-CN")}
        </span>
      </div>

      <p className="mt-1 text-xs text-zinc-500">
        客户 {run.customerNameMasked} · {run.department} · 受理于{" "}
        {new Date(run.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}
      </p>

      {/* 跨重启证明徽章 */}
      {run.crossedRestart && run.phase !== "invalid" && (
        <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[11px] font-semibold text-emerald-700">
          ✓ 已跨越一次服务器重启：挂起时刻早于当前进程启动时刻，状态从 Postgres 完整恢复
        </div>
      )}

      {/* 三步状态灯 */}
      <div className="mt-3 grid gap-2.5 sm:grid-cols-3">
        {run.lights.map((light) => (
          <StepLight key={light.key} status={light.status} label={light.label} hint={light.hint} />
        ))}
      </div>

      {/* 审计凭据 */}
      {run.phase === "completed" && (
        <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
          <p className="text-xs font-bold text-emerald-700">
            审计凭据 {run.auditCredential}
          </p>
          <p className="mt-0.5 text-[11px] text-emerald-600">
            已写入 approval_audit_logs（只增不改）· 审批人 {run.approver} · 全程未触发任何打款动作
          </p>
        </div>
      )}

      {/* 操作区 */}
      {decidable && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={() => onDecide(run.runId, "approve")}
            disabled={busy}
            className="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-bold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
          >
            林总批准
          </button>
          <button
            onClick={() => onDecide(run.runId, "reject")}
            disabled={busy}
            className="rounded-lg border border-zinc-300 px-4 py-1.5 text-xs font-semibold text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-50"
          >
            退回
          </button>
          <span className="text-[11px] text-zinc-400">
            以「{approver}」具名放行 · 重复批准返回 409 · AI / 匿名身份一律 403
          </span>
        </div>
      )}
      {run.engine === "inngest" && run.phase === "queued" && (
        <p className="mt-2 text-[11px] text-zinc-400">
          等待 Inngest Dev Server 领取执行（打开 http://127.0.0.1:8288 可见函数时间线）
        </p>
      )}

      {/* 明细与事件流水（可展开） */}
      <button
        onClick={() => setShowDetail((v) => !v)}
        className="mt-2.5 text-[11px] font-semibold text-zinc-500 underline-offset-2 hover:underline"
      >
        {showDetail ? "收起明细与事件流水 ▲" : "展开明细与事件流水 ▼"}
      </button>
      {showDetail && (
        <div className="mt-2 space-y-3 rounded-lg bg-zinc-50 p-3">
          <div>
            <p className="text-[11px] font-bold text-zinc-600">算术校验（确定性计算，零 AI 参与）</p>
            <table className="mt-1 w-full border-collapse text-[11px]">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-zinc-500">
                  <th className="py-1 pr-2 font-semibold">品名</th>
                  <th className="py-1 pr-2 font-semibold">数量</th>
                  <th className="py-1 pr-2 font-semibold">单价</th>
                  <th className="py-1 font-semibold">小计</th>
                </tr>
              </thead>
              <tbody>
                {run.arithmeticDetail.lines.map((line, i) => (
                  <tr key={i} className="text-zinc-700">
                    <td className="py-0.5 pr-2">{line.desc}</td>
                    <td className="py-0.5 pr-2">{line.qty}</td>
                    <td className="py-0.5 pr-2">¥{line.unitPrice.toLocaleString("zh-CN")}</td>
                    <td className="py-0.5">¥{line.subtotal.toLocaleString("zh-CN")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p
              className={`mt-1 font-semibold ${
                run.arithmeticOk ? "text-emerald-600" : "text-red-600"
              }`}
            >
              明细合计 ¥{run.arithmeticDetail.computedTotal.toLocaleString("zh-CN")} vs 申报 ¥
              {run.arithmeticDetail.claimedTotal.toLocaleString("zh-CN")}（
              {run.arithmeticOk ? "一致 ✓" : "不一致 ⛔ 拦截"}）
            </p>
          </div>
          <div>
            <p className="text-[11px] font-bold text-zinc-600">
              事件流水（workflow_events · 只增不改，触发器物理拒绝篡改）
            </p>
            <ol className="mt-1 space-y-1">
              {run.events.map((e) => (
                <li key={e.id} className="flex items-baseline gap-2 text-[11px]">
                  <span className="shrink-0 font-mono text-zinc-400">
                    {new Date(e.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}
                  </span>
                  <span className="w-8 shrink-0 rounded bg-zinc-200 px-1 text-center font-semibold text-zinc-600">
                    {EVENT_PREFIX[e.eventType] ?? e.eventType}
                  </span>
                  <span className="text-zinc-600">{e.detail}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- 主页面 ---------- */

export default function WorkflowsPage() {
  const [presetKey, setPresetKey] = useState<string>("fin001");
  const [engine, setEngine] = useState<"postgres" | "inngest">("postgres");
  const [approver, setApprover] = useState("林总");
  const [runs, setRuns] = useState<RunView[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [tasks, setTasks] = useState<TaskProgress[]>([]);
  const [taskNotice, setTaskNotice] = useState<string | null>(null);
  const [showInngestGuide, setShowInngestGuide] = useState(false);

  const refreshRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/workflows", { cache: "no-store" });
      const data: unknown = await res.json();
      const runs = (data as { runs?: RunView[] }).runs;
      if (Array.isArray(runs)) setRuns(runs);
    } catch {
      /* 网络抖动时下一轮轮询自愈，不打断页面 */
    }
  }, []);

  const refreshTasks = useCallback(async () => {
    try {
      const res = await fetch("/api/mcp/tasks", { cache: "no-store" });
      const data: unknown = await res.json();
      const list = (data as { tasks?: TaskProgress[] }).tasks;
      if (Array.isArray(list)) setTasks(list);
    } catch {
      /* 同上 */
    }
  }, []);

  useEffect(() => {
    void refreshRuns();
    void refreshTasks();
    const runTimer = setInterval(() => void refreshRuns(), 2000);
    const taskTimer = setInterval(() => void refreshTasks(), 1000);
    return () => {
      clearInterval(runTimer);
      clearInterval(taskTimer);
    };
  }, [refreshRuns, refreshTasks]);

  const createRun = useCallback(async () => {
    const preset = PRESETS.find((p) => p.key === presetKey);
    if (!preset) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...preset.payload, engine }),
      });
      const data: unknown = await res.json();
      const body = data as { error?: string; notice?: string | null };
      if (!res.ok) {
        setError(body.error ?? "创建失败，请稍后再试。");
      } else {
        if (body.notice) setNotice(body.notice);
      }
      await refreshRuns();
    } catch {
      setError("网络异常，请稍后再试。");
    } finally {
      setBusy(false);
    }
  }, [presetKey, engine, refreshRuns]);

  const decide = useCallback(
    async (runId: string, action: "approve" | "reject") => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const res = await fetch(`/api/workflows/${runId}/decide`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, approver: approver.trim() }),
        });
        const data: unknown = await res.json();
        const body = data as { error?: string; notice?: string | null };
        if (!res.ok) {
          setError(body.error ?? "操作失败，请稍后再试。");
        } else if (body.notice) {
          setNotice(body.notice);
        }
        await refreshRuns();
      } catch {
        setError("网络异常，请稍后再试。");
      } finally {
        setBusy(false);
      }
    },
    [approver, refreshRuns],
  );

  const createTask = useCallback(async () => {
    setTaskNotice(null);
    try {
      const res = await fetch("/api/mcp/tasks", { method: "POST" });
      const data: unknown = await res.json();
      const body = data as { task?: TaskProgress; poll?: { statusUrl: string; intervalMs: number } };
      if (res.status === 202 && body.task) {
        setTaskNotice(
          `已受理长任务 ${body.task.taskId}（HTTP 202）→ 轮询 ${body.poll?.statusUrl} 每 ${body.poll?.intervalMs}ms 一次`,
        );
      }
      await refreshTasks();
    } catch {
      setTaskNotice("创建失败，请稍后再试。");
    }
  }, [refreshTasks]);

  const preset = PRESETS.find((p) => p.key === presetKey) ?? PRESETS[0];
  const awaitingCount = runs.filter((r) => r.phase === "awaiting_approval").length;

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
      {/* 页头 */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold tracking-tight">跨重启持久化审批流</h1>
        <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-bold text-amber-700 ring-1 ring-amber-300">
          FIN-001 · 超过 ¥50,000 强制具名人工审批
        </span>
        {awaitingCount > 0 && (
          <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-[11px] font-semibold text-zinc-600">
            当前挂起 {awaitingCount} 条（不占内存，最长 7 天）
          </span>
        )}
      </div>
      <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-zinc-600">
        挂起状态只存 Postgres，不放进程内存：服务器断电重启后，点「林总批准」流程照样完美走完。
        全流程只生成审计凭据并通知下游，<strong>不存在任何自动打款按钮</strong>（红区物理剔除）。
      </p>

      {/* 演习指南 */}
      <section className="mt-5 rounded-xl border border-blue-200 bg-blue-50 p-4">
        <h2 className="text-sm font-bold text-blue-900">
          【模拟服务器崩溃重启】演习指南 · 亲手验证「断电不丢」
        </h2>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-blue-800">
          <li>
            点下方预设「大额 · FIN-001」的 <strong>创建审批流</strong> → 出现琥珀色「挂起等待审批」状态灯；
          </li>
          <li>
            回到运行 dev 服务器的终端，<strong>直接 Ctrl+C 杀掉进程</strong>（这就是模拟断电），
            再 <code className="rounded bg-blue-100 px-1">pnpm dev</code> 重启；
          </li>
          <li>
            刷新本页：挂起的审批流还在，卡片上出现翠绿徽章
            <strong>「已跨越一次服务器重启」</strong>（用「进程启动时刻 vs 挂起时刻」确定性判定，不是表演）；
          </li>
          <li>
            点 <strong>林总批准</strong> → 琥珀灯转翠绿，审计凭据写入
            <code className="rounded bg-blue-100 px-1">approval_audit_logs</code>（只增不改），流程完美走完。
          </li>
        </ol>
      </section>

      {/* 创建审批流 */}
      <section className="mt-5 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-zinc-800">① 创建审批流（步骤 1 即时入库校验）</h2>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-zinc-500">审批人</span>
            <input
              value={approver}
              onChange={(e) => setApprover(e.target.value)}
              className="w-24 rounded-lg border border-zinc-300 px-2 py-1 text-xs"
              aria-label="审批人姓名"
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPresetKey(p.key)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                presetKey === p.key
                  ? "bg-zinc-900 text-white"
                  : "border border-zinc-300 text-zinc-600 hover:bg-zinc-50"
              }`}
            >
              {p.title}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-zinc-500">{preset.desc}</p>
        <table className="mt-2 w-full max-w-lg border-collapse text-[11px]">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-zinc-500">
              <th className="py-1 pr-3 font-semibold">品名</th>
              <th className="py-1 pr-3 font-semibold">数量</th>
              <th className="py-1 pr-3 font-semibold">单价</th>
              <th className="py-1 font-semibold">小计</th>
            </tr>
          </thead>
          <tbody>
            {preset.payload.items.map((line, i) => (
              <tr key={i} className="text-zinc-700">
                <td className="py-0.5 pr-3">{line.desc}</td>
                <td className="py-0.5 pr-3">{line.qty}</td>
                <td className="py-0.5 pr-3">¥{line.unitPrice.toLocaleString("zh-CN")}</td>
                <td className="py-0.5">
                  ¥{(line.qty * line.unitPrice).toLocaleString("zh-CN")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            onClick={() => void createRun()}
            disabled={busy}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-zinc-700 disabled:opacity-50"
          >
            创建审批流（{preset.title}）
          </button>
          <label className="flex items-center gap-1.5 text-xs text-zinc-600">
            <input
              type="checkbox"
              checked={engine === "inngest"}
              onChange={(e) => setEngine(e.target.checked ? "inngest" : "postgres")}
              className="h-3.5 w-3.5"
            />
            尝试走真实 Inngest Dev Server（未启动则自动降级为等价演练模式）
          </label>
        </div>
        {notice && (
          <p className="mt-2 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700">{notice}</p>
        )}
        {error && (
          <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
            {error}
          </p>
        )}
      </section>

      {/* Inngest 启动说明 */}
      <section className="mt-4">
        <button
          onClick={() => setShowInngestGuide((v) => !v)}
          className="text-xs font-semibold text-zinc-500 underline-offset-2 hover:underline"
        >
          {showInngestGuide ? "收起 Inngest 一键启动说明 ▲" : "查看 Inngest 一键启动说明（可选升级）▼"}
        </button>
        {showInngestGuide && (
          <div className="mt-2 space-y-2 rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-xs leading-relaxed text-zinc-600">
            <p>
              默认的「等价演练模式」用 Postgres 状态机实现与 Inngest 同构的挂起 / 恢复语义；
              想看真实的 Inngest 持久化时间线，另开一个终端：
            </p>
            <pre className="overflow-x-auto rounded-lg bg-zinc-900 p-3 font-mono text-[11px] text-zinc-100">
{`# 1. 启动 Inngest Dev Server（自动发现 http://localhost:3000/api/inngest 端点）
npx inngest-cli@latest dev

# 2. 回到 /workflows 页面，勾选「尝试走真实 Inngest Dev Server」再创建审批流

# 3. 打开 Dev Server UI 观察函数时间线（步骤 1 → 挂起 waitForEvent → 步骤 3）
#    http://127.0.0.1:8288`}
            </pre>
            <p>
              挂起对应函数里的 <code className="rounded bg-zinc-200 px-1">step.waitForEvent(&quot;step2-wait-for-lin&quot;, {"{"} timeout: &quot;7d&quot;, match: &quot;data.runId&quot; {"}"})</code>
              ——等待状态在 Inngest 持久层，同样断电不丢、不占内存。
            </p>
          </div>
        )}
      </section>

      {/* 运行列表 */}
      <section className="mt-5">
        <h2 className="text-sm font-bold text-zinc-800">② 审批流运行台（三步状态灯 · 每 2 秒自动刷新）</h2>
        {runs.length === 0 ? (
          <p className="mt-2 rounded-xl border border-dashed border-zinc-300 p-6 text-center text-xs text-zinc-400">
            还没有运行记录，先在上方创建一条审批流。
          </p>
        ) : (
          <div className="mt-2 space-y-3">
            {runs.map((run) => (
              <RunCard key={run.runId} run={run} approver={approver} onDecide={decide} busy={busy} />
            ))}
          </div>
        )}
      </section>

      {/* MCP Tasks 演示区 */}
      <section className="mt-8 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-zinc-800">
            ③ MCP Tasks 异步长任务演示（创建即回 taskId · 实时进度轮询 · 重启照常续算）
          </h2>
          <button
            onClick={() => void createTask()}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-semibold text-zinc-700 transition-colors hover:bg-zinc-50"
          >
            创建长任务（批量核对 128 张超期发票）
          </button>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
          进度 = (当前时刻 − 开工时刻) ÷ 总时长，是时间的确定性函数：没有后台定时器、没有进程内状态，
          服务器重启后按同一公式照常续算（可配合上面的断电演习一起验证）。
        </p>
        {taskNotice && (
          <p className="mt-2 rounded-lg bg-blue-50 px-3 py-2 font-mono text-[11px] text-blue-700">
            {taskNotice}
          </p>
        )}
        {tasks.length === 0 ? (
          <p className="mt-2 rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs text-zinc-400">
            还没有长任务，点右上角创建一个（约 20 秒跑完，轮询每秒刷新）。
          </p>
        ) : (
          <div className="mt-3 space-y-2.5">
            {tasks.map((t) => (
              <div key={t.taskId} className="rounded-lg border border-zinc-200 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-mono font-bold text-zinc-800">{t.taskId}</span>
                  <span className="text-zinc-500">{t.label}</span>
                  <span
                    className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      t.status === "completed"
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-amber-100 text-amber-700"
                    }`}
                  >
                    {t.status === "completed" ? "completed" : "running"} · {t.progress}%
                  </span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-100">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      t.status === "completed" ? "bg-emerald-500" : "bg-amber-400"
                    }`}
                    style={{ width: `${Math.max(t.progress, 2)}%` }}
                  />
                </div>
                <p className="mt-1.5 text-[11px] text-zinc-500">
                  当前阶段：{t.currentStep} · {Math.round(t.elapsedMs / 100) / 10}s /{" "}
                  {Math.round(t.totalMs / 1000)}s
                </p>
                {t.result !== null && (
                  <div className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-[11px] leading-relaxed text-emerald-700">
                    <p className="font-bold">核对报告（确定性结果，进度 100% 才揭晓）</p>
                    <p>
                      已核对 {String(t.result.audited)} 张 · 算术通过 {String(t.result.arithmeticOk)} 张 ·
                      不匹配 {String(t.result.mismatched)} 张（已留痕待人工复核）· FIN-001 标记{" "}
                      {String(t.result.fin001Flagged)} 张
                    </p>
                    <p className="mt-0.5 text-emerald-600">{String(t.result.reportNote)}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="mt-6 text-center text-[11px] text-zinc-400">
        星辰 WorkBot v4.0 · Day 18 · 测试数据均为虚构演示内容 · AI 只读、起草、标记，放行永远归人
      </p>
    </main>
  );
}
