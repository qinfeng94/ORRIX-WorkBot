/**
 * /api/eval-loop —— Day 25 评测门禁闭环 API（/eval-loop 看板的数据通道）
 * GET：返回考卷结构 + 最新一次门禁报告 / 失败派单简报 / AutoSxS 报告快照；
 * POST：
 *  - { action: "gate", mode: "fast" | "full" } → 跑门禁考试（红灯自动落盘派单简报）；
 *  - { action: "chaos" } → 破坏演习闭环：改坏 5 万红线 → 红灯拦截 → AI 读简报修复 → 复考转绿。
 * 红线：只读评测 + 内存注入演习，绝不修改源文件，无任何打款 / 写业务数据动作。
 */

import { NextResponse, connection } from "next/server";
import {
  readEvalLoopSnapshot,
  runChaosClosedLoop,
  runGoldenSuite,
} from "@/lib/workbot/eval-gate";

/** 全量 25 题约 1 分钟、破坏演习闭环约 2 分钟（离线高仿真） */
export const maxDuration = 300;

export async function GET() {
  // cacheComponents 下用 connection() 显式声明动态渲染（替代已不兼容的 export const dynamic）
  await connection();
  try {
    const snapshot = await readEvalLoopSnapshot();
    return NextResponse.json({ ok: true, snapshot });
  } catch (err: unknown) {
    const text = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: text }, { status: 500 });
  }
}

interface EvalLoopPostBody {
  action?: string;
  mode?: string;
}

export async function POST(req: Request) {
  let body: EvalLoopPostBody;
  await connection();
  try {
    body = (await req.json()) as EvalLoopPostBody;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  if (body.action === "gate") {
    const mode = body.mode === "fast" ? "fast" : "full";
    try {
      const report = await runGoldenSuite({ mode });
      return NextResponse.json({ ok: true, mode, report });
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ ok: false, error: `门禁执行异常：${text}` }, { status: 500 });
    }
  }

  if (body.action === "chaos") {
    try {
      const loop = await runChaosClosedLoop();
      return NextResponse.json({ ok: true, loop });
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ ok: false, error: `破坏演习异常：${text}` }, { status: 500 });
    }
  }

  return NextResponse.json(
    { ok: false, error: "未知 action，支持：gate（mode=fast|full）/ chaos" },
    { status: 400 },
  );
}
