/**
 * /api/queue-lab —— Day 33 500 并发多租户公平队列压测 API（/queue-lab 看板的数据通道）
 * GET：恢复当前（或最近一轮）压测单例状态——含全量曲线快照与终局战报（刷新/多端观看兜底）；
 * POST：登记并启动一轮 500 并发对照压测（公平队列 vs FIFO），SSE 实时中继事件流。
 * 红线：纯内存仿真 + 只读统计；台账 JSONL 只增不改；无任何打款 / 写业务数据能力。
 */

import { NextResponse, connection } from "next/server";
import {
  beginQueueLabRun,
  getQueueLabRun,
  QueueLabConflictError,
} from "@/lib/queue/load-test";
import type { QueueLabEvent } from "@/lib/queue/types";

/** 500 并发对照压测实际 ~30 秒上下（hardCap 90 秒熔断），留足余量 */
export const maxDuration = 300;

export async function GET() {
  // cacheComponents 下用 connection() 显式声明动态渲染（替代已不兼容的 export const dynamic）
  await connection();
  const state = getQueueLabRun();
  if (!state) {
    return NextResponse.json({ ok: true, phase: "idle" });
  }
  return NextResponse.json({ ok: true, phase: state.status, state });
}

export async function POST() {
  await connection();

  // run_started 等事件可能在 ReadableStream start 之前同步 emit（beginQueueLabRun 立即返回）——
  // 必须先缓冲到 pending，stream 启动后再 flush（否则首帧永久丢失）。
  const pending: QueueLabEvent[] = [];
  let send: ((event: QueueLabEvent) => void) | null = null;

  let beginResult: ReturnType<typeof beginQueueLabRun>;
  try {
    beginResult = beginQueueLabRun({
      onEvent: (event) => {
        if (send) send(event);
        else pending.push(event);
      },
    });
  } catch (err: unknown) {
    if (err instanceof QueueLabConflictError) {
      return NextResponse.json(
        { ok: false, error: err.message, runId: getQueueLabRun()?.runId ?? null },
        { status: 409 },
      );
    }
    const text = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `压测启动失败：${text}` }, { status: 500 });
  }

  const { promise } = beginResult;

  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const closeStream = (): void => {
    try {
      controllerRef?.close();
    } catch {
      // stream 已被观看端取消时忽略
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      const encoder = new TextEncoder();
      const push = (event: QueueLabEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      send = push;
      for (const event of pending) push(event);
      pending.length = 0;
    },
    cancel() {
      // 观看端断开不影响压测本体（台账照常落盘），只是停止中继
      send = null;
    },
  });

  void promise.then(
    () => {
      send = null;
      closeStream();
    },
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      send?.({ type: "error", message });
      send = null;
      closeStream();
    },
  );

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
