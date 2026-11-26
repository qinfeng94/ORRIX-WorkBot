/**
 * /api/rag-lab —— Day 13 防越权混合检索接口（仅服务端）
 * 溯源：AGENTS.md——
 *   ① Pre-filtering ACL：角色白名单校验 + 文档池前置过滤全部在服务端强制执行，
 *      客户端传来的角色仅是「模拟登录身份」，越权文档的标题与内容永远不出服务端；
 *   ② 废止拦截：已废止的 2025 十万旧规命中即拦截并指回 FIN-001 现行制度。
 * GET  → 语料统计（总览 / 角色可见度徽标）
 * POST → { query, role } 混合检索结果（命中片段 + 引用标号 + 权限过滤透明面板数据）
 */

import { NextResponse } from "next/server";
import type { RagRole } from "@/lib/raglab/corpus";
import { corpusStats, searchRag } from "@/lib/raglab/retrieval";

interface RagLabRequestBody {
  query?: unknown;
  role?: unknown;
}

function isRole(v: unknown): v is RagRole {
  return v === "support_agent" || v === "finance_lead" || v === "executive";
}

export async function GET(): Promise<Response> {
  return NextResponse.json({ stats: corpusStats() });
}

export async function POST(request: Request): Promise<Response> {
  const raw: unknown = await request.json().catch(() => null);
  const body = (raw ?? {}) as RagLabRequestBody;

  const query = typeof body.query === "string" ? body.query.slice(0, 500) : "";
  if (!isRole(body.role)) {
    return NextResponse.json(
      { error: "非法角色，仅支持：普通客服 / 财务主管 / 集团高管。" },
      { status: 400 },
    );
  }

  try {
    const result = searchRag(query, body.role, 6);
    return NextResponse.json(result);
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "检索失败" },
      { status: 400 },
    );
  }
}
