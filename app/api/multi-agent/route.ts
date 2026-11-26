/**
 * /api/multi-agent —— Day 12 四代理客服专班流水线的 SSE 流式接口（仅服务端）
 * 溯源：AGENTS.md 业务红线（FIN-001 / 红区严禁自动打款 / 日志只增不改）；
 *      04 号文档三色权限边界（分诊 / 调查只读；起草只出草稿；质检只裁定）。
 * 事件序列：trace_start → guard_input → stage_start / envelope / investigator_activity /
 *           stage_result（四岗位循环 + external_a2a 跨组织验真 + QA 打回）→ qa_reject? →
 *           escalate_human? → final_result → trace_done（瀑布图汇总数据）
 * 留痕：流结束后用 after() 把 trace + 全部 span 写入 agent_traces / agent_spans
 *      （两表均挂只增不改触发器，物理拒绝篡改；防 Vercel 冻结丢账）。
 * 历史查询：GET 返回最近 10 条追踪及其瀑布明细（页面底部「历史追踪」用）。
 */

import { after } from "next/server";
import { NextResponse } from "next/server";
import { desc, inArray } from "drizzle-orm";
import { ensureSchema, getDb } from "@/db";
import { agentSpans, agentTraces } from "@/db/schema";
import { runMultiAgentPipeline, type MultiAgentSseEvent } from "@/lib/multiagent/pipeline";

/** POST body（严限长度，防脏数据膨胀） */
interface MultiAgentRequestBody {
  question: string;
  sessionId: string;
  /** 页面「模拟外部代理超时」开关：透传给外部华东物流 A2A 代理延迟应答，触发 2500ms 熔断演习 */
  simulateExternalTimeout?: boolean;
}

export async function POST(request: Request): Promise<Response> {
  const raw: unknown = await request.json().catch(() => null);
  const body = (raw ?? {}) as Partial<MultiAgentRequestBody>;
  const question = String(body.question ?? "").trim().slice(0, 2000);
  const sessionId = String(body.sessionId ?? "").slice(0, 64);
  const simulateExternalTimeout = body.simulateExternalTimeout === true;
  if (question.length === 0) {
    return NextResponse.json({ error: "客服工单任务不能为空。" }, { status: 400 });
  }
  // 外部 A2A 代理基址取请求 origin（dev 任意端口可用；生产走同源部署或环境变量）
  const a2aBaseUrl = new URL(request.url).origin;

  const encoder = new TextEncoder();

  /** 流执行期间填充，结束后由 after() 落库（只增不改） */
  let traceRecord:
    | {
        traceId: string;
        status: "completed" | "escalated" | "blocked";
        reworkCount: number;
        totalDurationMs: number;
        totalCostUsd: string;
        triageSavingsPercent: number;
        escalateReason: string | null;
        questionLabel: string;
        spans: {
          seq: number;
          role: string;
          attempt: number;
          label: string;
          status: string;
          durationMs: number;
          costUsd: string;
          inputTokens: number;
          outputTokens: number;
          detail: string;
        }[];
      }
    | null = null;
  /** 入口护栏是否拦截（trace 落库用） */
  let inputGuardBlocked = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: MultiAgentSseEvent): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          if (event.type === "guard_input") {
            inputGuardBlocked = event.blocked;
          }
        } catch {
          // 客户端已断开：停止推送（流水线同步执行，无悬挂连接风险）
          closed = true;
        }
      };

      try {
        const result = await runMultiAgentPipeline(question, send, {
          investigator: { simulateExternalTimeout, a2aBaseUrl },
        });
        traceRecord = {
          traceId: result.traceId,
          status: result.status,
          reworkCount: result.reworkCount,
          totalDurationMs: result.totalDurationMs,
          totalCostUsd: String(result.totalCostUsd),
          triageSavingsPercent: result.triageSavingsPercent,
          escalateReason: result.escalateReason,
          questionLabel: result.questionLabel,
          spans: result.spans.map((s) => ({
            seq: s.seq,
            role: s.role,
            attempt: s.attempt,
            label: s.label,
            status: s.status,
            durationMs: s.durationMs,
            costUsd: String(s.costUsd),
            inputTokens: s.inputTokens,
            outputTokens: s.outputTokens,
            detail: s.detail,
          })),
        };
      } catch (err: unknown) {
        // 交接信封 Zod 校验失败等异常：如实上报，绝不静默吞错
        const message = err instanceof Error ? err.message : "未知错误";
        send({
          type: "escalate_human",
          reason: `流水线异常熔断（已留痕上报）：${message}`,
        });
        send({
          type: "final_result",
          status: "escalated",
          draftText: null,
          citations: [],
          evidenceChain: null,
          fin001Triggered: false,
          reworkCount: 0,
          escalateReason: `流水线异常熔断：${message}`,
          skippedDraftingReason: null,
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

  // 记账兜底：响应结束后（含客户端中途断开）必须写入两张追踪表，防 Vercel 冻结丢账
  after(async () => {
    if (!traceRecord) return;
    try {
      await ensureSchema();
      const db = getDb();
      await db.insert(agentTraces).values({
        traceId: traceRecord.traceId,
        sessionId,
        questionLabel: traceRecord.questionLabel || question.slice(0, 80),
        status: traceRecord.status,
        reworkCount: traceRecord.reworkCount,
        totalDurationMs: traceRecord.totalDurationMs,
        totalCostUsd: traceRecord.totalCostUsd,
        triageSavingsPercent: traceRecord.triageSavingsPercent,
        inputGuardBlocked,
        escalateReason: traceRecord.escalateReason ?? "",
      });
      if (traceRecord.spans.length > 0) {
        await db.insert(agentSpans).values(
          traceRecord.spans.map((s) => ({
            traceId: traceRecord?.traceId ?? "",
            seq: s.seq,
            role: s.role,
            attempt: s.attempt,
            label: s.label,
            status: s.status,
            durationMs: s.durationMs,
            costUsd: s.costUsd,
            inputTokens: s.inputTokens,
            outputTokens: s.outputTokens,
            detail: s.detail,
          })),
        );
      }
    } catch (err: unknown) {
      console.error(
        "[agent_traces] 追踪留痕失败（不阻塞流水线）：",
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

/** GET：最近 10 条追踪 + 各自瀑布明细（历史追踪面板） */
export async function GET(): Promise<Response> {
  try {
    await ensureSchema();
    const db = getDb();
    const traces = await db
      .select()
      .from(agentTraces)
      .orderBy(desc(agentTraces.id))
      .limit(10);
    const traceIds = traces.map((t) => t.traceId);
    const spans =
      traceIds.length > 0
        ? await db
            .select()
            .from(agentSpans)
            .where(inArray(agentSpans.traceId, traceIds))
            .orderBy(agentSpans.traceId, agentSpans.seq)
        : [];
    return NextResponse.json({ traces, spans });
  } catch (err: unknown) {
    // 数据库未接入时不阻塞页面：返回空历史（当前运行的瀑布图仍来自 SSE）
    console.error(
      "[agent_traces] 历史查询失败：",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ traces: [], spans: [] });
  }
}
