"use client";

import { useState } from "react";

type TicketStatus =
  | "待林总审批"
  | "处理中"
  | "待财务复核"
  | "待寄回验收"
  | "已批准";

interface Ticket {
  id: string;
  department: "财务部" | "运营部" | "客服部";
  amount: number;
  summary: string;
  status: TicketStatus;
  approvedAt?: string;
}

const INITIAL_TICKETS: Ticket[] = [
  {
    id: "T-2026-1101",
    department: "财务部",
    amount: 68500,
    summary:
      "德国仓滞销库存退货款，供应商发票合计与明细相差 ¥210，算术核对未通过，已标记疑似错账。",
    status: "待林总审批",
  },
  {
    id: "T-2026-1102",
    department: "财务部",
    amount: 52300,
    summary:
      "PayPal 收款汇率差额批量退款，涉及 3 个境外收款账户，需按现行 FIN-001 制度具名审批。",
    status: "待林总审批",
  },
  {
    id: "T-2026-1103",
    department: "财务部",
    amount: 49800,
    summary:
      "深圳物流商 Q4 运费对账争议退款。金额刚好低于 ¥50,000 红线，不触发 FIN-001。",
    status: "处理中",
  },
  {
    id: "T-2026-1104",
    department: "运营部",
    amount: 12000,
    summary:
      "广告投放误充值退款：德国站 CampA 系统多扣 5 天预算，运营部申请原路退回。",
    status: "待财务复核",
  },
  {
    id: "T-2026-1105",
    department: "客服部",
    amount: 860,
    summary:
      "客户 FR-1042 反映订单少发一件商品，客服与仓库核实后按缺件部分退款。",
    status: "处理中",
  },
  {
    id: "T-2026-1106",
    department: "客服部",
    amount: 3200,
    summary:
      "美国客户尺码不符申请退货，全额退款含原运费，需等包裹寄回仓库验收后放款。",
    status: "待寄回验收",
  },
];

const FILTERS = ["全部", "运营部", "财务部", "客服部"] as const;
type Filter = (typeof FILTERS)[number];

const FIN_THRESHOLD = 50000;

const STATUS_STYLES: Record<TicketStatus, string> = {
  待林总审批: "bg-amber-100 text-amber-800 border-amber-300",
  处理中: "bg-sky-100 text-sky-700 border-sky-300",
  待财务复核: "bg-violet-100 text-violet-700 border-violet-300",
  待寄回验收: "bg-zinc-100 text-zinc-600 border-zinc-300",
  已批准: "bg-emerald-100 text-emerald-700 border-emerald-300",
};

export default function Home() {
  const [tickets, setTickets] = useState<Ticket[]>(INITIAL_TICKETS);
  const [filter, setFilter] = useState<Filter>("全部");

  // 财务红线 FIN-001：单笔超过 ¥50,000 强制具名人工审批
  const needsFinApproval = (t: Ticket) =>
    t.department === "财务部" && t.amount > FIN_THRESHOLD;

  const approve = (id: string) => {
    setTickets((prev) =>
      prev.map((t) =>
        t.id === id
          ? {
              ...t,
              status: "已批准" as TicketStatus,
              approvedAt: new Date().toLocaleString("zh-CN", {
                hour12: false,
              }),
            }
          : t,
      ),
    );
  };

  const visible =
    filter === "全部"
      ? tickets
      : tickets.filter((t) => t.department === filter);

  return (
    <div className="min-h-screen bg-zinc-50 px-4 py-8 font-sans text-zinc-900 sm:px-6">
      <main className="mx-auto w-full max-w-4xl">
        {/* 标题区 */}
        <header className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            星辰跨境企服集团 · WorkBot 异常工单协同台
          </h1>
          <p className="mt-2 text-sm leading-6 text-zinc-500">
            财务红线 FIN-001：单笔超过 ¥50,000 的付款，必须由具名审批人人工签字放行。
          </p>
        </header>

        {/* 部门筛选标签 */}
        <div className="mb-6 flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${
                filter === f
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-zinc-300 bg-white text-zinc-600 hover:border-zinc-500"
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        {/* 工单卡片列表 */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {visible.map((t) => {
            const fin = needsFinApproval(t);
            return (
              <article
                key={t.id}
                className={`rounded-xl border p-5 shadow-sm transition-shadow hover:shadow-md ${
                  fin
                    ? "border-2 border-amber-400 bg-amber-50 ring-1 ring-amber-200"
                    : "border-zinc-200 bg-white"
                }`}
              >
                {/* 卡片头：编号 + 部门 + 金额 */}
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-zinc-400">
                      {t.id}
                    </span>
                    <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">
                      {t.department}
                    </span>
                  </div>
                  <span className="text-lg font-bold tabular-nums">
                    ¥{t.amount.toLocaleString("zh-CN")}
                  </span>
                </div>

                {/* FIN-001 预警徽章 */}
                {fin && (
                  <div className="mb-3 inline-flex items-center gap-1.5 rounded-md border border-amber-400 bg-amber-500 px-2.5 py-1 text-xs font-bold text-white">
                    <span aria-hidden>⚠️</span> FIN-001 强制人工审批
                  </div>
                )}

                {/* 摘要 */}
                <p className="mb-4 text-sm leading-6 text-zinc-600">
                  {t.summary}
                </p>

                {/* 状态 + 操作区 */}
                <div className="flex items-center justify-between gap-3">
                  <span
                    className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${STATUS_STYLES[t.status]}`}
                  >
                    {t.status}
                    {t.status === "已批准" && t.approvedAt && (
                      <span className="ml-1.5 font-normal tabular-nums">
                        · {t.approvedAt}
                      </span>
                    )}
                  </span>

                  {/* 具名人工审批按钮（仅 FIN-001 单据出现） */}
                  {fin && t.status !== "已批准" && (
                    <button
                      onClick={() => approve(t.id)}
                      className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-600 active:scale-95"
                    >
                      林总批准放行
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        {/* 权限边界声明 */}
        <footer className="mt-8 rounded-xl border border-zinc-200 bg-white p-4 text-xs leading-6 text-zinc-500">
          🔒 本协同台严格遵循《The Agent Line 权限边界签字单》（04 号文档）红区条款：
          全站不提供任何「AI 自动打款」能力，每笔大额放行均由具名审批人点击确认，操作全程留痕。
        </footer>
      </main>
    </div>
  );
}
