/**
 * /api/voice/session —— 实时语音助手的会话接口（仅服务端，POST）
 * 溯源：AGENTS.md 代码红线 2（API Key 只进服务端内存，绝不进入响应体、绝不打印）；
 *      Day 6 记账红线（费用/用量必须落 llm_usage_logs，防冻结丢账）。
 * 两种动作：
 * - action=start：已配 Key 时向厂商申请约 60 秒临时令牌（ephemeral token），
 *   未配 Key 时自动返回 { mode: "browser_speech_fallback" }，前端降级到浏览器原生
 *   语音识别（Web Speech API），绝不白屏；厂商申请失败也静默降级。
 * - action=close：语音会话结束时记账一条 llm_usage_logs（表只增不改，触发器物理拒绝篡改）。
 * 防烧钱：前端另有 5 分钟自动断开熔断，到点强制调 close 记账后关麦。
 */

import { NextResponse } from "next/server";
import { ensureSchema, getDb } from "@/db";
import { llmUsageLogs } from "@/db/schema";
import { errorResponse } from "@/lib/api-error";

/** 5 分钟自动断开熔断上限（秒）——与前端倒计时共用同一数字 */
export const VOICE_SESSION_MAX_SECONDS = 300;

/** 实时模式申请的模型名（模拟环境与真实 Key 均适用） */
const REALTIME_MODEL = "gpt-realtime";

/** OpenAI Realtime 会话申请响应（只取用到的字段，严禁把原始响应透传给前端） */
interface RealtimeSessionResponse {
  client_secret?: {
    value?: string;
    expires_at?: number;
  };
}

interface SessionStartBody {
  action?: "start";
  sessionId?: string;
}

interface SessionCloseBody {
  action?: "close";
  sessionId?: string;
  mode?: "realtime" | "browser_speech_fallback";
  /** 会话时长（毫秒，服务端钳位防脏数据） */
  durationMs?: number;
  /** 本次会话工具调用次数 */
  toolCalls?: number;
  /** 是否为 5 分钟熔断自动断开 */
  autoCutoff?: boolean;
}

/** start 成功返回体：临时令牌只下发一次，主 Key 永不出服务端 */
interface SessionStartResponse {
  mode: "realtime" | "browser_speech_fallback";
  ephemeralToken?: string;
  model?: string;
  /** 临时令牌有效期（秒，约 60 秒） */
  expiresInSeconds?: number;
  /** 降级原因（fallback 时有值） */
  fallbackReason?: string;
  /** 熔断上限（秒），前端据此做 5 分钟自动断开 */
  maxSessionSeconds: number;
}

export async function POST(request: Request): Promise<Response> {
  const raw: unknown = await request.json().catch(() => null);
  const body = (raw ?? {}) as Partial<SessionStartBody & SessionCloseBody>;
  const sessionId = String(body.sessionId ?? "").slice(0, 64);
  const action = body.action === "close" ? "close" : "start";

  try {
    if (action === "start") {
      return await handleStart();
    }
    return await handleClose(body, sessionId);
  } catch (err: unknown) {
    return errorResponse(err);
  }
}

/** start：有 Key 走厂商临时令牌（失败静默降级），无 Key 直接降级浏览器语音识别 */
async function handleStart(): Promise<Response> {
  const apiKey = process.env.OPENAI_API_KEY?.trim() || "";
  const maxSessionSeconds = VOICE_SESSION_MAX_SECONDS;

  if (apiKey.length === 0) {
    // 未配 Key：绝不报错白屏，自动降级到浏览器原生语音识别
    const payload: SessionStartResponse = {
      mode: "browser_speech_fallback",
      fallbackReason: "未配置厂商 Key，已自动降级为浏览器原生语音识别（离线可用，零费用）",
      maxSessionSeconds,
    };
    return NextResponse.json(payload);
  }

  // 已配 Key：服务端持主 Key 申请约 60 秒临时令牌；主 Key 不进响应体、不打日志
  try {
    const upstream = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: REALTIME_MODEL,
        voice: "alloy",
        input_audio_transcription: { model: "gpt-4o-mini-transcribe", language: "zh" },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!upstream.ok) {
      throw new Error(`厂商会话申请失败（HTTP ${upstream.status}）`);
    }
    const data = (await upstream.json()) as RealtimeSessionResponse;
    const token = data.client_secret?.value ?? "";
    if (token.length === 0) {
      throw new Error("厂商未返回临时令牌");
    }
    const payload: SessionStartResponse = {
      mode: "realtime",
      ephemeralToken: token,
      model: REALTIME_MODEL,
      expiresInSeconds: 60,
      maxSessionSeconds,
    };
    return NextResponse.json(payload);
  } catch {
    // 临时令牌申请失败：同样降级，不白屏
    const payload: SessionStartResponse = {
      mode: "browser_speech_fallback",
      fallbackReason: "厂商实时会话申请失败，已自动降级为浏览器原生语音识别",
      maxSessionSeconds,
    };
    return NextResponse.json(payload);
  }
}

/** close：会话结束记账一条 llm_usage_logs（只增不改） */
async function handleClose(body: Partial<SessionCloseBody>, sessionId: string): Promise<Response> {
  const durationMs = Math.max(0, Math.min(Number(body.durationMs ?? 0) || 0, 60 * 60 * 1000));
  const toolCalls = Math.max(0, Math.min(Number(body.toolCalls ?? 0) || 0, 999));
  const mode = body.mode === "realtime" ? "realtime" : "browser_speech_fallback";
  const autoCutoff = body.autoCutoff === true;

  await ensureSchema();
  await getDb().insert(llmUsageLogs).values({
    providerId: "voice-session",
    model: mode === "realtime" ? REALTIME_MODEL : "browser-speech-zh-CN",
    mode: "offline-sim",
    effort: "low",
    ttftMs: 0,
    totalMs: durationMs,
    inputTokens: 0,
    outputTokens: 0,
    usdCost: "0.000000",
    wasFallback: mode === "browser_speech_fallback",
    simulatedOutage: false,
    sessionId,
    questionLabel: `实时语音会话（${toolCalls} 次工具调用${autoCutoff ? " · 5分钟熔断自动断开" : ""}）`,
  });

  return NextResponse.json({ ok: true, recorded: true });
}
