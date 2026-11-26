/**
 * 审批放行 API：具名人工审批落库 + 审计日志追加（事务内原子完成）
 * 溯源：FIN-001（单笔超 ¥50,000 必须具名审批人签字）；04 号文档 CISO 条款 3（具名审批人）、
 *      条款 4（审计只增不改）、红区 R2（AI 不得代替任何人签字）。
 * 边界：本接口只改工单状态与追加日志；不产生任何付款动作（红区：严禁自动打款）。
 */

import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ensureSchema, getDb } from "@/db";
import { approvalAuditLogs, intakeRequests } from "@/db/schema";
import { errorResponse } from "@/lib/api-error";
import { isLargeAmount, isValidNamedApprover } from "@/lib/fin001";
import { toApprovalEvent, toTicketDTO } from "@/lib/ticket-dto";

/** POST /api/tickets/approve —— body: { ticketNo, approver } */
export async function POST(request: Request): Promise<Response> {
  try {
    const raw: unknown = await request.json();
    const body = raw as Record<string, unknown>;

    const ticketNo = String(body.ticketNo ?? "").trim();
    if (ticketNo.length === 0) {
      return NextResponse.json({ error: "缺少工单编号。" }, { status: 400 });
    }

    const approver = String(body.approver ?? "").trim();
    if (!isValidNamedApprover(approver)) {
      // CISO 条款 3：AI / 匿名 / 部门 / 值班身份一律无效
      return NextResponse.json(
        {
          error:
            "审批人必须是具名在职员工（禁止 AI、匿名、部门、值班等模糊身份）。FIN-001 单据必须由具名审批人签字放行。",
        },
        { status: 403 },
      );
    }

    await ensureSchema();
    const db = getDb();

    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(intakeRequests)
        .where(sql`ticket_no = ${ticketNo}`)
        .for("update");

      if (!row) {
        return { notFound: true as const };
      }
      if (row.status === "已批准") {
        // 幂等保护：已批准的单据不允许重复放行
        return { alreadyApproved: true as const };
      }

      // 服务端再校验一次 FIN-001（防前端数据被篡改绕过门禁；阈值单点唯一）
      const fin001 = isLargeAmount(row);

      const approvedAt = new Date();
      await tx
        .update(intakeRequests)
        .set({ status: "已批准", approvedAt })
        .where(sql`id = ${row.id}`);

      const [logRow] = await tx
        .insert(approvalAuditLogs)
        .values({
          ticketNo: row.ticketNo,
          approver,
          action: `放行工单 ${row.ticketNo}（¥${row.amount.toLocaleString("zh-CN")}）：具名审批通过。`,
          isFin001: fin001,
        })
        .returning();

      return { ticketRow: { ...row, status: "已批准", approvedAt }, logRow };
    });

    if ("notFound" in result) {
      return NextResponse.json(
        { error: `工单 ${ticketNo} 不存在。` },
        { status: 404 },
      );
    }
    if ("alreadyApproved" in result) {
      return NextResponse.json(
        { error: `工单 ${ticketNo} 已批准，不能重复放行。` },
        { status: 409 },
      );
    }

    return NextResponse.json({
      ticket: toTicketDTO(result.ticketRow),
      event: toApprovalEvent(result.logRow),
    });
  } catch (err: unknown) {
    return errorResponse(err);
  }
}
