"use client";

/**
 * ENG-101 · 工单详情抽屉组件
 * 溯源：03 方案书第四节（只读暂存区 → 判定结果）；04 号文档绿区 G1~G4（只读）
 * 边界：本组件只读展示，无任何放款 / 执行 / 修改按钮；
 *      Props 类型本地声明，不 import 其他组件（正交性要求）。
 */

// 工单详情类型：本地声明（ENG-105 挂载时按此接线）
export interface TicketDetail {
  id: string;
  department: string;
  amount: number;
  summary: string;
  status: string;
  approvedAt?: string;
  customerName: string;
  bankAccount: string;
}

interface TicketDrawerProps {
  /** 当前要展示的工单；null 表示抽屉收起 */
  ticket: TicketDetail | null;
  /** 收起抽屉的回调（由 ENG-105 接线） */
  onClose: () => void;
}

/** 姓名脱敏：张三 → 张*（AGENTS.md 代码红线 3） */
function maskName(name: string): string {
  if (name.length <= 1) return name;
  return name.charAt(0) + "*".repeat(name.length - 1);
}

/** 银行账号脱敏：6222020200112341234 → 6222 **** **** 1234 */
function maskAccount(account: string): string {
  if (account.length < 8) return "****";
  return `${account.slice(0, 4)} **** **** ${account.slice(-4)}`;
}

export default function TicketDrawer({ ticket, onClose }: TicketDrawerProps) {
  // 收起状态不渲染（受控组件，开合由 ENG-105 接线）
  if (ticket === null) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      onClick={onClose}
      role="dialog"
      aria-label="工单详情"
    >
      {/* 右侧抽屉面板：阻止点击面板内部时关闭 */}
      <div
        className="h-full w-full max-w-md overflow-y-auto bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 抽屉头 */}
        <div className="mb-5 flex items-start justify-between">
          <div>
            <p className="font-mono text-xs text-zinc-400">{ticket.id}</p>
            <h2 className="mt-1 text-xl font-bold">工单详情</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭详情抽屉"
            className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-500 transition-colors hover:border-zinc-400 hover:text-zinc-800"
          >
            收起 ×
          </button>
        </div>

        {/* 基础信息（全部只读） */}
        <dl className="space-y-4 text-sm">
          <div className="flex items-center justify-between rounded-lg bg-zinc-50 px-4 py-3">
            <dt className="text-zinc-500">所属部门</dt>
            <dd className="font-semibold">{ticket.department}</dd>
          </div>
          <div className="flex items-center justify-between rounded-lg bg-zinc-50 px-4 py-3">
            <dt className="text-zinc-500">工单金额</dt>
            <dd className="text-lg font-bold tabular-nums">
              ¥{ticket.amount.toLocaleString("zh-CN")}
            </dd>
          </div>
          <div className="flex items-center justify-between rounded-lg bg-zinc-50 px-4 py-3">
            <dt className="text-zinc-500">当前状态</dt>
            <dd className="font-semibold">{ticket.status}</dd>
          </div>
          {ticket.approvedAt && (
            <div className="flex items-center justify-between rounded-lg bg-emerald-50 px-4 py-3">
              <dt className="text-zinc-500">审批时间</dt>
              <dd className="font-semibold tabular-nums text-emerald-700">
                {ticket.approvedAt}
              </dd>
            </div>
          )}
        </dl>

        {/* 摘要 */}
        <div className="mt-5">
          <h3 className="mb-2 text-sm font-semibold text-zinc-500">异常摘要</h3>
          <p className="rounded-lg border border-zinc-100 bg-white p-4 text-sm leading-6 text-zinc-700">
            {ticket.summary}
          </p>
        </div>

        {/* 客户信息（一律脱敏展示） */}
        <div className="mt-5">
          <h3 className="mb-2 text-sm font-semibold text-zinc-500">
            客户信息（已脱敏）
          </h3>
          <dl className="space-y-2 rounded-lg border border-zinc-100 p-4 text-sm">
            <div className="flex justify-between">
              <dt className="text-zinc-500">客户姓名</dt>
              <dd className="font-mono">{maskName(ticket.customerName)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">银行账号</dt>
              <dd className="font-mono">{maskAccount(ticket.bankAccount)}</dd>
            </div>
          </dl>
        </div>

        {/* 只读声明 */}
        <p className="mt-6 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs leading-5 text-zinc-400">
          🔒 本详情页为只读视图：查看与标记工作由系统完成，放行一律由具名审批人在工单卡片上点击确认。
        </p>
      </div>
    </div>
  );
}
