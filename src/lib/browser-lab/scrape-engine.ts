/**
 * Day 14 · 抓取引擎：跨 3 页抓取老 ERP 仿真页的超期单据并结构化入库
 * 溯源：Day 2 红线「严禁直写业务系统正式数据」——本引擎对目标页面**只发 GET 请求**，
 *      物理上不存在 POST / PUT / DELETE 老 ERP 的代码路径；入库只写 WorkBot 自己的
 *      erp_scraped_invoices 副本表。
 * 实现：零第三方 HTML 解析依赖，用内置正则解析服务端渲染出的 table#invoice-table。
 */

import { sql } from "drizzle-orm";
import { ensureSchema, getDb } from "@/db";
import { erpScrapedInvoices } from "@/db/schema";
import type { BrowserLabEvent, LegacyErpInvoice } from "./types";

/** 事件回调节点（SSE 路由注入，引擎自身不感知传输层） */
export type EmitFn = (event: BrowserLabEvent) => void;

/** 步骤间的小停顿，让前端日志有「逐帧执行」的观感 */
const STEP_PACE_MS = 320;

export function pace(ms: number = STEP_PACE_MS): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 老 ERP 仿真页相对路径 */
export const SANDBOX_ERP_PATH = "/sandbox-legacy-erp";

/* ---------- HTML 解析（零依赖，正则白盒） ---------- */

/** 去掉标签与首尾空白，并还原最常见实体 */
function cellText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

interface ParsedTable {
  headers: string[];
  rows: string[][];
}

/** 从整页 HTML 中抽出 <table id="invoice-table"> 的表头与全部行 */
export function parseInvoiceTable(html: string): ParsedTable | null {
  const tableMatch = /<table[^>]*id="invoice-table"[\s\S]*?<\/table>/i.exec(html);
  if (!tableMatch) return null;
  const tableHtml = tableMatch[0];

  const headerCells = [...tableHtml.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => cellText(m[1]));
  if (headerCells.length === 0) return null;

  const rows: string[][] = [];
  const rowMatches = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  for (const rowMatch of rowMatches) {
    const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => cellText(m[1]));
    if (cells.length === headerCells.length) rows.push(cells);
  }
  return { headers: headerCells, rows };
}

/** 把一行单元格文本还原成结构化发票（解析失败返回 null，绝不硬凑） */
export function parseInvoiceRow(cells: string[], sourcePage: number): LegacyErpInvoice | null {
  if (cells.length < 5) return null;
  const [invoiceNo, supplier, amountText, dueDate, statusText] = cells;

  const amount = Number.parseInt(amountText.replace(/[,\s元]/g, ""), 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isInteger(amount)) return null;

  const overdueMatch = /\[超期\s*(\d+)\s*天\]/.exec(statusText);
  if (overdueMatch) {
    return {
      invoiceNo,
      supplier,
      amount,
      dueDate,
      daysOverdue: Number.parseInt(overdueMatch[1], 10),
      status: "超期",
      sourcePage,
    };
  }
  if (statusText.includes("已付清")) {
    return { invoiceNo, supplier, amount, dueDate, daysOverdue: 0, status: "已付清", sourcePage };
  }
  if (statusText.includes("未到期")) {
    return { invoiceNo, supplier, amount, dueDate, daysOverdue: 0, status: "未到期", sourcePage };
  }
  return null; // 未知状态宁缺毋滥，不硬凑入库
}

/* ---------- 抓取主流程 ---------- */

/**
 * 抓取单页（只读 GET）→ 返回该页解析出的发票；页面结构不符时返回 null。
 */
async function scrapeOnePage(
  baseUrl: string,
  page: number,
  emit: EmitFn,
): Promise<LegacyErpInvoice[] | null> {
  const url = `${baseUrl}${SANDBOX_ERP_PATH}?page=${page}`;
  emit({
    type: "step_start",
    step: `打开第 ${page} 页`,
    detail: `GET ${url}（只读请求，无任何写入口）`,
  });

  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "text/html" },
    // 明确声明：绕过任何缓存，抓取的就是服务端实时渲染的 HTML
    cache: "no-store",
  });
  if (!res.ok) {
    emit({ type: "log", level: "warn", text: `第 ${page} 页 HTTP ${res.status}，跳过该页（宁缺毋滥）` });
    return null;
  }
  const html = await res.text();
  const table = parseInvoiceTable(html);
  if (!table) {
    emit({ type: "log", level: "warn", text: `第 ${page} 页未找到 invoice-table 表格，页面结构可能已改版，停止解析` });
    return null;
  }

  const invoices: LegacyErpInvoice[] = [];
  for (const cells of table.rows) {
    const inv = parseInvoiceRow(cells, page);
    if (inv) invoices.push(inv);
  }

  const overdue = invoices.filter((i) => i.status === "超期");
  emit({ type: "snapshot", snapshot: { kind: "table", title: `供应商发票台账 · 第 ${page} 页`, url: `${SANDBOX_ERP_PATH}?page=${page}`, headers: table.headers, rows: table.rows, caption: `识别 ${table.rows.length} 行 × ${table.headers.length} 列，其中超期 ${overdue.length} 条` } });
  emit({ type: "scraped_page", page, found: invoices.length, overdue: overdue.length });
  emit({
    type: "log",
    level: "success",
    text: `第 ${page} 页解析成功：${invoices.length} 条记录，超期 ${overdue.length} 条（INV: ${overdue.map((i) => i.invoiceNo).join(", ") || "无"}）`,
  });
  return invoices;
}

export interface ScrapeOutcome {
  allInvoices: LegacyErpInvoice[];
  overdueInvoices: LegacyErpInvoice[];
  persistedCount: number;
}

/**
 * 抓取全部 3 页 → 结构化入库（WorkBot 副本表）。
 * 返回全部发票与超期发票；入库条数为实际写库条数。
 */
export async function scrapeAllPages(baseUrl: string, emit: EmitFn): Promise<ScrapeOutcome> {
  emit({ type: "log", level: "redline", text: "红线自查：本任务只发只读 GET，WorkBot 工具列表中不存在任何写老 ERP 的接口（Day 2 红线）" });

  const allInvoices: LegacyErpInvoice[] = [];
  for (let page = 1; page <= 3; page += 1) {
    const invoices = await scrapeOnePage(baseUrl, page, emit);
    if (invoices) allInvoices.push(...invoices);
    await pace();
  }

  const overdueInvoices = allInvoices
    .filter((i) => i.status === "超期")
    .sort((a, b) => b.daysOverdue - a.daysOverdue || b.amount - a.amount);

  // 结构化入库：只写 WorkBot 自己的副本表，同一发票号按最新快照覆盖
  emit({
    type: "step_start",
    step: "结构化入库",
    detail: `将 ${overdueInvoices.length} 条超期单据写入 WorkBot 副本表 erp_scraped_invoices（老 ERP 生产库零触碰）`,
  });
  await ensureSchema();
  const db = getDb();

  let persistedCount = 0;
  for (const inv of overdueInvoices) {
    await db
      .insert(erpScrapedInvoices)
      .values({
        invoiceNo: inv.invoiceNo,
        supplier: inv.supplier,
        amount: inv.amount,
        dueDate: inv.dueDate,
        daysOverdue: inv.daysOverdue,
        sourcePage: inv.sourcePage,
        scrapedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: erpScrapedInvoices.invoiceNo,
        set: {
          supplier: sql`excluded.supplier`,
          amount: sql`excluded.amount`,
          dueDate: sql`excluded.due_date`,
          daysOverdue: sql`excluded.days_overdue`,
          sourcePage: sql`excluded.source_page`,
          scrapedAt: sql`now()`,
        },
      });
    persistedCount += 1;
  }
  emit({
    type: "log",
    level: "success",
    text: `入库完成：erp_scraped_invoices 现有超期单据 ${persistedCount} 条（可在下方结果表核对）`,
  });

  return { allInvoices, overdueInvoices, persistedCount };
}
