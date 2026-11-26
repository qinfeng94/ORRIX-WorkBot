/**
 * /api/sandbox-legacy-erp/submit —— 老 ERP 仿真沙盒的「提交保存」落点
 * 边界（Day 2 / Day 14 红线）：
 * - 写入目标 = 进程内沙盒存储（globalThis Map，服务器重启即清空），物理上不存在
 *   连接老 ERP 生产库的代码路径；
 * - 只有浏览器自动化确认放行后的提交才允许带 source「浏览器自动化·人工放行」，
 *   普通表单提交一律按「人工录入」处理；
 * - 金额超 ¥50,000 时照常记录 FIN-001 标记（只是沙盒演示，不触发任何真实付款）。
 */

import { NextResponse } from "next/server";
import { FIN001_THRESHOLD_YUAN } from "@/lib/fin001";

/** 沙盒单条记录形态 */
interface SandboxEntry {
  receiptNo: string;
  supplier: string;
  invoiceNo: string;
  amount: number;
  dueDate: string;
  remark: string;
  source: string;
  isFin001: boolean;
  createdAt: string;
}

/** globalThis 挂载：dev 热重载与多路由间共享同一份沙盒内存 */
declare global {
  var __workbotErpSandbox: SandboxEntry[] | undefined;
}

function getStore(): SandboxEntry[] {
  if (!globalThis.__workbotErpSandbox) globalThis.__workbotErpSandbox = [];
  return globalThis.__workbotErpSandbox;
}

function makeReceiptNo(): string {
  const stamp = new Date()
    .toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })
    .replace(/\D/g, "")
    .slice(0, 14);
  const rand = Math.floor(Math.random() * 9000 + 1000);
  return `SBX-${stamp}-${rand}`;
}

/** POST body: { supplier, invoiceNo, amount, dueDate, remark?, source? } */
export async function POST(request: Request): Promise<Response> {
  const raw: unknown = await request.json().catch(() => null);
  if (!raw || typeof raw !== "object") {
    return NextResponse.json({ ok: false, error: "请求体必须是 JSON 对象" }, { status: 400 });
  }
  const body = raw as Record<string, unknown>;

  const supplier = String(body.supplier ?? "").trim();
  const invoiceNo = String(body.invoiceNo ?? "").trim();
  const amount = Number(body.amount);
  const dueDate = String(body.dueDate ?? "").trim();

  if (supplier.length === 0 || invoiceNo.length === 0) {
    return NextResponse.json({ ok: false, error: "供应商名称与发票号不能为空" }, { status: 400 });
  }
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
    return NextResponse.json({ ok: false, error: "金额必须为正整数（元）" }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    return NextResponse.json({ ok: false, error: "到期日格式必须为 YYYY-MM-DD" }, { status: 400 });
  }

  const source = String(body.source ?? "人工录入").trim();
  const entry: SandboxEntry = {
    receiptNo: makeReceiptNo(),
    supplier,
    invoiceNo,
    amount,
    dueDate,
    remark: String(body.remark ?? "").trim(),
    source,
    isFin001: amount > FIN001_THRESHOLD_YUAN,
    createdAt: new Date().toISOString(),
  };

  const store = getStore();
  store.push(entry);

  return NextResponse.json({
    ok: true,
    receiptNo: entry.receiptNo,
    sandboxTotal: store.length,
    isFin001: entry.isFin001,
  });
}

/** GET：沙盒台账查看（调试 / 前端展示用） */
export async function GET(): Promise<Response> {
  const store = getStore();
  return NextResponse.json({ ok: true, total: store.length, entries: store });
}
