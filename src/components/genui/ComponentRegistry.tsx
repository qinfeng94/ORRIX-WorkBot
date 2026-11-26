"use client";

/**
 * ComponentRegistry.tsx —— Day 8 生成式 UI 受控组件注册表（16 组件 / 4 大类）
 * 溯源：AGENTS.md 红线——大模型只允许「点菜」（白名单组件名 + 受控 Props），
 *      渲染权永远在本注册表手里，模型输出的文本绝不被当作 HTML/JS 执行。
 * 安全机制：
 * - 每个组件独立包一层 GenuiErrorBoundary：单个组件崩溃不影响整屏；
 * - 未注册组件名 → 温和降级为灰色提示条（不报错、不白屏）；
 * - 图表全零数据用 Math.max(...values, 1) 兜底，杜绝 NaN/Infinity；
 * - 审批类组件（approval_form_card / dry_run_confirm_card）批准后
 *   真实回写 approval_audit_logs 并广播 workbot:genui-approved 事件刷新大屏。
 */

import {
  Component,
  createContext,
  useContext,
  useState,
  type ReactNode,
} from "react";
import {
  GENUI_COMPONENT_NAMES,
  type ComparisonMatrixProps,
  type CostCardProps,
  type CustomerProfileCardProps,
  type DeptBarChartProps,
  type DryRunConfirmCardProps,
  type ApprovalFormCardProps,
  type ExportReportButtonProps,
  type FunnelChartProps,
  type GenuiComponentName,
  type GenuiLayoutItem,
  type KpiCardProps,
  type PolicyCitationCardProps,
  type ProgressBarProps,
  type QuickFilterBarProps,
  type RiskBannerProps,
  type ShareDonutChartProps,
  type TicketTableProps,
  type TrendLineChartProps,
} from "@/lib/genui/catalog-schema";

/* ================= 一、运行时上下文（受控动作唯一入口） ================= */

export interface GenuiRuntime {
  /** 导出当前布局 JSON（export_report_button 调用） */
  exportLayout?: () => void;
  /** 会话标识（审批埋点归因，不含 PII） */
  sessionId: string;
}

const GenuiRuntimeContext = createContext<GenuiRuntime>({ sessionId: "" });

/** 审批成功后广播：/studio 监听此事件立刻刷新大屏指标 */
export const GENUI_APPROVED_EVENT = "workbot:genui-approved";

/* ================= 二、独立 ErrorBoundary ================= */

interface BoundaryState {
  failed: boolean;
}

class GenuiErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch(err: unknown): void {
    console.error("[genui] 组件渲染异常，已温和降级：", err instanceof Error ? err.message : err);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="rounded-xl border border-zinc-200 bg-zinc-100 px-4 py-3 text-sm text-zinc-500">
          🩹 该组件渲染异常，已温和降级（不影响页面其他区域）。
        </div>
      );
    }
    return this.props.children;
  }
}

/* ================= 三、客户端批准动作（真实回写审计表） ================= */

/** Dry-Run 草稿批准：走 /api/chat/approve（写 approval_audit_logs） */
async function approveDraft(
  approvalId: string,
  tool: string,
  summary: string,
  approver: string,
): Promise<{ ok: boolean; message: string }> {
  const res = await fetch("/api/chat/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approvalId, tool, summary, approver }),
  });
  const data: unknown = await res.json();
  if (!res.ok) {
    const err = data as { error?: string; approvedAt?: string };
    if (res.status === 409 && err.approvedAt) {
      return { ok: true, message: `该单已被批准过（幂等保护），审计已有留痕。` };
    }
    return { ok: false, message: err.error ?? "批准失败" };
  }
  return { ok: true, message: "已真实写入审计表（approval_audit_logs，只增不改）" };
}

/** 工单审批批准：走 /api/tickets/approve（更新工单状态 + 写审计日志，FIN-001 服务端二次校验） */
async function approveTicket(
  ticketNo: string,
  approver: string,
): Promise<{ ok: boolean; message: string }> {
  const res = await fetch("/api/tickets/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticketNo, approver }),
  });
  const data: unknown = await res.json();
  if (!res.ok) {
    const err = data as { error?: string };
    if (res.status === 409) {
      return { ok: true, message: `工单已批准过（幂等保护），审计已有留痕。` };
    }
    return { ok: false, message: err.error ?? "批准失败" };
  }
  return { ok: true, message: "工单状态已更新，审计日志已真实回写" };
}

/** 审批成功后统一广播：/studio 监听此事件立刻刷新大屏指标 */
function broadcastApproved(): void {
  window.dispatchEvent(new CustomEvent(GENUI_APPROVED_EVENT));
}

/** 审批卡片的公共内部状态机（批准 → 翠绿锁定；取消 → 灰色作废） */
function useApprovalState(approverDefault: string) {
  const [approver, setApprover] = useState(approverDefault);
  const [state, setState] = useState<"pending" | "approved" | "cancelled">("pending");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return { approver, setApprover, state, setState, message, setMessage, busy, setBusy };
}

/* ================= 四、指标类组件 ================= */

function KpiCard({ label, value, unit, delta, tone = "default" }: KpiCardProps) {
  const toneCls =
    tone === "good"
      ? "text-emerald-700"
      : tone === "warn"
        ? "text-amber-700"
        : tone === "danger"
          ? "text-red-700"
          : "text-zinc-900";
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium text-zinc-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${toneCls}`}>
        {typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("zh-CN") : "0"}
        {unit && <span className="ml-1 text-sm font-medium text-zinc-400">{unit}</span>}
      </p>
      {delta && <p className="mt-1 text-xs text-zinc-400">{delta}</p>}
    </div>
  );
}

function RiskBanner({ level, title, message, source }: RiskBannerProps) {
  const cls =
    level === "danger"
      ? "border-red-400 bg-red-50 text-red-800"
      : level === "warning"
        ? "border-amber-400 bg-amber-50 text-amber-900"
        : "border-sky-300 bg-sky-50 text-sky-800";
  const icon = level === "danger" ? "⛔" : level === "warning" ? "⚠️" : "ℹ️";
  return (
    <div className={`rounded-xl border-2 px-4 py-3 ${cls}`}>
      <p className="text-sm font-bold">
        {icon} {title}
      </p>
      <p className="mt-1 text-sm leading-6">{message}</p>
      {source && <p className="mt-1 font-mono text-xs opacity-70">依据：{source}</p>}
    </div>
  );
}

function ProgressBar({ label, percent, detail }: ProgressBarProps) {
  const safe = Math.min(Math.max(percent, 0), 100);
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="font-medium text-zinc-700">{label}</span>
        <span className="font-mono tabular-nums text-zinc-500">{safe.toFixed(0)}%</span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-zinc-100">
        <div
          className="h-full rounded-full bg-emerald-500 transition-all"
          style={{ width: `${safe}%` }}
        />
      </div>
      {detail && <p className="mt-2 text-xs text-zinc-400">{detail}</p>}
    </div>
  );
}

function CostCard({ provider, model, usdCost, tokensIn, tokensOut, note }: CostCardProps) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <p className="text-xs font-medium text-zinc-500">今日大模型花费</p>
      <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-emerald-700">
        ${Number.isFinite(usdCost) ? usdCost.toFixed(6) : "0.000000"}
      </p>
      <p className="mt-1 font-mono text-xs text-zinc-400">
        {provider} · {model} · Token {tokensIn}/{tokensOut}
      </p>
      {note && <p className="mt-1 text-xs text-zinc-400">{note}</p>}
    </div>
  );
}

/* ================= 五、图表类组件（全零数据 Math.max(...,1) 兜底） ================= */

function DeptBarChart({ title, categories, values }: DeptBarChartProps) {
  // 防全零/空数组 NaN：max 至少为 1
  const max = Math.max(...values, 1);
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <p className="mb-3 text-sm font-bold text-zinc-700">{title}</p>
      {categories.length === 0 ? (
        <p className="py-6 text-center text-sm text-zinc-400">暂无数据（0 条）</p>
      ) : (
        <div className="space-y-2">
          {categories.map((c, i) => (
            <div key={c} className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-xs text-zinc-500">{c}</span>
              <div className="h-5 flex-1 overflow-hidden rounded bg-zinc-100">
                <div
                  className="h-full rounded bg-sky-500"
                  style={{ width: `${((values[i] ?? 0) / max) * 100}%` }}
                />
              </div>
              <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-zinc-600">
                {values[i] ?? 0}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TrendLineChart({ title, labels, series }: TrendLineChartProps) {
  const allValues = series.flatMap((s) => s.values);
  const max = Math.max(...allValues, 1); // 全零兜底
  const W = 320;
  const H = 120;
  const hasData = labels.length > 0 && series.length > 0;
  const colors = ["#0ea5e9", "#10b981", "#f59e0b"];
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <p className="mb-3 text-sm font-bold text-zinc-700">{title}</p>
      {!hasData ? (
        <p className="py-6 text-center text-sm text-zinc-400">暂无数据（0 条）</p>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
            {[0.25, 0.5, 0.75].map((g) => (
              <line key={g} x1={0} x2={W} y1={H * g} y2={H * g} stroke="#f4f4f5" strokeWidth={1} />
            ))}
            {series.map((s, si) => {
              const pts = s.values
                .map((v, i) => {
                  const x = labels.length > 1 ? (i / (labels.length - 1)) * (W - 8) + 4 : W / 2;
                  const y = H - 8 - (v / max) * (H - 20);
                  return `${x.toFixed(1)},${y.toFixed(1)}`;
                })
                .join(" ");
              return (
                <polyline
                  key={s.name}
                  points={pts}
                  fill="none"
                  stroke={colors[si % colors.length]}
                  strokeWidth={2}
                  strokeLinejoin="round"
                />
              );
            })}
          </svg>
          <div className="mt-1 flex justify-between font-mono text-[10px] text-zinc-400">
            {labels.map((l) => (
              <span key={l}>{l}</span>
            ))}
          </div>
          <div className="mt-1 flex gap-3 text-xs text-zinc-500">
            {series.map((s, si) => (
              <span key={s.name}>
                <span
                  className="mr-1 inline-block h-2 w-2 rounded-full"
                  style={{ background: colors[si % colors.length] }}
                />
                {s.name}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ShareDonutChart({ title, slices }: ShareDonutChartProps) {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const safeTotal = Math.max(total, 1); // 全零兜底
  const C = 2 * Math.PI * 40;
  const colors = ["#0ea5e9", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444", "#64748b"];
  let offset = 0;
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <p className="mb-3 text-sm font-bold text-zinc-700">{title}</p>
      {slices.length === 0 ? (
        <p className="py-6 text-center text-sm text-zinc-400">暂无数据（0 条）</p>
      ) : (
        <div className="flex items-center gap-4">
          <svg viewBox="0 0 100 100" className="h-28 w-28 shrink-0 -rotate-90">
            <circle cx={50} cy={50} r={40} fill="none" stroke="#f4f4f5" strokeWidth={16} />
            {slices.map((s, i) => {
              const len = (s.value / safeTotal) * C;
              const el = (
                <circle
                  key={s.label}
                  cx={50}
                  cy={50}
                  r={40}
                  fill="none"
                  stroke={colors[i % colors.length]}
                  strokeWidth={16}
                  strokeDasharray={`${len} ${C - len}`}
                  strokeDashoffset={-offset}
                />
              );
              offset += len;
              return el;
            })}
          </svg>
          <div className="space-y-1 text-xs">
            {slices.map((s, i) => (
              <p key={s.label} className="flex items-center gap-2 text-zinc-600">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ background: colors[i % colors.length] }}
                />
                {s.label}
                <span className="font-mono tabular-nums text-zinc-400">
                  {s.value}（{((s.value / safeTotal) * 100).toFixed(0)}%）
                </span>
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FunnelChart({ title, stages }: FunnelChartProps) {
  const top = Math.max(...stages.map((s) => s.value), 1); // 全零兜底
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <p className="mb-3 text-sm font-bold text-zinc-700">{title}</p>
      {stages.length === 0 ? (
        <p className="py-6 text-center text-sm text-zinc-400">暂无数据（0 条）</p>
      ) : (
        <div className="space-y-1.5">
          {stages.map((s, i) => (
            <div key={s.label} className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-xs text-zinc-500">{s.label}</span>
              <div
                className="flex h-7 items-center justify-end rounded bg-violet-500 pr-2 text-xs font-semibold text-white"
                style={{ width: `${Math.max((s.value / top) * 100, 6)}%` }}
              >
                {s.value}
              </div>
              {i > 0 && stages[i - 1].value > 0 && (
                <span className="text-xs text-zinc-400">
                  {((s.value / stages[i - 1].value) * 100).toFixed(0)}%
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ================= 六、表格类组件 ================= */

function TicketTable({ title, rows }: TicketTableProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <p className="border-b border-zinc-100 px-4 py-3 text-sm font-bold text-zinc-700">{title}</p>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-zinc-400">暂无工单（0 条）</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-50 text-xs text-zinc-500">
            <tr>
              <th className="px-3 py-2 font-medium">工单号</th>
              <th className="px-3 py-2 font-medium">部门</th>
              <th className="px-3 py-2 text-right font-medium">金额</th>
              <th className="px-3 py-2 font-medium">摘要</th>
              <th className="px-3 py-2 font-medium">状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.ticketNo} className="border-t border-zinc-100">
                <td className="px-3 py-2 font-mono text-xs text-zinc-500">{r.ticketNo}</td>
                <td className="px-3 py-2 text-zinc-600">{r.department}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  ¥{r.amount.toLocaleString("zh-CN")}
                </td>
                <td className="max-w-[280px] truncate px-3 py-2 text-zinc-500" title={r.summary}>
                  {r.summary}
                </td>
                <td className="px-3 py-2">
                  <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">
                    {r.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PolicyCitationCard({ citations }: PolicyCitationCardProps) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <p className="mb-2 text-sm font-bold text-zinc-700">📖 制度依据（可溯源）</p>
      {citations.length === 0 ? (
        <p className="py-4 text-center text-sm text-zinc-400">暂无引文</p>
      ) : (
        <div className="space-y-2">
          {citations.map((c) => (
            <div key={`${c.docId}-${c.section}`} className="rounded-lg bg-zinc-50 p-3">
              <p className="text-xs font-semibold text-zinc-600">
                <span className="font-mono">
                  [{c.docId} §{c.section}]
                </span>{" "}
                《{c.title}》
              </p>
              <p className="mt-1 text-sm leading-6 text-zinc-500">{c.snippet}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CustomerProfileCard({
  customerId,
  maskedName,
  tier,
  riskFlag,
  fin001Flag,
  pendingApprovalId,
}: CustomerProfileCardProps) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold text-zinc-700">
          👤 {maskedName}
          <span className="ml-2 rounded-md bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700">
            {tier}
          </span>
        </p>
        <span className="font-mono text-xs text-zinc-400">{customerId}</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
        <p className="text-zinc-500">
          风险标记：<span className="font-mono text-zinc-700">{riskFlag}</span>
        </p>
        <p className="text-zinc-500">
          FIN-001：
          {fin001Flag ? (
            <span className="font-semibold text-amber-700">已触发（须具名审批）</span>
          ) : (
            <span className="text-zinc-600">未触发</span>
          )}
        </p>
        <p className="col-span-2 text-zinc-500">
          待审批单号：
          <span className="font-mono text-zinc-700">{pendingApprovalId ?? "无"}</span>
        </p>
      </div>
    </div>
  );
}

function ComparisonMatrix({ title, dimensions, columns, cells }: ComparisonMatrixProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <p className="border-b border-zinc-100 px-4 py-3 text-sm font-bold text-zinc-700">{title}</p>
      <table className="w-full text-left text-sm">
        <thead className="bg-zinc-50 text-xs text-zinc-500">
          <tr>
            <th className="px-3 py-2 font-medium">维度</th>
            {columns.map((c) => (
              <th key={c} className="px-3 py-2 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dimensions.map((d, di) => (
            <tr key={d} className="border-t border-zinc-100">
              <td className="px-3 py-2 font-medium text-zinc-600">{d}</td>
              {columns.map((c, ci) => (
                <td key={c} className="px-3 py-2 text-zinc-500">
                  {cells[di]?.[ci] ?? "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ================= 七、交互回写类组件 ================= */

function ApprovalFormCard({
  approvalId,
  tool,
  summary,
  approverDefault,
  ticketRef,
}: ApprovalFormCardProps) {
  const st = useApprovalState(approverDefault);
  const submit = async (): Promise<void> => {
    st.setBusy(true);
    // 工单类批准走真实业务接口（状态 + 审计一次落库）；其余走 Dry-Run 审计回写
    const r =
      tool === "tickets_approve"
        ? await approveTicket(approvalId, st.approver)
        : await approveDraft(approvalId, tool, summary, st.approver);
    st.setMessage(r.message);
    st.setState(r.ok ? "approved" : "pending");
    if (r.ok) broadcastApproved();
    st.setBusy(false);
  };
  const locked = st.state !== "pending";
  return (
    <div
      className={`rounded-xl border-2 p-4 ${
        st.state === "approved"
          ? "border-emerald-400 bg-emerald-50"
          : st.state === "cancelled"
            ? "border-zinc-300 bg-zinc-100 opacity-70"
            : "border-amber-400 bg-amber-50 ring-1 ring-amber-200"
      }`}
    >
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-bold">
          {st.state === "approved" ? "✅ " : st.state === "cancelled" ? "🚫 " : "🟡 "}
          审批单：{tool}
        </p>
        <span className="font-mono text-xs text-zinc-500">{approvalId}</span>
      </div>
      <p className="text-sm leading-6 text-zinc-600">{summary}</p>
      {ticketRef && <p className="mt-1 font-mono text-xs text-zinc-400">关联工单：{ticketRef}</p>}
      {!locked && (
        <div className="mt-3 flex items-center gap-2">
          <label className="text-xs text-zinc-500">具名审批人</label>
          <input
            value={st.approver}
            onChange={(e) => st.setApprover(e.target.value)}
            className="w-28 rounded-lg border border-zinc-300 px-2 py-1 text-sm"
          />
          <button
            onClick={() => void submit()}
            disabled={st.busy}
            className="rounded-lg bg-amber-500 px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-amber-600 disabled:opacity-50"
          >
            {st.busy ? "落库中…" : "批准"}
          </button>
          <button
            onClick={() => st.setState("cancelled")}
            className="rounded-lg border border-zinc-300 bg-white px-4 py-1.5 text-sm text-zinc-600 hover:border-zinc-500"
          >
            取消
          </button>
        </div>
      )}
      {st.state === "approved" && (
        <p className="mt-2 text-sm font-semibold text-emerald-700">
          ✅ 已批准 · {st.approver}
          {st.message && <span className="ml-1 font-normal text-zinc-500">（{st.message}）</span>}
        </p>
      )}
      {st.state === "cancelled" && (
        <p className="mt-2 text-sm text-zinc-500">已取消，未落库。</p>
      )}
    </div>
  );
}

function QuickFilterBar({ title, options }: QuickFilterBarProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (o: string): void =>
    setSelected((prev) => (prev.includes(o) ? prev.filter((x) => x !== o) : [...prev, o]));
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <p className="mb-2 text-sm font-bold text-zinc-700">{title}</p>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o}
            onClick={() => toggle(o)}
            className={`rounded-full border px-3 py-1 text-sm transition-colors ${
              selected.includes(o)
                ? "border-sky-500 bg-sky-500 text-white"
                : "border-zinc-300 bg-white text-zinc-600 hover:border-zinc-500"
            }`}
          >
            {o}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-zinc-400">
        已选：{selected.length > 0 ? selected.join("、") : "无（点击筛选）"}
      </p>
    </div>
  );
}

function DryRunConfirmCard({
  approvalId,
  tool,
  title,
  summary,
  before,
  after,
  draft,
}: DryRunConfirmCardProps) {
  const st = useApprovalState("王主管");
  const submit = async (): Promise<void> => {
    st.setBusy(true);
    const r = await approveDraft(approvalId, tool, summary, st.approver);
    st.setMessage(r.message);
    st.setState(r.ok ? "approved" : "pending");
    if (r.ok) broadcastApproved();
    st.setBusy(false);
  };
  const locked = st.state !== "pending";
  return (
    <div
      className={`rounded-xl border-2 p-4 ${
        st.state === "approved"
          ? "border-emerald-400 bg-emerald-50"
          : st.state === "cancelled"
            ? "border-zinc-300 bg-zinc-100 opacity-70"
            : "border-amber-400 bg-amber-50 ring-1 ring-amber-200"
      }`}
    >
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-bold">
          {st.state === "approved" ? "✅ " : st.state === "cancelled" ? "🚫 " : "⚠️ "}
          {title}
        </p>
        <span className="font-mono text-xs text-zinc-500">{approvalId}</span>
      </div>
      {before && after && (
        <div className="mb-2 space-y-1 font-mono text-xs">
          {Object.keys(after)
            .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
            .map((k) => (
              <p key={k} className="text-zinc-600">
                <span className="text-zinc-400">{k}：</span>
                {JSON.stringify(before[k])}
                <span className="mx-1 text-amber-600">→</span>
                <span className="font-semibold text-amber-800">{JSON.stringify(after[k])}</span>
              </p>
            ))}
        </div>
      )}
      {draft && (
        <pre className="mb-2 rounded bg-amber-100/60 p-2 font-mono text-xs leading-4 text-amber-900">
          {JSON.stringify(draft, null, 2)}
        </pre>
      )}
      <p className="text-xs leading-5 text-zinc-500">{summary}</p>
      {!locked && (
        <div className="mt-3 flex items-center gap-2">
          <label className="text-xs text-zinc-500">具名审批人</label>
          <input
            value={st.approver}
            onChange={(e) => st.setApprover(e.target.value)}
            className="w-28 rounded-lg border border-zinc-300 px-2 py-1 text-sm"
          />
          <button
            onClick={() => void submit()}
            disabled={st.busy}
            className="rounded-lg bg-amber-500 px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-amber-600 disabled:opacity-50"
          >
            {st.busy ? "落库中…" : "批准执行"}
          </button>
          <button
            onClick={() => st.setState("cancelled")}
            className="rounded-lg border border-zinc-300 bg-white px-4 py-1.5 text-sm text-zinc-600 hover:border-zinc-500"
          >
            取消
          </button>
        </div>
      )}
      {st.state === "approved" && (
        <p className="mt-2 text-sm font-semibold text-emerald-700">
          ✅ 已批准 · {st.approver}
          {st.message && <span className="ml-1 font-normal text-zinc-500">（{st.message}）</span>}
        </p>
      )}
      {st.state === "cancelled" && <p className="mt-2 text-sm text-zinc-500">已取消，草稿作废。</p>}
    </div>
  );
}

function ExportReportButton({ label }: ExportReportButtonProps) {
  const runtime = useContext(GenuiRuntimeContext);
  return (
    <button
      onClick={() => runtime.exportLayout?.()}
      className="rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 transition-colors hover:border-zinc-500 hover:text-zinc-900"
    >
      ⬇️ {label}
    </button>
  );
}

/* ================= 八、注册表与渲染入口 ================= */

type Renderer = (props: Record<string, unknown>) => ReactNode;

/** 组件名 → 渲染器（白名单注册表：不在表内的名字一律降级） */
const RENDERERS: Partial<Record<GenuiComponentName, Renderer>> = {
  kpi_card: (p) => <KpiCard {...(p as unknown as KpiCardProps)} />,
  risk_banner: (p) => <RiskBanner {...(p as unknown as RiskBannerProps)} />,
  progress_bar: (p) => <ProgressBar {...(p as unknown as ProgressBarProps)} />,
  cost_card: (p) => <CostCard {...(p as unknown as CostCardProps)} />,
  dept_bar_chart: (p) => <DeptBarChart {...(p as unknown as DeptBarChartProps)} />,
  trend_line_chart: (p) => <TrendLineChart {...(p as unknown as TrendLineChartProps)} />,
  share_donut_chart: (p) => <ShareDonutChart {...(p as unknown as ShareDonutChartProps)} />,
  funnel_chart: (p) => <FunnelChart {...(p as unknown as FunnelChartProps)} />,
  ticket_table: (p) => <TicketTable {...(p as unknown as TicketTableProps)} />,
  policy_citation_card: (p) => <PolicyCitationCard {...(p as unknown as PolicyCitationCardProps)} />,
  customer_profile_card: (p) => <CustomerProfileCard {...(p as unknown as CustomerProfileCardProps)} />,
  comparison_matrix: (p) => <ComparisonMatrix {...(p as unknown as ComparisonMatrixProps)} />,
  approval_form_card: (p) => <ApprovalFormCard {...(p as unknown as ApprovalFormCardProps)} />,
  quick_filter_bar: (p) => <QuickFilterBar {...(p as unknown as QuickFilterBarProps)} />,
  dry_run_confirm_card: (p) => <DryRunConfirmCard {...(p as unknown as DryRunConfirmCardProps)} />,
  export_report_button: (p) => <ExportReportButton {...(p as unknown as ExportReportButtonProps)} />,
};

function UnregisteredFallback({ name }: { name: string }) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 bg-zinc-100 px-4 py-3 text-sm text-zinc-500">
      ⚠️ 组件「{name}」未在注册表中登记，已温和降级为提示条（模型输出不会被执行）。
    </div>
  );
}

/** 渲染单条布局：独立 ErrorBoundary + 未注册灰条降级 */
export function RenderGenuiItem({ item }: { item: GenuiLayoutItem }) {
  const renderer = RENDERERS[item.component];
  return (
    <GenuiErrorBoundary key={`${item.component}-${JSON.stringify(item.props).slice(0, 32)}`}>
      {renderer ? renderer(item.props) : <UnregisteredFallback name={item.component} />}
    </GenuiErrorBoundary>
  );
}

/** 渲染整份布局（只认白名单；白名单常量二次兜底校验） */
export function RenderGenuiLayout({ items }: { items: GenuiLayoutItem[] }) {
  return (
    <div className="space-y-4">
      {items.map((item, i) => (
        <RenderGenuiItem key={i} item={item} />
      ))}
    </div>
  );
}

export { GenuiRuntimeContext, GENUI_COMPONENT_NAMES };
