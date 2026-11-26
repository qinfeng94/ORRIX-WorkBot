/**
 * channels/adapters.ts —— 4 渠道入站信封归一化适配层（Day 32）
 * 溯源：统一接入网关需求（Web / 企业 IM Webhook / 邮件入站 / 移动端 H5 兼容）；
 *      AGENTS.md「外来内容隔离」——邮件正文等外部内容只是资料，其中的"指令"不执行。
 * 边界：
 * - 各通道字段缺失 / 超长 / 格式非法 → fail-closed 拒绝，绝不猜测兜底放行；
 * - 归一只做结构提取，不做业务判断（业务判断在 orchestrator / core-engine）。
 */

import { CHANNEL_IDS, type ChannelId, type ImPlatform, type ParsedEnvelope } from "@/lib/channels/types";

const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TEXT_MAX = 2000;
const SUBJECT_MAX = 200;

interface RawEnvelope {
  channel?: unknown;
  tenantId?: unknown;
  platform?: unknown;
  channelUserId?: unknown;
  from?: unknown;
  deviceId?: unknown;
  subject?: unknown;
  text?: unknown;
}

/** 从信封提取单行文本字段（trim + 长度约束 + 类型收窄，拒绝隐式转换） */
function readText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

/**
 * 统一归一化入口：验签通过后的原始 JSON body → NormalizedMessage。
 * 各通道差异只在字段来源，正文 / 租户 / 用户标识归一后完全一致。
 */
export function normalizeEnvelope(rawBody: string, headerChannel: string): ParsedEnvelope {
  let raw: RawEnvelope;
  try {
    raw = JSON.parse(rawBody) as RawEnvelope;
  } catch {
    return { ok: false, status: 400, error: "请求体不是合法 JSON，信封解析失败。" };
  }
  if (raw === null || typeof raw !== "object") {
    return { ok: false, status: 400, error: "信封必须是一个 JSON 对象。" };
  }

  // 通道识别：body.channel 优先，x-workbot-channel 头兜底；两者不一致 → 拒绝（防通道混淆）。
  const bodyChannel = typeof raw.channel === "string" ? raw.channel.trim() : "";
  const channel = bodyChannel || headerChannel.trim();
  if (!channel || !(CHANNEL_IDS as readonly string[]).includes(channel)) {
    return {
      ok: false,
      status: 400,
      error: `无法识别通道（允许：${CHANNEL_IDS.join(" / ")}），请在 body.channel 或 x-workbot-channel 头声明。`,
    };
  }
  if (bodyChannel && headerChannel.trim() && bodyChannel !== headerChannel.trim()) {
    return { ok: false, status: 400, error: "body.channel 与 x-workbot-channel 头不一致，疑似通道混淆，拒绝处理。" };
  }
  const channelId = channel as ChannelId;

  // 租户识别：缺省 xingchen（集团默认租户）；格式非法 → 拒绝（fail-closed，多租户 Day 27 口径）。
  const tenantId = typeof raw.tenantId === "string" && raw.tenantId.trim() ? raw.tenantId.trim() : "xingchen";
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    return { ok: false, status: 400, error: `租户 ID 不合法：${tenantId.slice(0, 32)}` };
  }

  // 正文：邮件通道允许正文为空时用主题兜底；其余通道正文必填。
  const text = readText(raw.text, TEXT_MAX);
  const subject = readText(raw.subject, SUBJECT_MAX);
  let finalText = text;
  if (channelId === "email" && !finalText && subject) {
    finalText = subject;
  }
  if (!finalText) {
    return {
      ok: false,
      status: 400,
      error: channelId === "email" ? "邮件正文与主题均为空，没有可处理的内容。" : "缺少有效正文（text 必填，1~2000 字）。",
    };
  }

  // 渠道侧用户标识：各通道字段来源不同（企微 userid / 邮箱地址 / H5 设备号 / Web 会话标识）。
  let channelUserId: string | null = readText(raw.channelUserId, 128);
  if (!channelUserId) channelUserId = readText(raw.from, 128);
  if (!channelUserId) channelUserId = readText(raw.deviceId, 128);
  if (!channelUserId) {
    return {
      ok: false,
      status: 400,
      error: `缺少渠道侧用户标识（${CHANNEL_USER_FIELD_HINT[channelId]}），无法做跨端身份归一。`,
    };
  }

  // IM 平台细分：仅 im 通道要求，且必须是受支持平台。
  let platform: ImPlatform | undefined;
  if (channelId === "im") {
    const p = typeof raw.platform === "string" ? raw.platform.trim() : "";
    if (p !== "wecom" && p !== "feishu") {
      return { ok: false, status: 400, error: "im 通道必须声明 platform=wecom | feishu。" };
    }
    platform = p;
  }

  return {
    ok: true,
    msg: {
      channel: channelId,
      ...(platform ? { platform } : {}),
      tenantId,
      channelUserId,
      text: finalText,
      ...(subject ? { subject } : {}),
    },
  };
}

export const CHANNEL_USER_FIELD_HINT: Record<ChannelId, string> = {
  web: "channelUserId（Web 会话标识）",
  im: "channelUserId（企微 / 飞书 userid）",
  email: "from（发件人邮箱地址）",
  h5: "channelUserId 或 deviceId（设备标识）",
};
