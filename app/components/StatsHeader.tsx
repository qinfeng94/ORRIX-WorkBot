"use client";

/**
 * ENG-103 · 金额统计顶栏组件
 * 溯源：03 方案书第一节（MVV：林总不点任何东西就能看懂风险）+ 第三节（ROI 数字口径）
 * 越界警示：只做当前工单列表的数字汇总，严禁引入图表库、趋势图等"数据看板"能力（Non-Goal 4）。
 * 边界：Props 类型本地声明，不 import 其他组件；FIN-001 判定函数由 ENG-105 注入（阈值单点唯一）。
 */

// 统计所需的最小工单字段：本地声明
export interface TicketStat {
  id: string;
  department: string;
  amount: number;
  status: string;
}

interface StatsHeaderProps {
  /** 当前可见的工单列表（筛选后，随筛选联动更新） */
  tickets: TicketStat[];
  /**
   * FIN-001 大额判定函数（由 ENG-105 注入，阈值判定逻辑全站单点唯一，
   * 本组件绝不自行复制或改写判定规则）
   */
  isLargeAmount: (t: TicketStat) => boolean;
}

// 待审批状态口径（展示口径，非红线判定）：含这两个状态的工单计入"待审批"
const PENDING_STATUSES = ["待林总审批", "待财务复核"] as const;

export default function StatsHeader({ tickets, isLargeAmount }: StatsHeaderProps) {
  const total = tickets.length;
  const pending = tickets.filter((t) =>
    (PENDING_STATUSES as readonly string[]).includes(t.status),
  ).length;
  const largeTotal = tickets
    .filter(isLargeAmount)
    .reduce((sum, t) => sum + t.amount, 0);

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3" role="status" aria-label="工单金额统计">
      <div className="bento p-5">
        <p className="text-xs font-medium text-ink-3">工单总数</p>
        <p className="mt-1.5 text-[26px] font-semibold tracking-tight tabular-nums text-ink">{total}</p>
        <p className="mt-0.5 text-xs text-ink-3">当前筛选范围内</p>
      </div>

      <div className="bento p-5">
        <p className="text-xs font-medium text-ink-3">待审批</p>
        <p className="mt-1.5 text-[26px] font-semibold tracking-tight tabular-nums text-amber-600">{pending}</p>
        <p className="mt-0.5 text-xs text-ink-3">需要人处理的单据</p>
      </div>

      <div className="amber-glow-card p-5">
        <p className="text-xs font-medium text-amber-700">FIN-001 大额合计</p>
        <p className="mt-1.5 text-[26px] font-semibold tracking-tight tabular-nums text-amber-700">
          ¥{largeTotal.toLocaleString("zh-CN")}
        </p>
        <p className="mt-0.5 text-xs text-amber-600">单笔超 ¥50,000 的工单金额之和</p>
      </div>
    </div>
  );
}
