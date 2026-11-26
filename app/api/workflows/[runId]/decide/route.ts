/**
 * /api/workflows/[runId]/decide —— 挂起审批流的具名人工决定（批准 / 退回）
 * 溯源：04 号文档 CISO 条款 3（具名审批人）；FIN-001（大额必须人工放行）；
 *      AGENTS.md 红区（批准只代表人工确认，绝不触发任何打款动作）。
 * 幂等：同一 runId 重复批准返回 409（审计日志只增不改，不可能二次放行）。
 * 跨重启：postgres 引擎的挂起态只存 Postgres——服务器重启后本接口照样能从库里
 *         原样恢复推进；inngest 引擎则投递决定事件唤醒 waitForEvent。
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { errorResponse } from "@/lib/api-error";
import { isValidNamedApprover } from "@/lib/fin001";
import {
  completeRun,
  getRunView,
  rejectRun,
} from "@/lib/workflow/engine";
import { ensureSchema, getDb } from "@/db";
import { workflowRuns } from "@/db/schema";
import {
  sendInngestEvent,
  WORKFLOW_DECIDED_EVENT,
} from "@/lib/workflow/inngest";

/** POST body: { action: "approve" | "reject", approver } */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ runId: string }> },
): Promise<Response> {
  try {
    const { runId } = await ctx.params;
    const raw: unknown = await request.json();
    const body = raw as Record<string, unknown>;

    const action = body.action === "reject" ? "reject" : body.action === "approve" ? "approve" : null;
    if (!action) {
      return NextResponse.json(
        { error: "action 必须是 approve（批准）或 reject（退回）。" },
        { status: 400 },
      );
    }

    const approver = String(body.approver ?? "").trim();
    if (!isValidNamedApprover(approver)) {
      // CISO 条款 3：AI / 匿名 / 部门 / 值班身份一律无效
      return NextResponse.json(
        { error: "审批人必须是具名在职员工（禁止 AI、匿名、部门、值班等模糊身份）。" },
        { status: 403 },
      );
    }

    await ensureSchema();
    const db = getDb();
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, runId));
    if (!run) {
      return NextResponse.json({ error: `审批流 ${runId} 不存在。` }, { status: 404 });
    }

    let notice: string | null = null;
    if (run.engine === "inngest") {
      try {
        await sendInngestEvent(WORKFLOW_DECIDED_EVENT, { runId, action, approver });
      } catch (inngestErr: unknown) {
        // Dev Server 半路掉线：降级为本地状态机直接恢复（行为同构，演示不中断）
        notice = `Inngest Dev Server 未响应（${
          inngestErr instanceof Error ? inngestErr.message : "连接失败"
        }），本次决定已由本地 Postgres 状态机直接恢复推进。`;
        if (action === "approve") {
          const result = await completeRun(runId, approver);
          if (result.alreadyCompleted) {
            return NextResponse.json(
              { error: `审批流 ${runId} 已批准（凭据 ${result.auditCredential}），不能重复放行。` },
              { status: 409 },
            );
          }
        } else {
          await rejectRun(runId, approver);
        }
      }
    } else {
      if (action === "approve") {
        const result = await completeRun(runId, approver);
        if (result.alreadyCompleted) {
          return NextResponse.json(
            { error: `审批流 ${runId} 已批准（凭据 ${result.auditCredential}），不能重复放行。` },
            { status: 409 },
          );
        }
      } else {
        await rejectRun(runId, approver);
      }
    }

    // 状态冲突（已退回 / 已过期 / 算术拦截 / 重复决定）已在上方以 409 返回；
    // inngest 引擎成功投递事件时由 Dev Server 异步推进，这里回读当前快照即可。
    const view = await getRunView(runId);
    if (!view) {
      return NextResponse.json({ error: `审批流 ${runId} 不存在。` }, { status: 404 });
    }

    return NextResponse.json({ ok: true, run: view, notice });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("不在等待审批") || message.includes("不存在")) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    return errorResponse(err);
  }
}
