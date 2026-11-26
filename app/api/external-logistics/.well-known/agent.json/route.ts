/**
 * /api/external-logistics/.well-known/agent.json —— 外部华东物流 A2A 代理名片（GET，公开）
 * 溯源：A2A 协议惯例（agent card 公开可发现，任务端点才需要 Bearer 鉴权）；
 *      04 号文档 CISO 条款 5（跨组织内容隔离：名片只描述能力，不携带任何客户数据）。
 */

import { NextResponse } from "next/server";
import { buildAgentCard } from "@/lib/multiagent/external-logistics-agent";

export async function GET(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin;
  return NextResponse.json(buildAgentCard(origin), {
    headers: { "Cache-Control": "no-store" },
  });
}
