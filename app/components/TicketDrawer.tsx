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
      {/* 右侧抽屉面板：阻止点击面板内部时关闭（毛玻璃质感） */}
      <div
        className="glass h-full w-full max-w-md overflow-y-auto border-l border-hairline p-6 text-ink shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 抽屉头 */}
        <div className="mb-5 flex items-start justify-between">
          <div>
            <p className="font-mono text-xs text-ink-3">{ticket.id}</p>
            <h2 className="mt-1 text-xl font-semibold tracking-tight">工单详情</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭详情抽屉"
            className="rounded-full border border-hairline bg-white px-3.5 py-1.5 text-sm text-ink-2 transition hover:bg-black/5 hover:text-ink"
          >
            收起 ×
          </button>
        </div>

        {/* 基础信息（全部只读） */}
        <dl className="space-y-3 text-sm">
          <div className="flex items-center justify-between rounded-[12px] bg-black/[0.03] px-4 py-3">
            <dt className="text-ink-2">所属部门</dt>
            <dd className="font-semibold">{ticket.department}</dd>
          </div>
          <div className="flex items-center justify-between rounded-[12px] bg-black/[0.03] px-4 py-3">
            <dt className="text-ink-2">工单金额</dt>
            <dd className="text-lg font-semibold tracking-tight tabular-nums">
              ¥{ticket.amount.toLocaleString("zh-CN")}
            </dd>
          </div>
          <div className="flex items-center justify-between rounded-[12px] bg-black/[0.03] px-4 py-3">
            <dt className="text-ink-2">当前状态</dt>
            <dd className="font-semibold">{ticket.status}</dd>
          </div>
          {ticket.approvedAt && (
            <div className="flex items-center justify-between rounded-[12px] bg-emerald-500/10 px-4 py-3">
              <dt className="text-ink-2">审批时间</dt>
              <dd className="font-semibold tabular-nums text-emerald-700">
                {ticket.approvedAt}
              </dd>
            </div>
          )}
        </dl>

        {/* 摘要 */}
        <div className="mt-5">
          <h3 className="mb-2 text-sm font-semibold text-ink-2">异常摘要</h3>
          <p className="rounded-[12px] border border-hairline bg-white p-4 text-sm leading-6 text-ink-2">
            {ticket.summary}
          </p>
        </div>

        {/* 客户信息（一律脱敏展示） */}
        <div className="mt-5">
          <h3 className="mb-2 text-sm font-semibold text-ink-2">
            客户信息（已脱敏）
          </h3>
          <dl className="space-y-2 rounded-[12px] border border-hairline p-4 text-sm">
            <div className="flex justify-between">
              <dt className="text-ink-2">客户姓名</dt>
              <dd className="font-mono">{maskName(ticket.customerName)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-2">银行账号</dt>
              <dd className="font-mono">{maskAccount(ticket.bankAccount)}</dd>
            </div>
          </dl>
        </div>

        {/* 只读声明 */}
        <p className="mt-6 rounded-[12px] border border-hairline bg-black/[0.03] p-3 text-xs leading-5 text-ink-3">
          🔒 本详情页为只读视图：查看与标记工作由系统完成，放行一律由具名审批人在工单卡片上点击确认。
        </p>
      </div>
    </div>
  );
}
