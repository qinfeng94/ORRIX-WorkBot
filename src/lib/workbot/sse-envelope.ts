/**
 * workbot/sse-envelope.ts —— 统一 SSE 事件信封出站编码（ADR-004 §四）
 * 所有引擎的对外事件一律映射进 WorkbotSseEvent（7 类）后经本文件编码出站；
 * 路由禁止再手工拼 "data: {...}" 或自造事件字段。
 */
import type { EmitWorkbotEvent, WorkbotSseEvent } from "./types";

/** 单事件 → SSE 帧（data: JSON + 空行） */
export function encodeSseEvent(event: WorkbotSseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * 创建统一信封的 SSE Response：
 * 调用方只需给一段「往 emit 里吐事件」的流水线，本函数负责帧编码、队列与收尾。
 */
export function createWorkbotSseResponse(
  pipeline: (emit: EmitWorkbotEvent) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit: EmitWorkbotEvent = (event) => {
        controller.enqueue(encoder.encode(encodeSseEvent(event)));
      };
      try {
        await pipeline(emit);
      } catch (err: unknown) {
        // 编排层绝不把异常裸抛给前端：统一转 fallback 告警 + done 收尾
        const text = err instanceof Error ? err.message : String(err);
        emit({ type: "notice", level: "fallback", text: `编排异常已拦截并收尾：${text}` });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/* ================================================================
 * 存量引擎事件 → 统一信封的映射适配器（灰度迁移期供内室引擎挂接）
 * ================================================================ */

/** Dry-Run 草稿（chat-engine DryRunResult 形状）→ 统一信封卡片 */
export function mapDryRunToCard(d: {
  approvalId: string;
  tool: string;
  title: string;
  summary: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  draft?: Record<string, unknown>;
}): Extract<WorkbotSseEvent, { type: "card" }> {
  return {
    type: "card",
    card: {
      kind: "dry_run",
      approvalId: d.approvalId,
      tool: d.tool,
      title: d.title,
      summary: d.summary,
      before: d.before,
      after: d.after,
      draft: d.draft,
    },
  };
}
