/**
 * /api/mcp/tasks/[taskId] —— MCP Tasks 单任务轮询端点（tasks/get + tasks/result 语义）
 * GET：返回 taskId 的实时进度；进度到 100% 才揭晓确定性结果（result 字段）。
 * 断电不丢：进度只由「开工时刻 + 总时长」推导，重启后照常续算。
 */

import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-error";
import { getMcpTaskProgress } from "@/lib/workflow/engine";

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  try {
    const { taskId } = await ctx.params;
    const task = await getMcpTaskProgress(taskId);
    if (!task) {
      return NextResponse.json(
        { error: `任务 ${taskId} 不存在（任务编号区分大小写，请从创建响应里复制）。` },
        { status: 404 },
      );
    }
    return NextResponse.json({
      task,
      status: task.status,
      progress: task.progress,
      result: task.result,
    });
  } catch (err: unknown) {
    return errorResponse(err);
  }
}
