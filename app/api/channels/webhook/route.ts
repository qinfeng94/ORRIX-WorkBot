/**
 * /api/channels/webhook —— 4 渠道统一接入网关（Day 32）
 * 溯源：统一入站适配层需求（Web / 企业 IM Webhook / 邮件入站 / 移动端 H5）；
 *      ADR-004 新入口纪律：验签归一后一律经门面 runWorkbot 进 core-engine；
 *      AGENTS.md 代码红线 2：密钥只在服务端解析，生产通道的密钥绝不下发页面。
 * 流程：
 *   POST  原始 body + x-workbot-* 签名头 → 统一验签（时间窗 / HMAC / 防重放）
 *         → 信封归一（通道字段差异在此吸收）→ 租户识别 → core-engine → 确定性小票
 *   GET   ?meta=1  渠道元信息（演示通道下发演示密钥供页面签名；生产通道不下发）
 *         ?thread=1 跨端统一线程视图（审批状态从审计库真源刷新）
 */

import { NextResponse } from "next/server";
import { ensureSchema } from "@/db";
import { badRequest, errorResponse } from "@/lib/api-error";
import { normalizeEnvelope } from "@/lib/channels/adapters";
import {
  assertTenant,
  TenantNotFoundError,
  getThreadView,
  handleInboundMessage,
} from "@/lib/channels/orchestrator";
import { buildChannelMetaList, verifyWebhookSignature } from "@/lib/channels/signing";

/** 统一验签头（与页面 WebCrypto 签名口径一致） */
const HEADER_CHANNEL = "x-workbot-channel";
const HEADER_TIMESTAMP = "x-workbot-timestamp";
const HEADER_NONCE = "x-workbot-nonce";
const HEADER_SIGNATURE = "x-workbot-signature";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.text();

    // 第一关：统一验签（时间窗 + HMAC 恒时比较 + nonce 防重放），失败一律拒绝留痕
    const verdict = verifyWebhookSignature({
      channel: request.headers.get(HEADER_CHANNEL) ?? "",
      timestamp: Number(request.headers.get(HEADER_TIMESTAMP)),
      nonce: request.headers.get(HEADER_NONCE) ?? "",
      body,
      signature: request.headers.get(HEADER_SIGNATURE) ?? "",
    });
    if (!verdict.ok) {
      return NextResponse.json({ error: verdict.error }, { status: verdict.status });
    }

    // 第二关：信封归一（吸收 4 通道字段差异 → NormalizedMessage）
    const parsed = normalizeEnvelope(body, request.headers.get(HEADER_CHANNEL) ?? "");
    if (!parsed.ok) {
      return badRequest(parsed.error);
    }

    // 第三关：租户识别（Day 27 fail-closed）→ core-engine 编排
    const result = await handleInboundMessage(parsed.msg);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof TenantNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    return errorResponse(err);
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const params = new URL(request.url).searchParams;

    if (params.get("meta") === "1") {
      // 演示密钥只在 demo 模式下发；生产通道（环境变量接管）绝不下发密钥
      const channels = buildChannelMetaList();
      const tenantId = params.get("tenant") ?? "xingchen";
      const tenant = await assertTenant(tenantId);
      return NextResponse.json({
        ok: true,
        tenantId: tenant.tenantId,
        company: tenant.companyDisplayName,
        approvers: tenant.namedApprovers,
        channels,
      });
    }

    if (params.get("thread") === "1") {
      const tenantId = params.get("tenant") ?? "xingchen";
      const userKey = params.get("user") ?? "";
      if (!userKey.trim()) return badRequest("缺少统一身份（user 参数）。");
      await ensureSchema(); // 审批状态真源在审计库；建表失败由状态查询如实降级兜底
      const thread = await getThreadView(tenantId, userKey.trim());
      return NextResponse.json({ ok: true, thread });
    }

    return badRequest("请携带 meta=1 或 thread=1 查询参数。");
  } catch (err) {
    if (err instanceof TenantNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    return errorResponse(err);
  }
}
