/**
 * API 错误响应统一出口：错误信息用中文大白话，密钥/连接串绝不进入响应体。
 */

import { NextResponse } from "next/server";

export function errorResponse(err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : "服务暂时不可用，请稍后再试。";
  return NextResponse.json(
    {
      error: message,
      needsSetup: message.includes("数据库未接入"),
    },
    { status: 500 },
  );
}

/** 请求体校验失败响应 */
export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}
