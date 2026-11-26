/**
 * /api/adoption-ops —— Day 38 灰度采用监控台数据通道
 * GET  ：四硬指标快照 + 抢救周趋势 + 三阶段信任阶梯状态 + 最近一次对拍台账摘要；
 * POST ：{ action: "shadow-run" } → 运行一轮 20 单影子模式对拍（老员工历史结果 vs
 *        WorkBot 后台静默结果），台账追加写入 data/day38/shadow_comparisons.jsonl。
 * 红线：影子对拍全程只读工单池快照，WorkBot 结果绝不推送给业务人员；
 *       无打款、不写业务系统正式数据；台账只增不改。
 */

import { NextResponse, connection } from "next/server";
import {
  getAdoptionSnapshot,
  runShadowComparison,
  type ShadowReport,
} from "@/lib/workbot/adoption-ops";

export const maxDuration = 60;

export async function GET() {
  // cacheComponents 下用 connection() 显式声明动态渲染
  await connection();
  try {
    const snapshot = await getAdoptionSnapshot();
    return NextResponse.json({ ok: true, snapshot });
  } catch (err: unknown) {
    const text = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: text }, { status: 500 });
  }
}

interface AdoptionPostBody {
  action?: string;
}

export async function POST(req: Request) {
  await connection();
  let body: AdoptionPostBody;
  try {
    body = (await req.json()) as AdoptionPostBody;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  if (body.action === "shadow-run") {
    try {
      const report: ShadowReport = await runShadowComparison();
      return NextResponse.json({ ok: true, report });
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ ok: false, error: `影子对拍异常：${text}` }, { status: 500 });
    }
  }

  return NextResponse.json(
    { ok: false, error: "未知 action，支持：shadow-run" },
    { status: 400 },
  );
}
