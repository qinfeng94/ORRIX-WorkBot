/**
 * /sandbox-legacy-erp —— Day 14 内嵌仿真页：星辰供应链 ERP 2009 SP3（复古 CRT 风格）
 * 定位：模拟集团那套 15 年无 API 老 ERP 的界面，供 /browser-lab 的受控浏览器自动化
 *      通过 HTTP 真实抓取本页 HTML（跨 3 页发票表格）与预填手工录入表单。
 * 红线：本页只是**仿真沙盒**，页脚常驻提示——自动化永远不触碰真正的老 ERP 生产库；
 *      表单提交写入的是进程内沙盒存储（服务器重启即清空），不是任何生产数据库。
 */

import Link from "next/link";
import EntryForm from "./EntryForm";
import { getInvoicePage, LEGACY_ERP_TOTAL_PAGES } from "@/lib/browser-lab/legacy-erp-data";
import type { LegacyErpInvoice } from "@/lib/browser-lab/types";

/** Next 16：searchParams 为 Promise，必须 await */
interface PageProps {
  searchParams: Promise<{ page?: string }>;
}

function parsePage(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "1", 10);
  if (!Number.isInteger(n) || n < 1 || n > LEGACY_ERP_TOTAL_PAGES) return 1;
  return n;
}

/** 状态徽章（复古终端配色） */
function statusBadge(inv: LegacyErpInvoice): string {
  if (inv.status === "超期") return `[超期 ${inv.daysOverdue} 天]`;
  if (inv.status === "已付清") return "[已付清]";
  return "[未到期]";
}

export default async function SandboxLegacyErpPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const page = parsePage(params.page);
  const invoices = getInvoicePage(page);
  const overdueCount = invoices.filter((i) => i.status === "超期").length;

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      {/* ===== 红线说明横幅（真实页面顶部，避免与仿真混淆） ===== */}
      <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs leading-relaxed text-amber-800">
        <strong>仿真沙盒说明：</strong>
        本页是 WorkBot 内嵌的「老 ERP 仿真页」（虚构数据），用于 Day 14 浏览器自动化演示。
        页面外观刻意仿古，但它的所有写入都只落在进程内沙盒存储，<strong>不是</strong>真正的老 ERP 生产库。
        受控自动化入口在{" "}
        <Link href="/browser-lab" className="font-semibold underline">
          /browser-lab
        </Link>
        。
      </div>

      {/* ===== 复古 CRT 窗口 ===== */}
      <div className="overflow-hidden rounded-lg border-4 border-double border-emerald-700 bg-[#04140a] font-mono text-emerald-400 shadow-[0_0_24px_rgba(16,185,129,0.25)]">
        {/* 窗口标题栏 */}
        <div className="flex items-center justify-between border-b border-emerald-800 bg-[#0a2413] px-4 py-2 text-xs text-emerald-300">
          <span>星辰供应链 ERP 2009 SP3 · 供应商应付管理 [单机版]</span>
          <span className="text-emerald-600">操作员：CAISHUI-07</span>
        </div>

        <div
          className="px-5 py-4"
          style={{
            backgroundImage:
              "repeating-linear-gradient(to bottom, transparent 0px, transparent 2px, rgba(0,0,0,0.18) 3px)",
          }}
        >
          {/* 系统菜单条（装饰） */}
          <div className="mb-3 flex gap-4 text-[11px] text-emerald-600">
            <span className="text-emerald-300">系统(S)</span>
            <span>凭证(F)</span>
            <span className="text-emerald-300">应付(Y)</span>
            <span>报表(R)</span>
            <span>帮助(H)</span>
          </div>

          <h1 className="mb-1 text-sm font-bold text-emerald-200">
            供应商发票台账 —— 第 {page}/{LEGACY_ERP_TOTAL_PAGES} 页
          </h1>
          <p className="mb-3 text-[11px] text-emerald-600">
            共 {LEGACY_ERP_TOTAL_PAGES * 8} 条记录 · 本页 {overdueCount} 条超期 · 数据最后刷新于服务器渲染时刻
          </p>

          {/* 发票表格（抓取目标：table#invoice-table） */}
          <table id="invoice-table" className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-y border-emerald-700 text-emerald-300">
                <th className="px-2 py-1.5 text-left font-bold">发票号</th>
                <th className="px-2 py-1.5 text-left font-bold">供应商</th>
                <th className="px-2 py-1.5 text-right font-bold">金额(元)</th>
                <th className="px-2 py-1.5 text-left font-bold">到期日</th>
                <th className="px-2 py-1.5 text-left font-bold">状态</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr
                  key={inv.invoiceNo}
                  className={`border-b border-emerald-900 ${
                    inv.status === "超期" ? "bg-[#1c1503] text-amber-300" : ""
                  }`}
                >
                  <td className="px-2 py-1.5">{inv.invoiceNo}</td>
                  <td className="px-2 py-1.5">{inv.supplier}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {inv.amount.toLocaleString("zh-CN")}
                  </td>
                  <td className="px-2 py-1.5">{inv.dueDate}</td>
                  <td className={`px-2 py-1.5 ${inv.status === "超期" ? "text-amber-300" : "text-emerald-500"}`}>
                    {statusBadge(inv)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* 分页条 */}
          <div className="mt-3 flex items-center justify-between text-xs text-emerald-500">
            <span>
              {page > 1 ? (
                <Link
                  href={`/sandbox-legacy-erp?page=${page - 1}`}
                  className="rounded border border-emerald-700 px-2 py-1 text-emerald-300 hover:bg-emerald-900"
                >
                  &lt; 上一页
                </Link>
              ) : (
                <span className="rounded border border-emerald-900 px-2 py-1 text-emerald-800">&lt; 上一页</span>
              )}
            </span>
            <span className="flex gap-2">
              {Array.from({ length: LEGACY_ERP_TOTAL_PAGES }, (_, i) => i + 1).map((p) => (
                <Link
                  key={p}
                  href={`/sandbox-legacy-erp?page=${p}`}
                  className={`rounded border px-2.5 py-1 ${
                    p === page
                      ? "border-emerald-400 bg-emerald-800 text-emerald-100"
                      : "border-emerald-800 text-emerald-500 hover:bg-emerald-900"
                  }`}
                >
                  {p}
                </Link>
              ))}
            </span>
            <span>
              {page < LEGACY_ERP_TOTAL_PAGES ? (
                <Link
                  href={`/sandbox-legacy-erp?page=${page + 1}`}
                  className="rounded border border-emerald-700 px-2 py-1 text-emerald-300 hover:bg-emerald-900"
                >
                  下一页 &gt;
                </Link>
              ) : (
                <span className="rounded border border-emerald-900 px-2 py-1 text-emerald-800">下一页 &gt;</span>
              )}
            </span>
          </div>

          {/* 手工录入表单（老 ERP 传统做法：财务人工逐笔录入） */}
          <div id="entry-form" className="mt-6 border-t border-emerald-800 pt-4">
            <h2 className="mb-1 text-sm font-bold text-emerald-200">付款单手工录入 [F8 录入模式]</h2>
            <p className="mb-3 text-[11px] text-emerald-600">
              传统流程：财务同事在本表单逐笔手工录入 → 点【提交保存】写台账。
              自动化预填演练请走 <span className="text-emerald-300">/browser-lab</span>（提交前强制暂停等人工确认）。
            </p>
            <EntryForm />
          </div>

          {/* 页脚常驻红线提示 */}
          <p className="mt-6 border-t border-emerald-800 pt-3 text-[10px] leading-relaxed text-emerald-700">
            [仿真沙盒] 本系统为 WorkBot 内嵌演示环境，写入仅存于进程内存，重启即清空；
            自动化一律不连接真正的老 ERP 生产库（Day 2 红线：只读快照，物理无写入口）。
          </p>
        </div>
      </div>
    </main>
  );
}
