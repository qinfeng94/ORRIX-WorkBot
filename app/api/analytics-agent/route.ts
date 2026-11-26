/**
 * /api/analytics-agent —— Day 39 只读 SQL 分析代理 SSE 端点
 * 纪律（ADR-004）：路由只做参数装配，一律 streamWorkbot 门面出站；
 * 引擎内部走确定性规划器 + 五重安全死锁 + 只读执行，全程零 LLM 调用。
 * 红线：租户恒由服务端注入（客户端不可影响）；问题只作模板路由依据，绝不拼入 SQL。
 */

import { NextResponse, connection } from "next/server";

import { ensureAnalyticsFlow } from "@/lib/analytics/engine";
import { streamWorkbot } from "@/lib/workbot/facade";

export const maxDuration = 120;

const QUESTION_MAX_CHARS = 500;

export async function POST(req: Request): Promise<Response> {
  await connection();
  ensureAnalyticsFlow();

  let question = "";
  try {
    const body = (await req.json()) as { question?: unknown };
    if (typeof body.question === "string") question = body.question;
  } catch {
    // 空/坏 body：按默认预设问题兜底（引擎内有 DEFAULT_QUESTION）
  }
  if (question.length > QUESTION_MAX_CHARS) {
    return NextResponse.json({ error: "提问过长：请控制在 500 字以内" }, { status: 413 });
  }

  return streamWorkbot({
    flow: "analytics",
    question: question.trim(),
    meta: { engine: "analytics-secure-sql" },
  });
}
