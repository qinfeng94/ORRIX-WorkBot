/**
 * /api/mcp/tasks —— MCP Tasks 异步长任务演示（MCP 2025-11-25 规范的 tasks/* 语义）
 * POST（tasks/create）：创建长任务，立即返回 taskId（不阻塞、不等待完成）
 * GET （tasks/list）  ：最近任务清单（含实时进度，供页面初次渲染与轮询兜底）
 * 进度原理：progress = (now - started_at) / total_ms，是时间的确定性函数，
 * 没有后台定时器、没有进程内状态——服务器断电重启后按同一公式照常续算。
 */

import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-error";
import { createMcpTask, listMcpTaskProgress } from "@/lib/workflow/engine";

export async function GET(): Promise<Response> {
  try {
    const tasks = await listMcpTaskProgress();
    return NextResponse.json({ tasks });
  } catch (err: unknown) {
    return errorResponse(err);
  }
}

export async function POST(): Promise<Response> {
  try {
    const task = await createMcpTask();
    return NextResponse.json(
      {
        task,
        // MCP Tasks 客户端的轮询指引：状态端点 + 建议间隔
        poll: {
          statusUrl: `/api/mcp/tasks/${task.taskId}`,
          intervalMs: 1000,
        },
      },
      { status: 202 }, // 202 Accepted：任务已受理，尚未完成
    );
  } catch (err: unknown) {
    return errorResponse(err);
  }
}
