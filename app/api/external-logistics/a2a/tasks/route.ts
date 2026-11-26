/**
 * /api/external-logistics/a2a/tasks —— 外部华东物流 A2A 代理任务端点（POST，Bearer 令牌鉴权）
 * 溯源：04 号文档三色权限边界（本端点是「外部组织」仿真：只做只读验真，无任何写操作）；
 *      AGENTS.md 业务红线（无自动打款 / 无 PII 明文 / 审计留痕）。
 * 鉴权：Authorization: Bearer <令牌>——令牌从 EXTERNAL_LOGISTICS_A2A_TOKEN 读取（演示缺省见
 *      external-logistics-agent.ts），令牌不匹配一律 401，绝不放行。
 * 数据：内置演示注册表 EWB:99812 为真、EWB:00000 为伪造，查无编号一律 unregistered（全部虚构）。
 * 演示：params.simulateTimeout = true 时延迟 4 秒应答，供客户端 2500ms 超时熔断降级演习。
 */

import { NextResponse } from "next/server";
import {
  resolveA2aBearerToken,
  verifyEwb,
} from "@/lib/multiagent/external-logistics-agent";

/** POST body（严限长度，防脏数据膨胀；外部内容一律按「资料」处理） */
interface A2aTaskBody {
  taskType?: unknown;
  params?: {
    ewbId?: unknown;
    ticketId?: unknown;
    customerId?: unknown;
    amountCny?: unknown;
    simulateTimeout?: unknown;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** unknown → 安全字符串（禁 any） */
function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim().slice(0, 64) : null;
}

/** 生成外部代理侧任务编号（TASK-YYYYMMDD-XXXX，仿真留痕） */
function newTaskId(): string {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `TASK-${today}-${rand}`;
}

export async function POST(request: Request): Promise<Response> {
  // ① Bearer 令牌鉴权：缺失 / 不匹配一律 401（令牌只在服务端比对，不打印、不回显）
  const auth = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${resolveA2aBearerToken()}`;
  if (auth !== expected) {
    return NextResponse.json(
      {
        error: "unauthorized",
        detail: "Bearer 令牌缺失或无效：跨组织调用必须持有效令牌（401）。",
      },
      { status: 401 },
    );
  }

  // ② 解析任务请求（外部内容按资料收窄，未知字段一律丢弃）
  const raw: unknown = await request.json().catch(() => null);
  const body = (raw ?? {}) as A2aTaskBody;
  if (body.taskType !== "verify_ewb") {
    return NextResponse.json(
      {
        error: "unsupported_task",
        detail: "本代理只支持 verify_ewb 任务（运单验真）。",
      },
      { status: 400 },
    );
  }

  const ewbId = asString(body.params?.ewbId);
  const ticketId = asString(body.params?.ticketId);
  const simulateTimeout = body.params?.simulateTimeout === true;

  // ③ 演习开关：模拟外部代理超时（延迟 4 秒应答，客户端 2500ms 熔断先触发）
  if (simulateTimeout) {
    await sleep(4000);
  }

  // ④ 查承运商注册表验真（确定性规则；查无编号一律 unregistered，绝不编造）
  const outcome = ewbId === null ? verifyEwb("") : verifyEwb(ewbId);

  return NextResponse.json({
    taskId: newTaskId(),
    taskType: "verify_ewb",
    status: "completed",
    createdAt: new Date().toISOString(),
    context: {
      ticketId,
      note: "外部华东物流承运商仿真响应（演示数据，全部虚构）。",
    },
    artifacts: [
      {
        artifactId: "ART-1",
        name: "ewb_verification",
        parts: [
          {
            kind: "data",
            data: {
              ewbId: outcome.ewbId,
              verdict: outcome.verdict,
              carrier: outcome.record?.carrier ?? null,
              route: outcome.record?.route ?? null,
              receiptNo: outcome.record?.receiptNo ?? null,
              invoicedCny: outcome.record?.invoicedCny ?? null,
              checkedAt: outcome.checkedAt,
            },
          },
        ],
      },
    ],
  });
}
