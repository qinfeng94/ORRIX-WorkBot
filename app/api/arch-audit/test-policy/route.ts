/**
 * POST /api/arch-audit/test-policy —— Day 26 零代码规则沙盒（只读、确定性、无副作用）
 * 用途：/arch-audit 看板上把审批阈值改成任意值，立刻看同一笔金额被拦还是放行，
 *      证明「改规则 = 改配置，代码零改动」。全程只在内存里覆盖配置副本，
 *      绝不修改 config/approval-policies.json，不落库、不写日志、无任何打款动作。
 */

import { NextResponse } from "next/server";
import {
  APPROVAL_POLICY,
  evaluateApprovalPolicy,
  type ApprovalPolicyConfig,
} from "@/lib/policy/approval-policy";

interface TestPolicyBody {
  thresholdCny?: unknown;
  amountCny?: unknown;
  department?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  let body: TestPolicyBody;
  try {
    body = (await request.json()) as TestPolicyBody;
  } catch {
    return NextResponse.json({ error: "请求体必须是合法 JSON" }, { status: 400 });
  }

  const threshold = Number(body.thresholdCny);
  const amount = Number(body.amountCny);
  const department = typeof body.department === "string" ? body.department : "财务部";

  if (!Number.isInteger(threshold) || threshold <= 0 || threshold > 10_000_000) {
    return NextResponse.json(
      { error: "thresholdCny 必须是 1 ~ 10,000,000 之间的正整数（元）" },
      { status: 400 },
    );
  }
  if (!Number.isFinite(amount) || amount < 0) {
    return NextResponse.json({ error: "amountCny 必须是非负数（元）" }, { status: 400 });
  }
  if (department !== "财务部" && department !== "运营部" && department !== "客服部") {
    return NextResponse.json({ error: "department 仅支持 财务部 / 运营部 / 客服部" }, { status: 400 });
  }

  // 只在内存里覆盖阈值，构造配置副本（文件与进程内真源均不受影响）
  const sandboxConfig: ApprovalPolicyConfig = {
    ...APPROVAL_POLICY,
    thresholds: { ...APPROVAL_POLICY.thresholds, financeApprovalCny: threshold },
  };
  const decision = evaluateApprovalPolicy({ department, amountCny: amount }, sandboxConfig);

  return NextResponse.json({
    thresholdCny: threshold,
    amountCny: amount,
    department,
    decision,
    configFileUntouched: "config/approval-policies.json",
    note: "沙盒仅在内存覆盖配置副本：改规则零代码，但正式红线仍以 config/approval-policies.json 为准。",
  });
}
