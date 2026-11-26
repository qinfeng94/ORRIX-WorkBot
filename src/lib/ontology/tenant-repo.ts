/**
 * 租户隔离数据访问层（Day 27 多租户逻辑隔离 · 工单类单据唯一读写入口）
 * 溯源：Day 27 任务——租户 A 的任何查询请求绝不可能读到租户 B 的单据；
 *      04 号文档绿区 G1~G4（只读快照）+ 黄区 Y3/Y4（工单提交）。
 * 设计：
 *  - 本层每个查询都强制 WHERE tenant_id = :tenantId——调用方拿不到"不带租户条件"的查询入口；
 *  - tenantId 入口先过白名单正则（防路径穿越 / 防注入第一道闸），fail-closed；
 *  - 现有单租户调用方（默认 xingchen）行为不变：存量行由 DDL DEFAULT 'xingchen' 回填。
 */

import { and, asc, eq } from "drizzle-orm";
import { ensureSchema, getDb } from "@/db";
import { intakeRequests, type IntakeRequestRow } from "@/db/schema";
import { TENANT_ID_PATTERN } from "./tenant-config";

/** 工单新建入参（黄区 Y3：人工提交，非 AI 代填） */
export interface TenantTicketInput {
  /** 工单编号（业务主键，全局唯一，由调用方生成） */
  ticketNo: string;
  department: string;
  amount: number;
  summary: string;
  customerName: string;
  bankAccount: string;
  status?: string;
  isFin001?: boolean;
}

/** 租户 ID 入口校验（fail-closed；与租户配置层同一白名单正则） */
function assertTenantId(tenantId: string): void {
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new Error(`租户 ID 非法，拒绝查询：${tenantId}`);
  }
}

/** 列出指定租户的全部工单（强制 tenant_id 过滤，任何其他租户的单据在本层不可达） */
export async function listTicketsForTenant(tenantId: string): Promise<IntakeRequestRow[]> {
  assertTenantId(tenantId);
  await ensureSchema();
  return getDb()
    .select()
    .from(intakeRequests)
    .where(eq(intakeRequests.tenantId, tenantId))
    .orderBy(asc(intakeRequests.createdAt), asc(intakeRequests.id));
}

/** 按工单编号读取指定租户的单据；跨租户编号一律返回 undefined（查无此单） */
export async function getTicketForTenant(
  tenantId: string,
  ticketNo: string,
): Promise<IntakeRequestRow | undefined> {
  assertTenantId(tenantId);
  await ensureSchema();
  const rows = await getDb()
    .select()
    .from(intakeRequests)
    .where(
      and(eq(intakeRequests.tenantId, tenantId), eq(intakeRequests.ticketNo, ticketNo)),
    )
    .limit(1);
  return rows[0];
}

/** 为指定租户新建工单（tenant_id 由本层写入，调用方无法篡改归属） */
export async function insertTicketForTenant(
  tenantId: string,
  input: TenantTicketInput,
): Promise<IntakeRequestRow> {
  assertTenantId(tenantId);
  await ensureSchema();
  const [row] = await getDb()
    .insert(intakeRequests)
    .values({
      tenantId,
      ticketNo: input.ticketNo,
      department: input.department,
      amount: input.amount,
      summary: input.summary,
      status: input.status ?? "待林总审批",
      customerName: input.customerName,
      bankAccount: input.bankAccount,
      isFin001: input.isFin001 ?? false,
    })
    .returning();
  return row;
}
