/**
 * 工单读写 API：GET 列表（首次自动建表+种子）· POST 新建工单
 * 溯源：04 号文档绿区 G1~G4（只读快照与标记）+ 黄区 Y3/Y4（工单提交与 FIN-001 触发）。
 * 边界：本路由只操作 WorkBot 自己的两张表，严禁触碰老 ERP 正式数据（红区 R1）。
 * Day 27 多租户：
 *  - 部门分类 / 审批门槛 / 必填单据字段全部从租户配置文件（config/tenants/<tenantId>.json）
 *    动态读取，不再写死"星辰集团"；
 *  - 所有读写经租户隔离数据层 tenant-repo（强制 WHERE tenant_id），租户 A 绝不可能读到租户 B 的单据。
 */

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ensureSchema, getDb } from "@/db";
import { approvalAuditLogs } from "@/db/schema";
import { seedIfEmpty } from "@/db/seed";
import { badRequest, errorResponse } from "@/lib/api-error";
import { isLargeAmount } from "@/lib/fin001";
import {
  financeRulesOf,
  loadTenantConfig,
  TENANT_ID_PATTERN,
} from "@/lib/ontology/tenant-config";
import {
  getTicketForTenant,
  insertTicketForTenant,
  listTicketsForTenant,
} from "@/lib/ontology/tenant-repo";
import {
  toApprovalEvent,
  toTicketDTO,
  type TicketsResponse,
} from "@/lib/ticket-dto";

/** 解析并校验租户 ID（缺省 = 默认租户 xingchen；非法 ID fail-closed 返回 400） */
function resolveTenantId(raw: unknown): string | null {
  const tenantId = String(raw ?? "").trim() || "xingchen";
  return TENANT_ID_PATTERN.test(tenantId) ? tenantId : null;
}

/** 逐层剥开 cause 链判断是否 PG 唯一键冲突（23505） */
function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && typeof cur === "object" && cur !== null; depth += 1) {
    const rec = cur as { code?: unknown; cause?: unknown };
    if (rec.code === "23505") return true;
    cur = rec.cause;
  }
  return false;
}

/** GET /api/tickets?tenantId= —— 指定租户的工单 + 审计事件（审计只读，永无修改入口） */
export async function GET(request: Request): Promise<Response> {
  try {
    const tenantId = resolveTenantId(
      new URL(request.url).searchParams.get("tenantId"),
    );
    if (tenantId === null) {
      return badRequest("租户 ID 非法。");
    }

    await ensureSchema();
    await seedIfEmpty(getDb());

    // 租户隔离读写入口：强制 WHERE tenant_id（其他租户的单据在本层不可达）
    const ticketRows = await listTicketsForTenant(tenantId);
    const eventRows = await getDb()
      .select()
      .from(approvalAuditLogs)
      .where(eq(approvalAuditLogs.tenantId, tenantId))
      .orderBy(approvalAuditLogs.id);

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

    const tenantId = resolveTenantId(body.tenantId);
    if (tenantId === null) {
      return badRequest("租户 ID 非法。");
    }
    // 审批门槛 / 部门分类 / 单据字段定义：全部来自租户配置文件（动态读取，不写死）
    const tenantCfg = await loadTenantConfig(tenantId);
    const requiredFields = tenantCfg.documentFields
      .filter((f) => f.required)
      .map((f) => f.key);
    const fieldLabel = (key: string): string =>
      tenantCfg.documentFields.find((f) => f.key === key)?.label ?? key;

    const department = String(body.department ?? "").trim();
    if (!tenantCfg.departments.includes(department)) {
      return badRequest(`部门只能是：${tenantCfg.departments.join("、")}。`);
    }

    const amount = Number(body.amount);
    if (!Number.isInteger(amount) || amount <= 0 || amount > 100_000_000) {
      return badRequest("金额必须是大于 0 的整数（单位：元）。");
    }

    const summary = String(body.summary ?? "").trim();
    if (requiredFields.includes("summary") && (summary.length === 0 || summary.length > 200)) {
      return badRequest(`${fieldLabel("summary")}必填，且不超过 200 字。`);
    }

    const customerName = String(body.customerName ?? "").trim();
    if (
      requiredFields.includes("customerName") &&
      (customerName.length === 0 || customerName.length > 20)
    ) {
      return badRequest(
        `${fieldLabel("customerName")}必填，且不超过 20 字（展示层会自动脱敏）。`,
      );
    }

    const bankAccount = String(body.bankAccount ?? "").trim();
    if (requiredFields.includes("bankAccount") && !/^\d{8,30}$/.test(bankAccount)) {
      return badRequest(`${fieldLabel("bankAccount")}必须是 8~30 位数字。`);
    }

    await ensureSchema();

    // 服务端单点判定 FIN-001（判定函数唯一真源 = fin001.ts；门槛来自租户配置）
    const fin001 = isLargeAmount(
      { department, amount },
      financeRulesOf(tenantCfg),
    );

    // 工单编号生成：取本租户现有最大序号 +1（T-2026-1106 → T-2026-1107）；
    // ticket_no 全局唯一，跨租户撞号时换下一个序号重试（最多 50 次）
    const existingNos = await listTicketsForTenant(tenantId);
    const maxSeq = existingNos.reduce((max, row) => {
      const seq = Number.parseInt(row.ticketNo.split("-")[2] ?? "0", 10);
      return Number.isNaN(seq) ? max : Math.max(max, seq);
    }, 0);
    let insertedTicketNo: string | null = null;
    for (let i = 0; i < 50 && insertedTicketNo === null; i += 1) {
      const ticketNo = `T-2026-${String(maxSeq + 1 + i).padStart(4, "0")}`;
      try {
        const row = await insertTicketForTenant(tenantId, {
          ticketNo,
          department,
          amount,
          summary,
          status: `待${tenantCfg.namedApprovers[0]}审批`,
          customerName,
          bankAccount,
          isFin001: fin001,
        });
        insertedTicketNo = row.ticketNo;
      } catch (insertErr: unknown) {
        // 只有唯一键冲突（PG 23505，可能嵌在 cause 链里）才换号重试；其余错误直接抛出
        if (!isUniqueViolation(insertErr)) throw insertErr;
      }
    }
    if (insertedTicketNo === null) {
      return NextResponse.json(
        { error: "工单编号生成冲突，请稍后重试。" },
        { status: 500 },
      );
    }

    const row = await getTicketForTenant(tenantId, insertedTicketNo);
    if (!row) {
      return NextResponse.json(
        { error: "工单已创建但回读失败，请刷新列表。" },
        { status: 500 },
      );
    }

    return NextResponse.json({ ticket: toTicketDTO(row) }, { status: 201 });
  } catch (err: unknown) {
    return errorResponse(err);
  }
}
