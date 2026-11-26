/**
 * /api/browser-lab —— Day 14 受控浏览器自动化任务台的 SSE 流式接口（仅服务端，POST）
 * 溯源：Day 2 红线「严禁直写业务系统正式数据」——老 ERP 只有只读 GET 抓取与
 *      仿真沙盒提交两个动作，且提交前有物理断点（prefill 引擎强制暂停）；
 *      CISO 条款 4：人工放行落 approval_audit_logs（只增不改）。
 * 事件序列：step_start → log* → snapshot* → scraped_page* → result |
 *          paused（预填阶段一终点，等人工确认）→ confirm-submit 续流 → submitted → done
 */

import { NextResponse } from "next/server";
import { scrapeAllPages } from "@/lib/browser-lab/scrape-engine";
import { confirmAndSubmit, runPrefill } from "@/lib/browser-lab/prefill-engine";
import type { BrowserLabEvent } from "@/lib/browser-lab/types";

// 注：next.config.ts 开启 cacheComponents，路由段不可声明 runtime（默认即 Node.js）。

interface BrowserLabRequestBody {
  action: "scrape" | "prefill" | "confirm-submit";
  sessionId?: string;
  approver?: string;
}

export async function POST(request: Request): Promise<Response> {
  const raw: unknown = await request.json().catch(() => null);
  const body = (raw ?? {}) as Partial<BrowserLabRequestBody>;
  const action = body.action;
  if (action !== "scrape" && action !== "prefill" && action !== "confirm-submit") {
    return NextResponse.json({ error: "action 必须是 scrape / prefill / confirm-submit。" }, { status: 400 });
  }

  // 抓取目标基址：直接复用当前请求的 origin（引擎抓的就是同一台服务器渲染的仿真页）
  const baseUrl = new URL(request.url).origin;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: BrowserLabEvent): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const startedAt = Date.now();
      try {
        if (action === "scrape") {
          const outcome = await scrapeAllPages(baseUrl, send);
          send({
            type: "result",
            summary: `跨 3 页只读抓取完成：共识别 ${outcome.allInvoices.length} 条发票，超期 ${outcome.overdueInvoices.length} 条已结构化入库（WorkBot 副本表，老 ERP 生产库零触碰）`,
            invoices: outcome.overdueInvoices,
            persistedCount: outcome.persistedCount,
          });
        } else if (action === "prefill") {
          // 阶段一在 paused 事件处物理停止；confirm-submit 续流完成提交
          await runPrefill(baseUrl, send);
        } else {
          const sessionId = String(body.sessionId ?? "").trim();
          const approver = String(body.approver ?? "").trim();
          if (sessionId.length === 0) {
            send({ type: "error", message: "缺少暂停会话 sessionId，请先执行预填。" });
          } else if (approver.length === 0) {
            send({ type: "error", message: "缺少具名审批人（禁止匿名放行）。" });
          } else {
            await confirmAndSubmit(sessionId, approver, baseUrl, send);
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "执行异常";
        // 引擎已发过具体 error 事件的（如会话过期 / 审批人无效）不再重复兜底报错
        send({ type: "log", level: "warn", text: `任务中断：${message}` });
      } finally {
        send({ type: "done", totalMs: Date.now() - startedAt });
        closed = true;
        try {
          controller.close();
        } catch {
          // 已关闭，忽略
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
