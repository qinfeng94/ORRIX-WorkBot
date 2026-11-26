/**
 * 工单 DTO 与映射：数据库行 → 前端展示结构（全站唯一转换点）
 * PII 原始值仍随 DTO 下发（抽屉层脱敏展示）；审批时间统一转 ISO 字符串。
 */

import type { ApprovalAuditLogRow, IntakeRequestRow } from "@/db/schema";
import type { ApprovalEvent } from "@/app/components/ApprovalTimeline";

/** 前端工单结构（与 ENG-105 挂载层历史类型对齐） */
export interface TicketDTO {
  id: string;
  department: "财务部" | "运营部" | "客服部";
  amount: number;
  summary: string;
  status: string;
  approvedAt?: string;
  customerName: string;
  bankAccount: string;
  isFin001: boolean;
}

/** GET /api/tickets 的响应结构 */
export interface TicketsResponse {
  tickets: TicketDTO[];
  events: ApprovalEvent[];
}

export function toTicketDTO(row: IntakeRequestRow): TicketDTO {
  return {
    id: row.ticketNo,
    department: row.department as TicketDTO["department"],
    amount: row.amount,
    summary: row.summary,
    status: row.status,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : undefined,
    customerName: row.customerName,
    bankAccount: row.bankAccount,
    isFin001: row.isFin001,
  };
}

export function toApprovalEvent(row: ApprovalAuditLogRow): ApprovalEvent {
  return {
    id: `E-${row.id}`,
    approver: row.approver,
    timestamp: row.createdAt.toISOString(),
    action: row.action,
    isFin001: row.isFin001,
  };
}

/** 统一错误响应结构（needsSetup=true 时前端展示一键接入引导） */
export interface ApiError {
  error: string;
  needsSetup?: boolean;
}
