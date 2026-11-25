"use client";

/**
 * ENG-105 · 四组件统一挂载进首页
 * 溯源：03 方案书第一节（MVV）+ 第四节（数据流图整体串接）
 * 边界：只挂载传 Props，严禁改动四个组件内部实现（day4 工单 Forbidden Files）；
 *      FIN-001 判定逻辑（isLargeAmount）为全站单点唯一来源。
 */

import { useMemo, useState } from "react";
import TicketDrawer from "./components/TicketDrawer";
import TicketSearchBar from "./components/TicketSearchBar";
import StatsHeader from "./components/StatsHeader";
import ApprovalTimeline, {
  type ApprovalEvent,
} from "./components/ApprovalTimeline";

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
  // 客户信息（测试数据一律虚构，展示层由 ENG-101 抽屉统一脱敏）
  customerName: string;
  bankAccount: string;
}

const INITIAL_TICKETS: Ticket[] = [
  {
    id: "T-2026-1101",
    department: "财务部",
    amount: 68500,
    summary:
      "德国仓滞销库存退货款，供应商发票合计与明细相差 ¥210，算术核对未通过，已标记疑似错账。",
    status: "待林总审批",
    customerName: "陈建国",
    bankAccount: "6222020200112341234",
  },
  {
    id: "T-2026-1102",
    department: "财务部",
    amount: 52300,
    summary:
      "PayPal 收款汇率差额批量退款，涉及 3 个境外收款账户，需按现行 FIN-001 制度具名审批。",
    status: "待林总审批",
    customerName: "周文彬",
    bankAccount: "6217000010087654321",
  },
  {
    id: "T-2026-1103",
    department: "财务部",
    amount: 49800,
    summary:
      "深圳物流商 Q4 运费对账争议退款。金额刚好低于 ¥50,000 红线，不触发 FIN-001。",
    status: "处理中",
    customerName: "吴晓岚",
    bankAccount: "6222081002234567890",
  },
  {
    id: "T-2026-1104",
    department: "运营部",
    amount: 12000,
    summary:
      "广告投放误充值退款：德国站 CampA 系统多扣 5 天预算，运营部申请原路退回。",
    status: "待财务复核",
    customerName: "郑海涛",
    bankAccount: "6225880137788899001",
  },
  {
    id: "T-2026-1105",
    department: "客服部",
    amount: 860,
    summary:
      "客户 FR-1042 反映订单少发一件商品，客服与仓库核实后按缺件部分退款。",
    status: "处理中",
    customerName: "马静怡",
    bankAccount: "6226090219988776655",
  },
  {
    id: "T-2026-1106",
    department: "客服部",
    amount: 3200,
    summary:
      "美国客户尺码不符申请退货，全额退款含原运费，需等包裹寄回仓库验收后放款。",
    status: "待寄回验收",
    customerName: "何雨欣",
    bankAccount: "6228480402564890011",
  },
];

// 预置审批历史（全部虚构，供时间轴展示；只增不改，新事件追加在内存列表末尾）
const INITIAL_EVENTS: ApprovalEvent[] = [
  {
    id: "E-0001",
    approver: "林总",
    timestamp: "2026-11-24T09:30:00+08:00",
    action: "放行工单 T-2026-1096（¥61,200）：德国仓退货款，已确认发票明细核对通过。",
    isFin001: true,
  },
  {
    id: "E-0002",
    approver: "王主管",
    timestamp: "2026-11-24T15:05:00+08:00",
    action: "确认发送工单 T-2026-1097 的退款结果通知客户。",
    isFin001: false,
  },
];

const STATUS_STYLES: Record<TicketStatus, string> = {
  待林总审批: "bg-amber-100 text-amber-800 border-amber-300",
  处理中: "bg-sky-100 text-sky-700 border-sky-300",
  待财务复核: "bg-violet-100 text-violet-700 border-violet-300",
  待寄回验收: "bg-zinc-100 text-zinc-600 border-zinc-300",
  已批准: "bg-emerald-100 text-emerald-700 border-emerald-300",
};

export default function Home() {
  const [tickets, setTickets] = useState<Ticket[]>(INITIAL_TICKETS);
  const [events, setEvents] = useState<ApprovalEvent[]>(INITIAL_EVENTS);
  const [keyword, setKeyword] = useState("");
  const [department, setDepartment] = useState("全部");
  const [drawerTicket, setDrawerTicket] = useState<Ticket | null>(null);

  // 🔴 FIN-001 判定：全站单点唯一来源（单点阈值 ¥50,000，「超过」才触发）
  const isLargeAmount = (t: { department: string; amount: number }) =>
    t.department === "财务部" && t.amount > 50000;

  // 过滤：部门标签与关键词搜索可叠加
  const visible = useMemo(() => {
    let list =
      department === "全部"
        ? tickets
        : tickets.filter((t) => t.department === department);
    const kw = keyword.trim();
    if (kw.length > 0) {
      list = list.filter(
        (t) => t.id.toLowerCase().includes(kw.toLowerCase()) || t.summary.includes(kw),
      );
    }
    return list;
  }, [tickets, keyword, department]);

  // 具名人工审批：状态变翠绿「已批准」+ 时间戳，并向时间轴追加事件（只增）
  const approve = (id: string) => {
    setTickets((prev) =>
      prev.map((t) =>
        t.id === id
          ? {
              ...t,
              status: "已批准" as TicketStatus,
              approvedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
            }
          : t,
      ),
    );
    const target = tickets.find((t) => t.id === id);
    if (target) {
      setEvents((prev) => [
        ...prev,
        {
          id: `E-${Date.now()}`,
          approver: "林总",
          timestamp: new Date().toISOString(),
          action: `放行工单 ${target.id}（¥${target.amount.toLocaleString("zh-CN")}）：具名审批通过。`,
          isFin001: isLargeAmount(target),
        },
      ]);
    }
  };

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

        {/* ① 金额统计顶栏（ENG-103） */}
        <div className="mb-6">
          <StatsHeader tickets={visible} isLargeAmount={isLargeAmount} />
        </div>

        {/* ② 搜索过滤条（ENG-102） */}
        <div className="mb-6">
          <TicketSearchBar
            keyword={keyword}
            onKeywordChange={setKeyword}
            department={department}
            onDepartmentChange={setDepartment}
          />
        </div>

        {/* ③ 工单卡片列表 + 详情抽屉（ENG-101） */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {visible.map((t) => {
            const fin = isLargeAmount(t);
            return (
              <article
                key={t.id}
                onClick={() => setDrawerTicket(t)}
                className={`cursor-pointer rounded-xl border p-5 shadow-sm transition-shadow hover:shadow-md ${
                  fin
                    ? "border-2 border-amber-400 bg-amber-50 ring-1 ring-amber-200"
                    : "border-zinc-200 bg-white"
                }`}
              >
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-zinc-400">{t.id}</span>
                    <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">
                      {t.department}
                    </span>
                  </div>
                  <span className="text-lg font-bold tabular-nums">
                    ¥{t.amount.toLocaleString("zh-CN")}
                  </span>
                </div>

                {/* FIN-001 预警徽章（判定来源：isLargeAmount 单点） */}
                {fin && (
                  <div className="mb-3 inline-flex items-center gap-1.5 rounded-md border border-amber-400 bg-amber-500 px-2.5 py-1 text-xs font-bold text-white">
                    <span aria-hidden>⚠️</span> FIN-001 强制人工审批
                  </div>
                )}

                <p className="mb-4 text-sm leading-6 text-zinc-600">{t.summary}</p>

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

                  {/* 具名人工审批按钮（仅 FIN-001 单据出现；阻止冒泡避免误开抽屉） */}
                  {fin && t.status !== "已批准" && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        approve(t.id);
                      }}
                      className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-600 active:scale-95"
                    >
                      林总批准放行
                    </button>
                  )}
                </div>
              </article>
            );
          })}
          {visible.length === 0 && (
            <p className="col-span-full rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-400">
              没有符合条件的工单，换个关键词或部门试试。
            </p>
          )}
        </div>

        {/* ④ 审批历史时间轴（ENG-104） */}
        <div className="mt-8">
          <ApprovalTimeline events={events} />
        </div>

        {/* 详情抽屉（ENG-101，开合受控） */}
        <TicketDrawer
          ticket={drawerTicket}
          onClose={() => setDrawerTicket(null)}
        />

        {/* 权限边界声明 */}
        <footer className="mt-8 rounded-xl border border-zinc-200 bg-white p-4 text-xs leading-6 text-zinc-500">
          🔒 本协同台严格遵循《The Agent Line 权限边界签字单》（04 号文档）红区条款：
          全站不提供任何「AI 自动打款」能力，每笔大额放行均由具名审批人点击确认，操作全程留痕。
        </footer>
      </main>
    </div>
  );
}
