"use client";

/**
 * ENG-105 · 四组件统一挂载进首页（Week 1 真实数据闭环版）
 * 溯源：03 方案书第一节（MVV）+ 第四节（数据流图整体串接）；
 *      04 号文档 CISO 条款 3（具名审批人）、条款 4（审计只增不改）。
 * 边界：只挂载传 Props，严禁改动四个组件内部实现（day4 工单 Forbidden Files）；
 *      FIN-001 判定逻辑（isLargeAmount）为全站单点唯一来源（@/lib/fin001）。
 * 新增：工单与审批记录真实读写 Postgres（Drizzle ORM），F5 刷新不再丢失任何状态。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TicketDrawer from "./components/TicketDrawer";
import TicketSearchBar from "./components/TicketSearchBar";
import StatsHeader from "./components/StatsHeader";
import ApprovalTimeline, {
  type ApprovalEvent,
} from "./components/ApprovalTimeline";
import { isLargeAmount } from "@/lib/fin001";
import type { TicketDTO, TicketsResponse } from "@/lib/ticket-dto";
import {
  FUNNEL_EVENTS,
  initPostHog,
  trackFunnel,
} from "@/lib/posthog";

const STATUS_STYLES: Record<string, string> = {
  待林总审批: "bg-amber-100 text-amber-800 border-amber-300",
  处理中: "bg-sky-100 text-sky-700 border-sky-300",
  待财务复核: "bg-violet-100 text-violet-700 border-violet-300",
  待寄回验收: "bg-zinc-100 text-zinc-600 border-zinc-300",
  已批准: "bg-emerald-100 text-emerald-700 border-emerald-300",
};

const DEPARTMENTS = ["财务部", "运营部", "客服部"] as const;

/** 数据库未接入时的引导面板文案 */
const SETUP_GUIDE = (
  <ol className="list-decimal space-y-1 pl-5 text-left">
    <li>
      注册免费云 Postgres（任选其一，无需信用卡）：
      <a
        className="ml-1 text-sky-700 underline"
        href="https://neon.tech"
        target="_blank"
        rel="noreferrer"
      >
        Neon
      </a>{" "}
      或{" "}
      <a
        className="text-sky-700 underline"
        href="https://supabase.com"
        target="_blank"
        rel="noreferrer"
      >
        Supabase
      </a>
      ；
    </li>
    <li>新建项目后复制「Connection String」（形如 postgresql://用户:密码@主机/库名）；</li>
    <li>把连接串填进项目根目录 .env.local 的 DATABASE_URL= 后面；</li>
    <li>重启开发服务器（pnpm dev），本页面会自动建表并写入预置工单。</li>
  </ol>
);

export default function Home() {
  const [tickets, setTickets] = useState<TicketDTO[]>([]);
  const [events, setEvents] = useState<ApprovalEvent[]>([]);
  const [keyword, setKeyword] = useState("");
  const [department, setDepartment] = useState("全部");
  const [drawerTicket, setDrawerTicket] = useState<TicketDTO | null>(null);

  // 数据加载状态
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);

  // 新建工单表单（非模态，直接内嵌）
  const [showForm, setShowForm] = useState(false);
  const [formDepartment, setFormDepartment] = useState<string>("财务部");
  const [formAmount, setFormAmount] = useState("");
  const [formCustomer, setFormCustomer] = useState("");
  const [formBank, setFormBank] = useState("");
  const [formSummary, setFormSummary] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // 漏斗去重：FIN-001 告警每个工单每会话只报一次
  const alertedTickets = useRef<Set<string>>(new Set());

  /** 从数据库加载工单与审计事件 */
  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/tickets", { cache: "no-store" });
      const data: unknown = await res.json();
      if (!res.ok) {
        const err = data as { error?: string; needsSetup?: boolean };
        setNeedsSetup(Boolean(err.needsSetup));
        throw new Error(err.error ?? "加载失败");
      }
      const body = data as TicketsResponse;
      setTickets(body.tickets);
      setEvents(body.events);
      setNeedsSetup(false);
      // 漏斗①：查看工单（每会话首次成功加载上报）
      trackFunnel(FUNNEL_EVENTS.ticketView, { ticketCount: body.tickets.length });
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  // 挂载：初始化埋点 + 拉取数据库
  useEffect(() => {
    void initPostHog().then(() => load());
  }, [load]);

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

  // 漏斗②：FIN-001 告警可见（当前可见列表里的每张大额工单只报一次）
  useEffect(() => {
    const fresh = visible
      .filter((t) => t.isFin001)
      .filter((t) => !alertedTickets.current.has(t.id));
    for (const t of fresh) {
      alertedTickets.current.add(t.id);
      trackFunnel(FUNNEL_EVENTS.fin001Alert, {
        ticketId: t.id,
        amount: t.amount,
      });
    }
  }, [visible]);

  // 具名人工审批：调接口落库（状态 + 时间戳 + 审计日志），成功后按响应刷新本地
  const approve = async (id: string): Promise<void> => {
    // 漏斗③：点击审批
    trackFunnel(FUNNEL_EVENTS.approveClick, { ticketId: id });
    try {
      const res = await fetch("/api/tickets/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketNo: id, approver: "林总" }),
      });
      const data: unknown = await res.json();
      if (!res.ok) {
        throw new Error((data as { error?: string }).error ?? "审批落库失败");
      }
      const body = data as { ticket: TicketDTO; event: ApprovalEvent };
      setTickets((prev) =>
        prev.map((t) => (t.id === id ? body.ticket : t)),
      );
      setEvents((prev) => [...prev, body.event]);
      // 漏斗④：落库成功
      trackFunnel(FUNNEL_EVENTS.dbWriteSuccess, { ticketId: id });
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "审批落库失败");
    }
  };

  /** 新建工单：提交到数据库，成功后把新单插到列表最前 */
  const submitNewTicket = async (): Promise<void> => {
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          department: formDepartment,
          amount: Number(formAmount),
          summary: formSummary,
          customerName: formCustomer,
          bankAccount: formBank,
        }),
      });
      const data: unknown = await res.json();
      if (!res.ok) {
        throw new Error((data as { error?: string }).error ?? "新建工单失败");
      }
      const body = data as { ticket: TicketDTO };
      setTickets((prev) => [body.ticket, ...prev]);
      setShowForm(false);
      setFormAmount("");
      setFormCustomer("");
      setFormBank("");
      setFormSummary("");
      trackFunnel(FUNNEL_EVENTS.ticketView, { source: "created", ticketId: body.ticket.id });
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : "新建工单失败");
    } finally {
      setSubmitting(false);
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
            工单与审批记录已持久化到数据库，刷新页面不再丢失。
          </p>
        </header>

        {/* 数据库未接入：一键引导（仅缺失 DATABASE_URL 时出现） */}
        {needsSetup && (
          <div className="mb-6 rounded-xl border-2 border-amber-400 bg-amber-50 p-5 text-sm leading-7 text-amber-900">
            <p className="mb-2 font-bold">⚠️ 数据库还没有接入（这页暂时读不到工单）</p>
            {SETUP_GUIDE}
          </div>
        )}
        {loadError && !needsSetup && (
          <div className="mb-6 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800">
            加载失败：{loadError}
            <button
              onClick={() => void load()}
              className="ml-3 rounded-md border border-red-300 bg-white px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-100"
            >
              重试
            </button>
          </div>
        )}

        {/* ① 金额统计顶栏（ENG-103） */}
        <div className="mb-6">
          <StatsHeader tickets={visible} isLargeAmount={isLargeAmount} />
        </div>

        {/* ② 搜索过滤条（ENG-102）+ 新建工单入口 */}
        <div className="mb-6 space-y-3">
          <TicketSearchBar
            keyword={keyword}
            onKeywordChange={setKeyword}
            department={department}
            onDepartmentChange={setDepartment}
          />
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowForm((v) => !v)}
              className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 transition-colors hover:border-zinc-500 hover:text-zinc-900"
            >
              {showForm ? "收起新建表单" : "＋ 新建工单"}
            </button>
            <button
              onClick={() => void load()}
              disabled={loading}
              className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-600 transition-colors hover:border-zinc-500 hover:text-zinc-900 disabled:opacity-50"
            >
              {loading ? "加载中…" : "⟳ 从数据库刷新"}
            </button>
          </div>

          {/* 新建工单表单（内嵌直排，非模态） */}
          {showForm && (
            <div className="rounded-xl border border-zinc-200 bg-white p-5">
              <p className="mb-4 text-sm font-semibold text-zinc-700">
                新建异常工单（提交后立即写入数据库）
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="mb-1 block text-zinc-500">所属部门</span>
                  <select
                    value={formDepartment}
                    onChange={(e) => setFormDepartment(e.target.value)}
                    className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                  >
                    {DEPARTMENTS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-zinc-500">金额（元，整数）</span>
                  <input
                    type="number"
                    value={formAmount}
                    onChange={(e) => setFormAmount(e.target.value)}
                    placeholder="如 68500"
                    className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                  />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-zinc-500">客户姓名（展示时自动脱敏）</span>
                  <input
                    value={formCustomer}
                    onChange={(e) => setFormCustomer(e.target.value)}
                    placeholder="虚构测试姓名"
                    className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                  />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-zinc-500">银行账号（展示时自动脱敏）</span>
                  <input
                    value={formBank}
                    onChange={(e) => setFormBank(e.target.value)}
                    placeholder="虚构测试账号（8~30 位数字）"
                    className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                  />
                </label>
                <label className="text-sm sm:col-span-2">
                  <span className="mb-1 block text-zinc-500">异常摘要</span>
                  <textarea
                    value={formSummary}
                    onChange={(e) => setFormSummary(e.target.value)}
                    rows={3}
                    placeholder="一句话说明异常情况（不超过 200 字）"
                    className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                  />
                </label>
              </div>
              {formError && (
                <p className="mt-3 text-sm text-red-700">{formError}</p>
              )}
              <div className="mt-4 flex gap-3">
                <button
                  onClick={() => void submitNewTicket()}
                  disabled={submitting}
                  className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 disabled:opacity-50"
                >
                  {submitting ? "提交中…" : "提交入库"}
                </button>
                <button
                  onClick={() => setShowForm(false)}
                  className="rounded-lg border border-zinc-300 px-4 py-2 text-sm text-zinc-600 hover:border-zinc-500"
                >
                  取消
                </button>
              </div>
              <p className="mt-3 text-xs leading-5 text-zinc-400">
                超过 ¥50,000 的财务部工单会自动触发 FIN-001 强制人工审批，不出现任何自动打款入口。
              </p>
            </div>
          )}
        </div>

        {/* ③ 工单卡片列表 + 详情抽屉（ENG-101） */}
        {loading && tickets.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-400">
            正在从数据库加载工单…
          </p>
        ) : (
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
                      className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${STATUS_STYLES[t.status] ?? ""}`}
                    >
                      {t.status}
                      {t.status === "已批准" && t.approvedAt && (
                        <span className="ml-1.5 font-normal tabular-nums">
                          · {new Date(t.approvedAt).toLocaleString("zh-CN", { hour12: false })}
                        </span>
                      )}
                    </span>

                    {/* 具名人工审批按钮（仅 FIN-001 单据出现；阻止冒泡避免误开抽屉） */}
                    {fin && t.status !== "已批准" && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void approve(t.id);
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
            {visible.length === 0 && !loading && (
              <p className="col-span-full rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-400">
                没有符合条件的工单，换个关键词或部门试试。
              </p>
            )}
          </div>
        )}

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
          全站不提供任何「AI 自动打款」能力，每笔大额放行均由具名审批人点击确认，
          审批记录写入数据库审计表（只增不改，数据库层物理禁止修改）。
        </footer>
      </main>
    </div>
  );
}
