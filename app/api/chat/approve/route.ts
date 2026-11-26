/**
 * /api/chat/approve —— Dry-Run 草稿的具名人工批准接口（POST）
 * 溯源：04 号文档 CISO 条款 3（具名审批人，AI/匿名/部门/值班一律无效）、
 *      条款 4（approval_audit_logs 只增不改）、红区 R2（AI 不得代替任何人签字）。
 * 行为：
 * - 校验具名审批人 → 幂等保护（同一审批单号只能批准一次）→
 *   事务内真实写入 approval_audit_logs → 响应后用 after() 上报 PostHog 事件；
 * - 本接口不执行任何打款/付款动作（红区物理剔除，批准只代表「草稿转正式」的人工确认）。
 */

import { after } from "next/server";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ensureSchema, getDb } from "@/db";
import { approvalAuditLogs } from "@/db/schema";
import { errorResponse } from "@/lib/api-error";
import { isValidNamedApprover } from "@/lib/fin001";
import { captureServerEvent, SERVER_EVENTS } from "@/lib/posthog-server";
import { isKillSwitchOn, KILL_SWITCH_ENV_VAR } from "@/lib/security/kill-switch";

// 注：next.config.ts 开启 cacheComponents，路由段不可声明 runtime（默认即 Node.js）。

/** POST body: { approvalId, tool, summary, approver, sessionId } */
export async function POST(request: Request): Promise<Response> {
  try {
    // Day 30 物理急停总电闸：开启时审批落账一并锁死（急停优先于一切校验，fail-closed）
    if (isKillSwitchOn()) {
      return NextResponse.json(
        {
          error: `物理急停总电闸已开启：审批通道已锁死，请由运维在服务端环境变量 ${KILL_SWITCH_ENV_VAR} 解除后再试。`,
        },
        { status: 503 },
      );
    }

    const raw: unknown = await request.json();
    const body = raw as Record<string, unknown>;

    const approvalId = String(body.approvalId ?? "").trim();
    if (approvalId.length === 0) {
      return NextResponse.json({ error: "缺少审批单号。" }, { status: 400 });
    }

    const tool = String(body.tool ?? "").trim();
    if (tool.length === 0) {
      return NextResponse.json({ error: "缺少工具名。" }, { status: 400 });
    }

    const summary = String(body.summary ?? "").trim();
    if (summary.length === 0) {
      return NextResponse.json({ error: "缺少草稿摘要。" }, { status: 400 });
    }

    const approver = String(body.approver ?? "").trim();
    if (!isValidNamedApprover(approver)) {
      // CISO 条款 3：AI / 匿名 / 部门 / 值班身份一律无效
      return NextResponse.json(
        {
          error:
            "审批人必须是具名在职员工（禁止 AI、匿名、部门、值班等模糊身份）。",
        },
        { status: 403 },
      );
    }

    const sessionId = String(body.sessionId ?? "").slice(0, 64);

    await ensureSchema();
    const db = getDb();

    const result = await db.transaction(async (tx) => {
      // 幂等保护：同一审批单号只允许批准一次（approval_audit_logs 只增不改，无法回滚撤销）
      const [existing] = await tx
        .select()
        .from(approvalAuditLogs)
        .where(sql`ticket_no = ${approvalId}`)
        .for("update");

      if (existing) {
        return { alreadyApproved: true as const, approvedAt: existing.createdAt };
      }

      // FIN-001 标记：审批预演草稿类批准涉及大额标记，审计里单独留痕
      const isFin001 = tool === "prepare_human_approval_draft";

      const [logRow] = await tx
        .insert(approvalAuditLogs)
        .values({
          ticketNo: approvalId,
          approver,
          action: `批准执行 Dry-Run 草稿（${tool}）：${summary}`,
          isFin001,
        })
        .returning();

      return {
        alreadyApproved: false as const,
        approvedAt: logRow.createdAt,
        logId: logRow.id,
      };
    });

    if (result.alreadyApproved) {
      return NextResponse.json(
        {
          error: `审批单 ${approvalId} 已批准，不能重复放行。`,
          approvedAt: result.approvedAt,
        },
        { status: 409 },
      );
    }

    // PostHog 埋点放响应后执行（不阻塞批准动作本身；无 Key 时静默跳过）
    after(async () => {
      await captureServerEvent(SERVER_EVENTS.dryRunApproved, sessionId || "anonymous-session", {
        approvalId,
        tool,
        approverNameLength: approver.length, // 不上报姓名本身，避免 PII
        isFin001: tool === "prepare_human_approval_draft",
      });
    });

    return NextResponse.json({
      ok: true,
      logId: result.logId,
      approvedAt: result.approvedAt,
      approver,
    });
  } catch (err: unknown) {
    return errorResponse(err);
  }
}
