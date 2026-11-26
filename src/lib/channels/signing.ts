/**
 * channels/signing.ts —— 4 渠道 Webhook 统一验签（Day 32）
 * 溯源：AGENTS.md 代码红线 2（密钥不进代码、不提交、不打印——演示密钥由种子运行时派生，
 *      生产一律走环境变量接管，接管后演示密钥绝不下发页面）；
 *      接入网关安全基线（验签 + 时间窗 + 防重放，三关全过才放行）。
 * 边界：
 * - 验签失败一律 401，绝不降级放行（fail-closed）；
 * - nonce 防重放缓存挂在 globalThis（dev 热更不丢），有容量上限防内存膨胀。
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { CHANNEL_IDS, type ChannelId, type ChannelMeta } from "@/lib/channels/types";

/* ================================================================
 * 一、密钥解析：环境变量优先，演示模式运行时派生（不落仓库、不硬编码密钥）
 * ================================================================ */

/** 演示种子（非机密标签：只用于派生「每次部署不同」的演示密钥；生产密钥永远来自环境变量） */
const DEMO_SEED = "workbot/channels/demo-signing-seed";

/** 各通道生产密钥的环境变量名（运维接管入口） */
export function channelSecretEnvName(channel: ChannelId): string {
  return `CHANNEL_WEBHOOK_SECRET_${channel.toUpperCase()}`;
}

export interface ResolvedSecret {
  secret: string;
  mode: "demo" | "production";
}

/** 解析某通道的生效密钥：环境变量优先；缺失时用种子派生演示密钥（仅联调用） */
export function resolveChannelSecret(channel: ChannelId): ResolvedSecret {
  const fromEnv = process.env[channelSecretEnvName(channel)]?.trim();
  if (fromEnv) {
    return { secret: fromEnv, mode: "production" };
  }
  const secret = createHash("sha256").update(`${DEMO_SEED}:${channel}`).digest("hex");
  return { secret, mode: "demo" };
}

/** 渠道元信息（GET meta 下发；production 通道绝不下发密钥） */
export function buildChannelMetaList(): ChannelMeta[] {
  const notes: Record<ChannelId, string> = {
    web: "浏览器会话直连（Web 工作台）",
    im: "企业微信 / 飞书回调 Webhook（msg_signature 同口径）",
    email: "邮件入站网关（正文优先、主题兜底）",
    h5: "移动端 H5 页面（设备标识 + Bearer 风格签名头）",
  };
  return CHANNEL_IDS.map((channel) => {
    const resolved = resolveChannelSecret(channel);
    return {
      id: channel,
      label: CHANNEL_LABELS[channel],
      accessNote: notes[channel],
      mode: resolved.mode,
      ...(resolved.mode === "demo" ? { demoSecret: resolved.secret } : {}),
    };
  });
}

export const CHANNEL_LABELS: Record<ChannelId, string> = {
  web: "Web 工作台",
  im: "企业 IM Webhook",
  email: "邮件入站",
  h5: "移动端 H5",
};

/* ================================================================
 * 二、签名与验签（HMAC-SHA256，timingSafeEqual 恒时比较）
 * ================================================================ */

/** 签名基串：channel.timestamp.nonce.body（与页面 WebCrypto 口径逐字节一致） */
export function signatureBaseString(
  channel: string,
  timestamp: number,
  nonce: string,
  body: string,
): string {
  return `${channel}.${String(timestamp)}.${nonce}.${body}`;
}

export function hmacHex(secret: string, base: string): string {
  return createHmac("sha256", secret).update(base).digest("hex");
}

/** 时间窗：±5 分钟（联调演示同机时钟；生产按部署时钟校准） */
const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

/** nonce 防重放缓存：globalThis 单例（dev 热更不丢），上限 4000 条自动清理 */
const REPLAY_KEY = Symbol.for("workbot.channels.replay-nonces");
interface ReplayStore {
  seen: Map<string, number>;
}
function replayStore(): ReplayStore {
  const g = globalThis as typeof globalThis & Record<symbol, ReplayStore>;
  if (!g[REPLAY_KEY]) {
    g[REPLAY_KEY] = { seen: new Map() };
  }
  return g[REPLAY_KEY];
}
function consumeNonce(key: string): boolean {
  const store = replayStore();
  const now = Date.now();
  // 先清理过期项（容量超限或偶发清理都走这里，保证 Map 不无限膨胀）
  if (store.seen.size > 4000) {
    for (const [k, exp] of store.seen) {
      if (exp < now) store.seen.delete(k);
    }
  }
  if (store.seen.has(key)) return false;
  store.seen.set(key, now + TIMESTAMP_WINDOW_MS * 2);
  return true;
}

export type VerifyOutcome = { ok: true } | { ok: false; status: number; error: string };

/** 统一验签三关：通道存在 → 时间窗 → HMAC 恒时比较 → nonce 防重放 */
export function verifyWebhookSignature(args: {
  channel: string;
  timestamp: number;
  nonce: string;
  body: string;
  signature: string;
}): VerifyOutcome {
  if (!(CHANNEL_IDS as readonly string[]).includes(args.channel)) {
    return { ok: false, status: 400, error: `未知通道：${args.channel}（允许：${CHANNEL_IDS.join(" / ")}）` };
  }
  if (!Number.isFinite(args.timestamp) || Math.abs(Date.now() - args.timestamp) > TIMESTAMP_WINDOW_MS) {
    return { ok: false, status: 401, error: "签名时间戳超出 ±5 分钟窗口，疑似重放，拒绝处理。" };
  }
  const trimmedSig = args.signature.trim();
  const m = /^v1=([0-9a-f]{64})$/i.exec(trimmedSig);
  if (!m) {
    return { ok: false, status: 401, error: "签名格式非法（应为 v1=<64 位十六进制 HMAC-SHA256>）。" };
  }
  const resolved = resolveChannelSecret(args.channel as ChannelId);
  const expected = hmacHex(resolved.secret, signatureBaseString(args.channel, args.timestamp, args.nonce, args.body));
  const a = Buffer.from(m[1].toLowerCase(), "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, status: 401, error: `验签失败（${resolved.mode} 模式密钥），请求已拒绝并留痕。` };
  }
  if (!consumeNonce(`${args.channel}:${args.nonce}`)) {
    return { ok: false, status: 401, error: "nonce 已被使用过（防重放拦截），拒绝处理。" };
  }
  return { ok: true };
}
