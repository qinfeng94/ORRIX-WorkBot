/**
 * /api/fleet —— Day 22 并发代理军团调度器的 SSE 流式接口（仅服务端）
 * 溯源：AGENTS.md 业务红线（初审全程只读 + 起草；FIN-001 强制人工审批；红区物理隔离）。
 * 事件序列：fleet_start → (ticket_start / ticket_retry / ticket_done)* → fleet_done（含完整战报）
 * 与 CLI（scripts/day22-lab/fleet-runner.mjs）共用同一份核心调度器 lib/day22/fleet-scheduler.mjs；
 * 流结束后用 after() 把战报落盘 data/day22/fleet-report.json（防 Vercel 冻结丢报告）。
 */

import { after } from "next/server";
import { NextResponse } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  runFleet,
  type FleetEvent,
  type FleetReport,
} from "@/lib/day22/fleet-scheduler.mjs";

/** POST body（严限范围，防脏数据膨胀） */
interface FleetRequestBody {
  total?: number;
  concurrency?: number;
  seed?: number;
}

/** 战报落盘路径（本地 dev 直接可写；只覆盖当前战报文件，不触碰任何审计日志） */
function reportPath(): string {
  return path.join(process.cwd(), "data", "day22", "fleet-report.json");
}

export async function POST(request: Request): Promise<Response> {
  const raw: unknown = await request.json().catch(() => null);
  const body = (raw ?? {}) as Partial<FleetRequestBody>;
  const total = clampInt(body.total, 1, 200, 50);
  const concurrency = clampInt(body.concurrency, 1, total, 10);
  const seed = clampInt(body.seed, 1, Number.MAX_SAFE_INTEGER, 20221122);

  /** 流结束后由 after() 落盘的战报 */
  let finalReport: FleetReport | null = null;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: FleetEvent): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          if (event.type === "fleet_done" && event.report) {
            finalReport = event.report;
          }
        } catch {
          // 客户端已断开：停止推送（调度器同步执行，无悬挂连接风险）
          closed = true;
        }
      };

      try {
        await runFleet({ total, concurrency, seed, runBy: "web", onEvent: send });
      } catch (err: unknown) {
        // 调度器异常：如实上报，绝不静默吞错（战报置零 + fatal 原因，页面端如实呈现）
        const message = err instanceof Error ? err.message : "未知错误";
        send({
          type: "fleet_done",
          fatal: `调度器异常熔断（已留痕上报）：${message}`,
          report: {
            runId: "fleet-error",
            runBy: "web",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            config: { total, concurrency, maxAttempts: 3, seed },
            stats: {
              totalElapsedMs: 0,
              avgPerTicketMs: 0,
              p95PerTicketMs: 0,
              maxPerTicketMs: 0,
              totalCostUsd: 0,
              fin001Intercepted: 0,
              succeeded: 0,
              failed: 0,
              totalRetries: 0,
              throughputPerMinute: 0,
            },
            tickets: [],
          },
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

  // 记账兜底：响应结束后（含客户端中途断开）必须落盘战报，防 Vercel 冻结丢失
  after(async () => {
    if (!finalReport) return;
    try {
      await mkdir(path.dirname(reportPath()), { recursive: true });
      await writeFile(reportPath(), JSON.stringify(finalReport, null, 2) + "\n", "utf8");
    } catch (err: unknown) {
      // 只读/无盘环境（如部分 Serverless）：跳过落盘，页面上的战报已通过 SSE 完整送达
      console.error(
        "[fleet] 战报落盘失败（不阻塞页面展示）：",
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

/** GET：确认接口在线 + 返回红线口径（供页面探活与自检） */
export async function GET(): Promise<Response> {
  return NextResponse.json({
    status: "ok",
    day: "Day 22 并发代理军团调度器",
    redlines: [
      "初审全程只读 + 起草，注册表物理不存在打款工具",
      "FIN-001：财务部单笔超过 ¥50,000 强制拦截转具名审批人（等于 50,000 不触发）",
      "疑似拆单按合并口径处理并上报",
      "瞬时故障指数退避自动重试（300/600/1200ms，≤ 3 次）",
    ],
  });
}

/** 安全整数截取 */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(Math.trunc(n), max));
}
