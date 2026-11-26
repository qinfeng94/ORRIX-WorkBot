/**
 * 工单读写 API：GET 列表（首次自动建表+种子）· POST 新建工单
 * 溯源：04 号文档绿区 G1~G4（只读快照与标记）+ 黄区 Y3/Y4（工单提交与 FIN-001 触发）。
 * 边界：本路由只操作 WorkBot 自己的两张表，严禁触碰老 ERP 正式数据（红区 R1）。
 */

import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ensureSchema, getDb } from "@/db";
import { intakeRequests, approvalAuditLogs } from "@/db/schema";
import { seedIfEmpty } from "@/db/seed";
import { badRequest, errorResponse } from "@/lib/api-error";
import { isLargeAmount } from "@/lib/fin001";
import {
  toApprovalEvent,
  toTicketDTO,
  type TicketsResponse,
} from "@/lib/ticket-dto";

const DEPARTMENTS = ["财务部", "运营部", "客服部"] as const;

/** GET /api/tickets —— 全量工单 + 审计事件（审计只读，永无修改入口） */
export async function GET(): Promise<Response> {
  try {
    await ensureSchema();
    const db = getDb();
    await seedIfEmpty(db);

    const ticketRows = await db
      .select()
      .from(intakeRequests)
      .orderBy(sql`created_at asc, id asc`);
    const eventRows = await db
      .select()
      .from(approvalAuditLogs)
      .orderBy(sql`id asc`);

    const body: TicketsResponse = {
      tickets: ticketRows.map(toTicketDTO),
      events: eventRows.map(toApprovalEvent),
    };
    return NextResponse.json(body);
  } catch (err: unknown) {
    return errorResponse(err);
  }
}

/** POST /api/tickets —— 新建工单（黄区 Y3：人工提交，非 AI 代填） */
export async function POST(request: Request): Promise<Response> {
  try {
    const raw: unknown = await request.json();
    const body = raw as Record<string, unknown>;

    const department = String(body.department ?? "").trim();
    if (!(DEPARTMENTS as readonly string[]).includes(department)) {
      return badRequest("部门只能是：财务部、运营部、客服部。");
    }

    const amount = Number(body.amount);
    if (!Number.isInteger(amount) || amount <= 0 || amount > 100_000_000) {
      return badRequest("金额必须是大于 0 的整数（单位：元）。");
    }

    const summary = String(body.summary ?? "").trim();
    if (summary.length === 0 || summary.length > 200) {
      return badRequest("异常摘要必填，且不超过 200 字。");
    }

    const customerName = String(body.customerName ?? "").trim();
    if (customerName.length === 0 || customerName.length > 20) {
      return badRequest("客户姓名必填（展示层会自动脱敏）。");
    }

    const bankAccount = String(body.bankAccount ?? "").trim();
    if (!/^\d{8,30}$/.test(bankAccount)) {
      return badRequest("银行账号必须是 8~30 位数字。");
    }

    await ensureSchema();
    const db = getDb();

    // 服务端单点判定 FIN-001（与前端共用 isLargeAmount，阈值唯一）
    const fin001 = isLargeAmount({ department, amount });

    // 工单编号生成：取现有最大序号 +1（T-2026-1106 → T-2026-1107）；冲突最多重试 5 次
    const existingNos = await db
      .select({ ticketNo: intakeRequests.ticketNo })
      .from(intakeRequests);
    const maxSeq = existingNos.reduce((max, row) => {
      const seq = Number.parseInt(row.ticketNo.split("-")[2] ?? "0", 10);
      return Number.isNaN(seq) ? max : Math.max(max, seq);
    }, 0);
    let inserted: { ticketNo: string } | null = null;
    for (let i = 0; i < 5 && inserted === null; i += 1) {
      const ticketNo = `T-2026-${String(maxSeq + 1 + i).padStart(4, "0")}`;
      const rows = await db
        .insert(intakeRequests)
        .values({
          ticketNo,
          department,
          amount,
          summary,
          status: "待林总审批",
          customerName,
          bankAccount,
          isFin001: fin001,
        })
        .onConflictDoNothing()
        .returning({ ticketNo: intakeRequests.ticketNo });
      if (rows.length > 0) inserted = rows[0];
    }
    if (inserted === null) {
      return NextResponse.json(
        { error: "工单编号生成冲突，请稍后重试。" },
        { status: 500 },
      );
    }

    const [row] = await db
      .select()
      .from(intakeRequests)
      .where(sql`ticket_no = ${inserted.ticketNo}`);

    return NextResponse.json({ ticket: toTicketDTO(row) }, { status: 201 });
  } catch (err: unknown) {
    return errorResponse(err);
  }
}
