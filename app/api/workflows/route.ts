/**
 * /api/workflows —— Day 18 跨重启持久化审批流
 * GET  ：最近运行列表（含三步状态灯、事件流水、跨重启证明），读取时惰性清算 7 天过期挂起
 * POST ：创建审批流。engine=inngest 时尝试走真实 Inngest Dev Server；
 *        Dev Server 未启动则自动降级为等价演练模式（Postgres 状态机），并在响应里说明。
 * 红线：FIN-001 只对「财务部 + 超过 ¥50,000」亮大额徽章；全流程零打款动作。
 */

import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-error";
import {
  createRunPostgres,
  createRunQueued,
  listRunViews,
  validateCreateInput,
} from "@/lib/workflow/engine";
import { sendInngestEvent, WORKFLOW_REQUESTED_EVENT } from "@/lib/workflow/inngest";

// 注：next.config.ts 开启 cacheComponents，路由段不可声明 runtime（默认即 Node.js）。

export async function GET(): Promise<Response> {
  try {
    const runs = await listRunViews();
    return NextResponse.json({ runs });
  } catch (err: unknown) {
    return errorResponse(err);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const raw: unknown = await request.json();
    const body = raw as Record<string, unknown>;

    const validated = validateCreateInput(body);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: 400 });
    }

    // 请求指定 Inngest 引擎时先尝试真实投递；Dev Server 未启动则降级到等价演练模式
    if (body.engine === "inngest") {
      try {
        const queued = await createRunQueued(validated.input, "inngest");
        await sendInngestEvent(WORKFLOW_REQUESTED_EVENT, {
          runId: queued.runId,
          ...validated.input,
        });
        return NextResponse.json({
          run: { runId: queued.runId, engine: "inngest" },
          engine: "inngest",
          notice: null,
        });
      } catch (inngestErr: unknown) {
        const fallbackRun = await createRunPostgres(validated.input);
        return NextResponse.json({
          run: { runId: fallbackRun.runId, engine: "postgres" },
          engine: "postgres",
          notice: `Inngest Dev Server 未启动（${
            inngestErr instanceof Error ? inngestErr.message : "连接失败"
          }），已自动切换到等价演练模式：Postgres 状态机，行为同构、断电同样不丢。`,
        });
      }
    }

    const run = await createRunPostgres(validated.input);
    return NextResponse.json({
      run: { runId: run.runId, engine: "postgres" },
      engine: "postgres",
      notice: null,
    });
  } catch (err: unknown) {
    return errorResponse(err);
  }
}
