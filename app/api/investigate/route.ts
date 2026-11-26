/**
 * /api/investigate —— Day 11 零框架透明自主调查引擎的 SSE 流式接口（仅服务端，POST）
 * 溯源：AGENTS.md 业务红线（本接口只读，无任何写操作与打款路径）；
 *      04 号文档三色权限边界（3 把探针全部绿区只读）。
 * 事件序列：thought → action → observation → …（循环）→ circuit_break? →
 *           conclusion（强制附证据链）→ done
 * 说明：调查引擎为纯原生确定性透明循环（先证据后结论），不调用任何大模型、
 *      不产生 LLM 费用，也不读写任何业务数据——探针只读内存快照。
 */

import { NextResponse } from "next/server";
import {
  runInvestigation,
  type InvestigateSseEvent,
} from "@/lib/ai/react-agent";

interface InvestigateRequestBody {
  question: string;
}

export async function POST(request: Request): Promise<Response> {
  const raw: unknown = await request.json().catch(() => null);
  const body = (raw ?? {}) as Partial<InvestigateRequestBody>;
  const question = String(body.question ?? "").trim().slice(0, 2000);
  if (question.length === 0) {
    return NextResponse.json(
      { error: "调查任务不能为空。" },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: InvestigateSseEvent): void => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // 客户端已断开：停止推送（调查引擎同步执行、瞬时完成，无悬挂连接风险）
          closed = true;
        }
      };

      try {
        runInvestigation(question, send);
      } catch (err: unknown) {
        // 兜底：任何未预期异常都如实上报，绝不静默吞错
        const message = err instanceof Error ? err.message : "未知错误";
        send({
          type: "circuit_break",
          step: 0,
          maxSteps: 0,
          message: `调查引擎异常终止：${message}`,
        });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // 客户端早已断开：忽略
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
