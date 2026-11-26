/**
 * /api/research-analyst —— Day 15 企业尽调研究台的 SSE 流式接口（仅服务端，POST）
 * 溯源：AGENTS.md 业务红线（全程只读 / 结论强制证据链 / 日志只增不改）；
 *      Day 6 引擎纪律：密钥只在服务端内存读取，绝不进响应体、绝不打印。
 * 事件序列：phase_start → source_start → source_alert* → source_result → phase_done（三阶段循环）
 *          → text_delta*（高管叙事，主厂商故障自动切备用）→ report_done → usage_done
 * 容错：三阶段编排内置「超时 → 告警 → 重试 → 降级缓存」自愈护栏，任何单源故障都不中断流程；
 *      大模型叙事失败时自动回退到引擎的确定性小结，简报照样完整交付。
 * 记账：流结束前用 after() 把本次叙事调用的厂商 / Token / 美元花费写入 llm_usage_logs（只增不改）。
 */

import { after } from "next/server";
import { NextResponse } from "next/server";
import { ensureSchema, getDb } from "@/db";
import { llmUsageLogs } from "@/db/schema";
import {
  runResearchPipeline,
  type EngineEvent,
} from "@/lib/research-analyst/engine";
import {
  MODEL_REGISTRY,
  streamChat,
  type ProviderKey,
} from "@/lib/llm/llm-client.mjs";

interface ResearchRequestBody {
  topic: string;
  /** 故障演习：注入数据源格式错误 / 超时，验证自愈容错链路 */
  simulateFaults: boolean;
  sessionId: string;
}

export async function POST(request: Request): Promise<Response> {
  const raw: unknown = await request.json().catch(() => null);
  const body = (raw ?? {}) as Partial<ResearchRequestBody>;
  const topic = String(body.topic ?? "").trim().slice(0, 300);
  if (topic.length === 0) {
    return NextResponse.json({ error: "尽调课题不能为空。" }, { status: 400 });
  }
  const simulateFaults = body.simulateFaults === true;
  const sessionId = String(body.sessionId ?? "").slice(0, 64) || "research-analyst";

  // 密钥只在这里（服务端内存）读取，绝不进入响应体，绝不打印
  const apiKeys = {
    claude: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
    openai: process.env.OPENAI_API_KEY?.trim() || undefined,
  } as Partial<Record<ProviderKey, string>>;
  const live = Boolean(apiKeys.claude);

  const encoder = new TextEncoder();

  /** 流结束后由 after() 落库的记账数据（流执行期间填充） */
  let usageRecord:
    | {
        providerId: string;
        model: string;
        mode: "live" | "offline-sim" | "error";
        effort: string;
        ttftMs: number;
        totalMs: number;
        inputTokens: number;
        outputTokens: number;
        usdCost: number;
        wasFallback: boolean;
      }
    | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // 客户端已断开：停止推送
          closed = true;
        }
      };

      const startedAt = Date.now();

      try {
        // 三阶段编排直播：阶段 → 数据源 → 告警 → 结果（引擎内部自愈，绝不抛错中断）
        const report = await runResearchPipeline(
          topic,
          { simulateFaults },
          (event: EngineEvent) => send(event),
        );

        // 高管叙事：主厂商（Claude）优先，429/503 自动秒切备用；离线默认高仿真确定性小结
        try {
          const result = await streamChat({
            primary: "claude",
            messages: [
              {
                role: "user",
                content:
                  `请以集团高管口吻，用 120 字以内中文概括以下尽调结论，不新增任何数据：\n${report.summaryText}`,
              },
            ],
            effort: "low",
            live,
            apiKeys,
            offlineReply: report.summaryText,
            onToken: (chunk) => send({ type: "text_delta", text: chunk }),
            onFallback: (info) =>
              send({
                type: "fallback_notice",
                from: info.from,
                to: info.to,
                reason: info.reason,
              }),
          });
          report.narrative = result.text;
          const usageEvent = {
            type: "usage_done" as const,
            providerId: result.providerId,
            model: result.model,
            mode: result.offlineSim ? ("offline-sim" as const) : ("live" as const),
            effort: "low",
            ttftMs: result.ttftMs,
            totalMs: result.totalMs,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            usdCost: result.costUsd,
            wasFallback: result.wasFallback,
            sessionId,
            questionLabel: "尽调研究台",
          };
          send(usageEvent);
          usageRecord = {
            providerId: usageEvent.providerId,
            model: usageEvent.model,
            mode: usageEvent.mode,
            effort: usageEvent.effort,
            ttftMs: usageEvent.ttftMs,
            totalMs: usageEvent.totalMs,
            inputTokens: usageEvent.inputTokens,
            outputTokens: usageEvent.outputTokens,
            usdCost: usageEvent.usdCost,
            wasFallback: usageEvent.wasFallback,
          };
        } catch {
          // 叙事层失败不阻塞简报：回退到引擎确定性小结（报告照样完整交付）
          report.narrative = report.summaryText;
        }

        send({ type: "report_done", report, elapsedMs: Date.now() - startedAt });
      } catch (err: unknown) {
        // 理论不可达（引擎自身不抛错）；兜底如实留痕，绝不静默吞错
        const message = err instanceof Error ? err.message : "未知错误";
        send({
          type: "fatal_error",
          message: `尽调编排异常终止：${message}`,
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

  // 记账兜底：响应结束后（含客户端中途断开）必须写入 llm_usage_logs，防 Vercel 冻结丢账
  after(async () => {
    if (!usageRecord) return;
    try {
      await ensureSchema();
      await getDb().insert(llmUsageLogs).values({
        providerId: usageRecord.providerId,
        model: usageRecord.model,
        mode: usageRecord.mode,
        effort: usageRecord.effort,
        ttftMs: usageRecord.ttftMs,
        totalMs: usageRecord.totalMs,
        inputTokens: usageRecord.inputTokens,
        outputTokens: usageRecord.outputTokens,
        usdCost: String(usageRecord.usdCost),
        wasFallback: usageRecord.wasFallback,
        simulatedOutage: false,
        sessionId,
        questionLabel: "尽调研究台",
      });
    } catch (err: unknown) {
      console.error(
        "[llm_usage_logs] 尽调叙事记账失败（不阻塞简报）：",
        err instanceof Error ? err.message : err,
      );
    }
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
