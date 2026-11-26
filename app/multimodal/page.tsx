"use client";

/**
 * /multimodal —— 多模态双标签工作台
 * 溯源：04 号文档三色权限边界（语音 3 工具：查工单/查制度=绿区只读，起草跟进=黄区强制预演）；
 *      AGENTS.md 业务红线（取证只标记不下结论、转工单走人工审批、全站无任何自动打款）。
 * Tab 1 实时语音助手：
 * - 服务端 /api/voice/session 申请约 60 秒临时令牌（Key 永不出服务端）；未配 Key 自动
 *   降级浏览器原生语音识别（Web Speech API），绝不白屏；
 * - 麦克风开启回声消除 echoCancellation:true；说话可随时打断播报（barge-in）；
 * - 3 把工具：查工单 / 查制度 / Dry-Run 起草跟进；
 * - 5 分钟自动断开防烧钱熔断，断开时调 close 接口记账入 llm_usage_logs（只增不改）。
 * Tab 2 时间戳视频取证：
 * - 本地 MP4 用离屏 <canvas> 均匀抽帧（最多 16 张 640px JPEG，总大小压 <600KB 防 413）；
 * - 内置两份仿真企业演示录像；后端 Zod 校验并钳位时间戳；
 * - 取证卡带 [MM:SS] 徽章，点徽章秒跳画面；「一键转为待审工单」真实写入 intake_requests。
 */

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactElement } from "react";
import {
  DEMO_TAPES,
  findDemoTape,
  formatMmss,
  type DemoTapeFrame,
} from "@/lib/multimodal/demo-tapes";
import type { ForensicsResponse } from "@/app/api/multimodal/forensics/route";
import type { VoiceToolCallResult } from "@/app/api/voice/tools/route";
import type { DryRunResult } from "@/lib/chat-engine";

/* ================================================================
 * Tab 1 · 实时语音助手
 * ================================================================ */

type VoiceMode = "realtime" | "browser_speech_fallback";
type VoiceState = "idle" | "connecting" | "active" | "closed";

interface VoiceSessionStartResponse {
  mode: VoiceMode;
  ephemeralToken?: string;
  model?: string;
  expiresInSeconds?: number;
  fallbackReason?: string;
  maxSessionSeconds: number;
}

interface VoiceToolsResponse {
  flowLabel: string;
  replyText: string;
  toolCalls: VoiceToolCallResult[];
  dryRuns: DryRunResult[];
}

interface TranscriptLine {
  role: "user" | "bot" | "system";
  text: string;
}

/* ---- Web Speech API 最小类型（TS DOM 未内置，显式声明，禁 any） ---- */
interface SpeechAlternativeLike {
  transcript: string;
}
interface SpeechResultLike {
  isFinal: boolean;
  readonly 0: SpeechAlternativeLike;
}
interface SpeechResultListLike {
  length: number;
  [index: number]: SpeechResultLike;
}
interface SpeechEventLike {
  resultIndex: number;
  results: SpeechResultListLike;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/* ---- OpenAI Realtime 数据通道事件（最小类型，禁 any） ---- */
interface RealtimeEvent {
  type?: string;
  response?: {
    output?: Array<{
      type?: string;
      name?: string;
      call_id?: string;
      arguments?: string;
    }>;
  };
}

/** 实时模式注册的 3 把工具（与 /api/voice/tools 直调模式一一对应） */
const REALTIME_TOOLS = [
  {
    type: "function",
    name: "query_tickets",
    description: "查询工单只读快照（绿区，只读）",
    parameters: {
      type: "object",
      properties: { department: { type: "string", description: "部门名，可传空字符串查全部" } },
    },
  },
  {
    type: "function",
    name: "search_policy",
    description: "查询集团制度文档（绿区，只读）",
    parameters: {
      type: "object",
      properties: { keywords: { type: "string", description: "关键词" } },
    },
  },
  {
    type: "function",
    name: "draft_followup",
    description: "起草客户跟进（黄区写操作，强制预演，绝不落库）",
    parameters: {
      type: "object",
      properties: { customerId: { type: "string", description: "客户编号，如 CUST-8842" } },
    },
  },
] as const;

function VoiceLab(): ReactElement {
  const [sessionState, setSessionState] = useState<VoiceState>("idle");
  const [mode, setMode] = useState<VoiceMode | null>(null);
  const [fallbackReason, setFallbackReason] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [maxSeconds, setMaxSeconds] = useState(300);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [toolCalls, setToolCalls] = useState<VoiceToolCallResult[]>([]);
  const [dryRuns, setDryRuns] = useState<DryRunResult[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [quickBusy, setQuickBusy] = useState<"query_tickets" | "search_policy" | null>(null);
  const [textInput, setTextInput] = useState("");
  const [lastFlowLabel, setLastFlowLabel] = useState("");
  const [convertOpen, setConvertOpen] = useState(false);
  const [converting, setConverting] = useState(false);
  const [convertDept, setConvertDept] = useState<"财务部" | "运营部" | "客服部">("运营部");
  const [convertAmount, setConvertAmount] = useState("8000");
  const [convertResult, setConvertResult] = useState<{
    ticketNo: string;
    isFin001: boolean;
    status: string;
  } | null>(null);
  const [convertError, setConvertError] = useState("");

  const sessionIdRef = useRef<string | null>(null);
  /** 会话编号：事件触发时惰性生成（Next 16 prerender 禁止 Client Component 渲染期读 Date.now） */
  const getSessionId = useCallback((): string => {
    if (sessionIdRef.current === null) {
      sessionIdRef.current = `voice-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
    }
    return sessionIdRef.current;
  }, []);
  const micStreamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const activeRef = useRef(false);
  const startedAtRef = useRef(0);
  const toolCallsCountRef = useRef(0);
  const speakingRef = useRef(false);
  const elapsedRef = useRef(0);
  const modeRef = useRef<VoiceMode | null>(null);

  const pushLine = useCallback((line: TranscriptLine) => {
    setLines((prev) => [...prev.slice(-40), line]);
  }, []);

  /** 语音播报（TTS）；说话时随时可被麦克风新语音打断（barge-in 在识别回调里 cancel） */
  const speak = useCallback((text: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "zh-CN";
    utter.onstart = () => {
      speakingRef.current = true;
      setSpeaking(true);
    };
    utter.onend = () => {
      speakingRef.current = false;
      setSpeaking(false);
    };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  }, []);

  /** 调用 3 把工具（一问一答 JSON），渲染卡片并 TTS 播报 */
  const handleQuestion = useCallback(
    async (text: string) => {
      try {
        const res = await fetch("/api/voice/tools", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcript: text }),
        });
        const data = (await res.json()) as VoiceToolsResponse & { error?: string };
        if (!res.ok || data.error) {
          pushLine({ role: "system", text: `工具调用失败：${data.error ?? res.status}` });
          return;
        }
        setToolCalls((prev) => [...prev, ...data.toolCalls]);
        setDryRuns((prev) => [...prev, ...data.dryRuns]);
        toolCallsCountRef.current += data.toolCalls.length;
        setLastFlowLabel(data.flowLabel);
        pushLine({ role: "bot", text: `【${data.flowLabel}】${data.replyText}` });
        speak(data.replyText);
      } catch (err: unknown) {
        pushLine({
          role: "system",
          text: `网络异常：${err instanceof Error ? err.message : "未知错误"}`,
        });
      }
    },
    [pushLine, speak],
  );

  /** 绿区直调按钮：查工单 / 查制度（无会话也可用，结果进转写与卡片，TTS 播报） */
  const runQuickTool = useCallback(
    async (tool: "query_tickets" | "search_policy") => {
      setQuickBusy(tool);
      const label = tool === "query_tickets" ? "查工单（只读）" : "查制度（只读）";
      pushLine({ role: "user", text: `（按钮）${label}` });
      try {
        const res = await fetch("/api/voice/tools", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tool,
            args: tool === "search_policy" ? { keywords: "" } : { department: "" },
          }),
        });
        const data = (await res.json()) as VoiceToolsResponse & { error?: string };
        if (!res.ok || data.error) {
          pushLine({ role: "system", text: `${label}失败：${data.error ?? res.status}` });
          return;
        }
        setToolCalls((prev) => [...prev, ...data.toolCalls]);
        toolCallsCountRef.current += data.toolCalls.length;
        setLastFlowLabel(data.flowLabel);
        pushLine({ role: "bot", text: `【${data.flowLabel}】${data.replyText}` });
        speak(data.replyText);
      } catch (err: unknown) {
        pushLine({
          role: "system",
          text: `网络异常：${err instanceof Error ? err.message : "未知错误"}`,
        });
      } finally {
        setQuickBusy(null);
      }
    },
    [pushLine, speak],
  );

  /** 手动输入兜底：不支持语音识别的浏览器也能触发同一工具链 */
  const sendText = useCallback((): void => {
    const t = textInput.trim();
    if (t.length === 0) return;
    setTextInput("");
    pushLine({ role: "user", text: t });
    void handleQuestion(t);
  }, [textInput, pushLine, handleQuestion]);

  /** 转写为工单：把最近的语音提问转成待审工单（黄区人工提交，真实写入 intake_requests） */
  const lastUserLine = [...lines]
    .reverse()
    .find((l) => l.role === "user" && !l.text.startsWith("（按钮）"));
  const convertSummary = `${lastFlowLabel ? `${lastFlowLabel}：` : ""}${
    lastUserLine?.text ?? "语音会话异常上报"
  }（语音助手转写，需人工复核）`.slice(0, 200);

  const convertVoiceTicket = useCallback(async (): Promise<void> => {
    const amount = Number.parseInt(convertAmount, 10);
    if (!Number.isInteger(amount) || amount <= 0) {
      setConvertError("金额必须是大于 0 的整数（元）。");
      return;
    }
    setConverting(true);
    setConvertError("");
    try {
      const res = await fetch("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          department: convertDept,
          amount,
          summary: convertSummary,
          customerName: "张*",
          bankAccount: "6222000012341234",
        }),
      });
      const data = (await res.json()) as {
        ticket?: { id: string; isFin001: boolean; status: string };
        error?: string;
      };
      if (!res.ok || !data.ticket) {
        setConvertError(data.error ?? `建单失败（HTTP ${res.status}）`);
        return;
      }
      setConvertResult({
        ticketNo: data.ticket.id,
        isFin001: data.ticket.isFin001,
        status: data.ticket.status,
      });
    } catch (err: unknown) {
      setConvertError(err instanceof Error ? err.message : "建单请求异常");
    } finally {
      setConverting(false);
    }
  }, [convertAmount, convertDept, convertSummary]);

  /** 实时模式 function call → /api/voice/tools 直调 → 回写 output */
  const runRealtimeTool = useCallback(
    async (dc: RTCDataChannel, callId: string, name: string, args: Record<string, unknown>) => {
      const res = await fetch("/api/voice/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: name, args }),
      });
      const data = (await res.json()) as VoiceToolsResponse & { error?: string };
      const output =
        data.error ?? `【${data.flowLabel}】${data.replyText}`;
      if (!data.error) {
        setToolCalls((prev) => [...prev, ...data.toolCalls]);
        setDryRuns((prev) => [...prev, ...data.dryRuns]);
        toolCallsCountRef.current += data.toolCalls.length;
        pushLine({ role: "bot", text: `【${data.flowLabel}】${data.replyText}` });
      }
      dc.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output,
          },
        }),
      );
      dc.send(JSON.stringify({ type: "response.create" }));
    },
    [pushLine],
  );

  /** 浏览器降级模式：Web Speech API 持续识别 + 随时打断播报 */
  const startFallbackRecognition = useCallback(() => {
    const ctor = (
      window as unknown as {
        SpeechRecognition?: SpeechRecognitionCtor;
        webkitSpeechRecognition?: SpeechRecognitionCtor;
      }
    ).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionCtor }).webkitSpeechRecognition;
    if (!ctor) {
      pushLine({
        role: "system",
        text: "当前浏览器不支持原生语音识别，请改用 Chrome / Edge 浏览器（会话保持，可手动输入问题）。",
      });
      return;
    }
    const rec = new ctor();
    rec.lang = "zh-CN";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e: SpeechEventLike) => {
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const item = e.results[i];
        const text = item[0].transcript.trim();
        if (text.length === 0) continue;
        // barge-in：识别到任何新语音立刻打断 TTS 播报
        if (speakingRef.current && typeof window !== "undefined" && "speechSynthesis" in window) {
          window.speechSynthesis.cancel();
        }
        if (item.isFinal) {
          pushLine({ role: "user", text });
          void handleQuestion(text);
        }
      }
    };
    rec.onerror = (e: { error: string }) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        pushLine({ role: "system", text: "麦克风权限被拒绝，请在浏览器地址栏允许麦克风后重试。" });
        activeRef.current = false;
      }
    };
    rec.onend = () => {
      setListening(false);
      // 会话仍活跃时自动重启识别（浏览器会在静默后自动 stop）
      if (activeRef.current) {
        try {
          rec.start();
          setListening(true);
        } catch {
          // 忽略重复 start 的异常
        }
      }
    };
    recognitionRef.current = rec;
    rec.start();
    setListening(true);
  }, [handleQuestion, pushLine]);

  /** 实时模式：WebRTC + 数据通道（临时令牌鉴权，主 Key 不落地浏览器） */
  const startRealtime = useCallback(
    async (token: string) => {
      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      const stream = micStreamRef.current;
      const track = stream?.getAudioTracks()[0];
      if (track && stream) pc.addTrack(track, stream);
      const audio = new Audio();
      audio.autoplay = true;
      pc.ontrack = (e) => {
        audio.srcObject = e.streams[0] ?? null;
      };
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.onopen = () => {
        dc.send(
          JSON.stringify({
            type: "session.update",
            session: { tools: REALTIME_TOOLS, tool_choice: "auto" },
          }),
        );
        pushLine({ role: "system", text: "实时通道已建立（临时令牌鉴权），请直接说话。" });
      };
      dc.onmessage = (e: MessageEvent<string>) => {
        let msg: RealtimeEvent;
        try {
          msg = JSON.parse(e.data) as RealtimeEvent;
        } catch {
          return;
        }
        if (msg.type !== "response.done") return;
        for (const item of msg.response?.output ?? []) {
          if (item.type !== "function_call" || !item.call_id || !item.name) continue;
          let args: Record<string, unknown> = {};
          try {
            const parsed: unknown = JSON.parse(item.arguments ?? "{}");
            if (typeof parsed === "object" && parsed !== null) {
              args = parsed as Record<string, unknown>;
            }
          } catch {
            // 参数解析失败按空参调用
          }
          void runRealtimeTool(dc, item.call_id, item.name, args);
        }
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const resp = await fetch(
        "https://api.openai.com/v1/realtime?model=gpt-realtime",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/sdp",
          },
          body: offer.sdp ?? "",
        },
      );
      if (!resp.ok) throw new Error(`实时通道握手失败（HTTP ${resp.status}）`);
      await pc.setRemoteDescription({ type: "answer", sdp: await resp.text() });
    },
    [pushLine, runRealtimeTool],
  );

  /** 结束会话（auto=true 表示 5 分钟熔断自动断开）；结束必须记账 */
  const stopSession = useCallback(
    async (auto: boolean) => {
      if (!activeRef.current) return;
      activeRef.current = false;
      recognitionRef.current?.abort();
      recognitionRef.current = null;
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      speakingRef.current = false;
      setSpeaking(false);
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
      dcRef.current?.close();
      dcRef.current = null;
      pcRef.current?.close();
      pcRef.current = null;
      setListening(false);

      const durationMs = Date.now() - startedAtRef.current;
      try {
        const res = await fetch("/api/voice/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "close",
            sessionId: getSessionId(),
            mode: modeRef.current,
            durationMs,
            toolCalls: toolCallsCountRef.current,
            autoCutoff: auto,
          }),
        });
        const data = (await res.json()) as { ok?: boolean; error?: string };
        setNotice(
          data.ok
            ? `会话已结束${auto ? "（5 分钟防烧钱熔断自动断开）" : ""}，已记账入用量台账（llm_usage_logs）。`
            : `会话已结束，但记账失败：${data.error ?? "未知错误"}`,
        );
      } catch {
        setNotice("会话已结束，记账请求失败（网络异常），请检查服务端日志。");
      }
      setSessionState("closed");
    },
    [getSessionId],
  );

  const stopSessionRef = useRef(stopSession);
  stopSessionRef.current = stopSession;

  /** 秒级计时 + 5 分钟熔断 */
  useEffect(() => {
    if (sessionState !== "active") return;
    const timer = window.setInterval(() => {
      elapsedRef.current += 1;
      setElapsed(elapsedRef.current);
      if (elapsedRef.current >= maxSeconds) {
        window.clearInterval(timer);
        void stopSessionRef.current(true);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [sessionState, maxSeconds]);

  /** 卸载兜底：关麦关通道，不再调记账（避免卸载后写状态） */
  useEffect(() => {
    return () => {
      activeRef.current = false;
      recognitionRef.current?.abort();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      pcRef.current?.close();
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const startSession = useCallback(async () => {
    setError("");
    setNotice("");
    setSessionState("connecting");
    try {
      const res = await fetch("/api/voice/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", sessionId: getSessionId() }),
      });
      const data = (await res.json()) as VoiceSessionStartResponse & { error?: string };
      if (!res.ok || data.error) {
        throw new Error(data.error ?? `会话申请失败（HTTP ${res.status}）`);
      }
      // 开麦：必须带回声消除（echoCancellation: true），避免 TTS 播报被麦克风回采
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      micStreamRef.current = stream;
      modeRef.current = data.mode;
      setMode(data.mode);
      setFallbackReason(data.fallbackReason ?? "");
      setMaxSeconds(data.maxSessionSeconds);
      activeRef.current = true;
      startedAtRef.current = Date.now();
      elapsedRef.current = 0;
      toolCallsCountRef.current = 0;
      setElapsed(0);
      setToolCalls([]);
      setDryRuns([]);
      setLines([]);
      setSessionState("active");
      pushLine({
        role: "system",
        text:
          data.mode === "realtime"
            ? `实时模式：已取得约 ${data.expiresInSeconds ?? 60} 秒临时令牌，麦克风已开启回声消除。`
            : `降级模式：${data.fallbackReason ?? "浏览器原生语音识别"}，麦克风已开启回声消除。`,
      });
      if (data.mode === "realtime" && data.ephemeralToken) {
        await startRealtime(data.ephemeralToken);
      } else {
        startFallbackRecognition();
      }
    } catch (err: unknown) {
      setSessionState("idle");
      setError(err instanceof Error ? err.message : "会话启动失败（未知错误）");
    }
  }, [pushLine, startFallbackRecognition, startRealtime, getSessionId]);

  const remaining = Math.max(0, maxSeconds - elapsed);
  const nearCutoff = remaining <= 60 && sessionState === "active";

  return (
    <div className="space-y-4">
      {/* 顶部状态栏 */}
      <div className="rounded-2xl border border-zinc-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
                sessionState === "active"
                  ? "bg-green-100 text-green-700"
                  : sessionState === "connecting"
                    ? "bg-amber-100 text-amber-700"
                    : sessionState === "closed"
                      ? "bg-zinc-100 text-zinc-600"
                      : "bg-zinc-100 text-zinc-500"
              }`}
            >
              {sessionState === "active"
                ? mode === "realtime"
                  ? "● 实时语音（临时令牌）"
                  : "● 浏览器语音降级模式"
                : sessionState === "connecting"
                  ? "正在申请会话…"
                  : sessionState === "closed"
                    ? "会话已结束"
                    : "未开始"}
            </span>
            {listening && (
              <span className="rounded-full bg-red-50 px-2 py-1 text-xs font-semibold text-red-600">
                🎙 麦克风监听中（回声消除已开启）
              </span>
            )}
            {speaking && (
              <span className="rounded-full bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-600">
                🔊 播报中 · 说话即可打断
              </span>
            )}
          </div>
          <div className="text-right">
            <div
              className={`font-mono text-2xl font-bold tabular-nums ${
                nearCutoff ? "text-red-600" : "text-zinc-900"
              }`}
            >
              {String(Math.floor(remaining / 60)).padStart(2, "0")}:
              {String(remaining % 60).padStart(2, "0")} / 05:00
            </div>
            <div className="text-xs text-zinc-500">5 分钟防烧钱熔断 · 到点自动断开并记账</div>
          </div>
        </div>
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100">
          <div
            className={`h-full rounded-full transition-all ${nearCutoff ? "bg-red-500" : "bg-zinc-900"}`}
            style={{ width: `${Math.min(100, (elapsed / maxSeconds) * 100)}%` }}
          />
        </div>

        {fallbackReason && sessionState !== "idle" && (
          <div className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
            降级提示：{fallbackReason}（不白屏、离线可用、零费用）
          </div>
        )}
        {error && (
          <div className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}
        {notice && (
          <div className="mt-3 rounded-xl bg-green-50 px-3 py-2 text-sm text-green-700">{notice}</div>
        )}

        <div className="mt-4 flex items-center gap-3">
          {sessionState === "active" || sessionState === "connecting" ? (
            <button
              onClick={() => void stopSession(false)}
              disabled={sessionState === "connecting"}
              className="rounded-xl bg-red-600 px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-red-700 disabled:opacity-50"
            >
              ■ 结束会话
            </button>
          ) : (
            <button
              onClick={() => void startSession()}
              className="rounded-xl bg-zinc-900 px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-zinc-700"
            >
              🎙 开始语音会话
            </button>
          )}
          <span className="text-xs text-zinc-500">
            说「重复扣款」触发查工单 + 查制度 + Dry-Run 起草跟进；说话随时打断播报；右上角按钮可直调查工单 / 查制度
          </span>
        </div>
      </div>

      {/* 对话转写 + 快捷工具 + 转写为工单 */}
      <div className="rounded-2xl border border-zinc-200 bg-white p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-zinc-900">语音转写与回复</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void runQuickTool("query_tickets")}
              disabled={quickBusy !== null}
              className="rounded-lg border border-green-300 bg-green-50 px-3 py-1.5 text-xs font-bold text-green-800 transition-colors hover:bg-green-100 disabled:opacity-50"
            >
              {quickBusy === "query_tickets" ? "查询中…" : "🟢 查工单（只读）"}
            </button>
            <button
              onClick={() => void runQuickTool("search_policy")}
              disabled={quickBusy !== null}
              className="rounded-lg border border-green-300 bg-green-50 px-3 py-1.5 text-xs font-bold text-green-800 transition-colors hover:bg-green-100 disabled:opacity-50"
            >
              {quickBusy === "search_policy" ? "查询中…" : "🟢 查制度（只读）"}
            </button>
          </div>
        </div>
        <div className="max-h-56 space-y-2 overflow-y-auto rounded-xl bg-zinc-50 p-3">
          {lines.length === 0 ? (
            <p className="text-sm text-zinc-400">
              尚未开始。点击「开始语音会话」后直接说话即可；不支持语音识别的浏览器可用下方输入框。
            </p>
          ) : (
            lines.map((line, i) => (
              <p
                key={i}
                className={`text-sm ${
                  line.role === "user"
                    ? "font-semibold text-zinc-900"
                    : line.role === "bot"
                      ? "text-zinc-700"
                      : "text-zinc-500"
                }`}
              >
                {line.role === "user" ? "🧑 " : line.role === "bot" ? "🤖 " : "ℹ️ "}
                {line.text}
              </p>
            ))
          )}
        </div>
        {/* 手动输入兜底（与语音走同一工具链） */}
        <div className="mt-2 flex gap-2">
          <input
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") sendText();
            }}
            placeholder="也可手动输入问题（如：CUST-8842 重复扣款 / 查一下超期物流）"
            className="flex-1 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm outline-none focus:border-zinc-900"
          />
          <button
            onClick={sendText}
            disabled={textInput.trim().length === 0}
            className="rounded-lg bg-zinc-900 px-4 py-1.5 text-sm font-bold text-white transition-colors hover:bg-zinc-700 disabled:opacity-40"
          >
            发送
          </button>
        </div>
        {/* 转写为工单（黄区：真实写入 intake_requests，人工审批） */}
        <div className="mt-3 border-t border-zinc-100 pt-3">
          <button
            onClick={() => setConvertOpen((v) => !v)}
            disabled={lastUserLine === undefined}
            className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-1.5 text-sm font-bold text-amber-800 transition-colors hover:bg-amber-100 disabled:opacity-40"
          >
            📝 转写为工单
          </button>
          {lastUserLine === undefined && (
            <span className="ml-2 text-xs text-zinc-500">
              说出或输入一个异常问题后，可一键转成待审工单
            </span>
          )}
          {convertOpen && lastUserLine !== undefined && (
            <div className="mt-2 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
              <p className="mb-2 text-xs text-zinc-600">
                摘要预览：<span className="text-zinc-800">{convertSummary}</span>
                <br />
                客户信息为虚构演示数据（张* / 6222 **** **** 1234）；写入 WorkBot 自有
                intake_requests 表，放行归具名审批人，全站无任何自动打款。
              </p>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs font-semibold text-zinc-600">
                  部门
                  <select
                    value={convertDept}
                    onChange={(e) => setConvertDept(e.target.value as typeof convertDept)}
                    className="mt-1 w-full rounded-lg border border-zinc-300 px-2 py-1.5 text-sm"
                  >
                    <option value="财务部">财务部</option>
                    <option value="运营部">运营部</option>
                    <option value="客服部">客服部</option>
                  </select>
                </label>
                <label className="text-xs font-semibold text-zinc-600">
                  金额（元）
                  <input
                    type="number"
                    min={1}
                    value={convertAmount}
                    onChange={(e) => setConvertAmount(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-zinc-300 px-2 py-1.5 text-sm"
                  />
                </label>
              </div>
              <button
                onClick={() => void convertVoiceTicket()}
                disabled={converting}
                className="mt-2 w-full rounded-lg bg-amber-500 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-amber-600 disabled:opacity-50"
              >
                {converting ? "建单中…" : "确认转待审工单"}
              </button>
              {convertError && (
                <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                  {convertError}
                </p>
              )}
              {convertResult && (
                <div
                  className={`mt-2 rounded-xl border-2 p-3 ${
                    convertResult.isFin001
                      ? "border-amber-400 bg-amber-50"
                      : "border-green-300 bg-green-50"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {convertResult.isFin001 && (
                      <span className="rounded-full bg-amber-500 px-2 py-0.5 text-xs font-bold text-white">
                        FIN-001 强制人工审批
                      </span>
                    )}
                    <strong className="font-mono text-sm text-zinc-900">
                      {convertResult.ticketNo}
                    </strong>
                    <span className="text-sm text-zinc-600">状态：{convertResult.status}</span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-600">
                    已真实写入 intake_requests，可在「工单协同台」查看。
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 工具调用卡片 */}
      {toolCalls.length > 0 && (
        <div className="rounded-2xl border border-zinc-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-bold text-zinc-900">工具调用（全程留痕）</h3>
          <div className="space-y-2">
            {toolCalls.map((t, i) => (
              <div
                key={i}
                className={`rounded-xl border px-3 py-2 text-sm ${
                  t.zone === "green"
                    ? "border-green-200 bg-green-50 text-green-800"
                    : "border-amber-200 bg-amber-50 text-amber-800"
                }`}
              >
                <span className="mr-1">{t.zone === "green" ? "🟢" : "🟡"}</span>
                <strong>{t.label}</strong> · {t.summary}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Dry-Run 草稿卡（琥珀色 · 等待具名人工审批） */}
      {dryRuns.length > 0 && (
        <div className="space-y-2">
          {dryRuns.map((d) => (
            <div
              key={d.approvalId}
              className="rounded-2xl border-2 border-amber-400 bg-amber-50 p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-amber-500 px-2 py-0.5 text-xs font-bold text-white">
                  FIN-001 强制人工审批
                </span>
                <strong className="text-sm text-amber-900">{d.title}</strong>
                <span className="font-mono text-xs text-amber-700">审批单号 {d.approvalId}</span>
              </div>
              <p className="mt-1.5 text-sm text-amber-800">{d.summary}</p>
              <p className="mt-1 text-xs text-amber-700">
                预演草稿 · 未落库 · 放行归具名审批人（AI 不审批、不打款）
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ================================================================
 * Tab 2 · 时间戳视频取证
 * ================================================================ */

interface ExtractedFrame {
  timestampSec: number;
  dataUrl: string;
}

interface TapeSource {
  source: "demo" | "upload";
  tapeId: string;
  name: string;
  durationSec: number;
  frames: DemoTapeFrame[] | null; // demo 有 curated 帧；upload 为 null
}

type ForensicsState = "idle" | "extracting" | "analyzing" | "done" | "error";

/** 仿真画面绘制器：把 curated 帧画成"屏幕录制"风格（640×360） */
function paintScene(
  ctx: CanvasRenderingContext2D,
  frame: DemoTapeFrame,
  tapeName: string,
  badge: string,
): void {
  ctx.fillStyle = "#0c0a09";
  ctx.fillRect(0, 0, 640, 360);
  // 顶部标题栏
  ctx.fillStyle = "#1c1917";
  ctx.fillRect(0, 0, 640, 40);
  ctx.fillStyle = "#a8a29e";
  ctx.font = "14px monospace";
  ctx.fillText(`● REC ${tapeName}`, 16, 25);
  ctx.fillStyle = "#57534e";
  ctx.fillText(badge, 560, 25);
  // 强调色边框
  ctx.strokeStyle = frame.accent;
  ctx.lineWidth = 2;
  ctx.strokeRect(24, 64, 592, 232);
  // 主标题
  ctx.fillStyle = frame.accent;
  ctx.font = "bold 26px sans-serif";
  ctx.fillText(frame.sceneTitle.slice(0, 24), 44, 118);
  // 正文行
  ctx.fillStyle = "#e7e5e4";
  ctx.font = "18px sans-serif";
  frame.sceneLines.forEach((line, i) => {
    ctx.fillText(line.slice(0, 30), 44, 162 + i * 34);
  });
  // 底部水印
  ctx.fillStyle = "#57534e";
  ctx.font = "12px monospace";
  ctx.fillText("仿真演示画面 · 虚构数据 · 仅用于取证流程演示", 24, 336);
}

/** 等待视频 seek 完成 */
function seekVideo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener("seeked", done);
      resolve();
    };
    video.addEventListener("seeked", done);
    video.currentTime = t;
  });
}

/** 画质压缩档位：从高清到低清逐档尝试，确保 16 帧总大小 < 600KB（防 413） */
const ENCODE_ATTEMPTS = [
  { quality: 0.72, width: 640 },
  { quality: 0.6, width: 640 },
  { quality: 0.5, width: 480 },
  { quality: 0.42, width: 400 },
  { quality: 0.35, width: 360 },
] as const;

const FRAME_BUDGET_BYTES = 600 * 1024;

function ForensicsLab(): ReactElement {
  const [tape, setTape] = useState<TapeSource | null>(null);
  const [state, setState] = useState<ForensicsState>("idle");
  const [progressText, setProgressText] = useState("");
  const [frames, setFrames] = useState<ExtractedFrame[]>([]);
  const [forensics, setForensics] = useState<ForensicsResponse | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [convertDept, setConvertDept] = useState<"财务部" | "运营部" | "客服部">("运营部");
  const [convertAmount, setConvertAmount] = useState("8000");
  const [convertResult, setConvertResult] = useState<{
    ticketNo: string;
    isFin001: boolean;
    status: string;
  } | null>(null);
  const [convertError, setConvertError] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  /** 选择内置演示录像 */
  const pickDemoTape = (id: string): void => {
    const t = findDemoTape(id);
    if (!t) return;
    setTape({ source: "demo", tapeId: t.id, name: t.name, durationSec: t.durationSec, frames: t.frames });
    setConvertDept(t.department);
    setConvertAmount(String(t.amount));
    setState("idle");
    setFrames([]);
    setForensics(null);
    setConvertResult(null);
    setConvertError("");
  };

  /** 选择本地 MP4：读元数据，不急抽帧 */
  const pickUpload = (file: File): void => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    video.src = url;
    video.onloadedmetadata = () => {
      videoRef.current = video;
      setTape({
        source: "upload",
        tapeId: "",
        name: file.name.slice(0, 120),
        durationSec: Math.max(1, video.duration || 0),
        frames: null,
      });
      setConvertDept("运营部");
      setConvertAmount("8000");
      setState("idle");
      setFrames([]);
      setForensics(null);
      setConvertResult(null);
      setConvertError("");
    };
    video.onerror = () => {
      setState("error");
      setProgressText("视频文件读取失败，请换一个标准 MP4 文件。");
    };
  };

  /** 演示录像：canvas 仿真绘制各帧 */
  const paintDemoFrames = (t: TapeSource): ExtractedFrame[] => {
    if (!t.frames) return [];
    return t.frames.map((f) => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext("2d");
      if (ctx) paintScene(ctx, f, t.name, formatMmss(f.timestampSec));
      return { timestampSec: f.timestampSec, dataUrl: canvas.toDataURL("image/jpeg", 0.8) };
    });
  };

  /** 本地 MP4：离屏 canvas 均匀抽帧（≤16 张 640px JPEG，总大小压 <600KB） */
  const extractUploadFrames = async (t: TapeSource): Promise<ExtractedFrame[]> => {
    const video = videoRef.current;
    if (!video) return [];
    const count = Math.min(16, Math.max(4, Math.ceil(t.durationSec / 15)));
    const canvases: { canvas: HTMLCanvasElement; t: number }[] = [];
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 360;
    for (let i = 0; i < count; i += 1) {
      const sec = Math.min(t.durationSec, Math.max(0, (t.durationSec * (i + 0.5)) / count));
      await seekVideo(video, sec);
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = Math.max(1, Math.round((640 * vh) / vw));
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvases.push({ canvas, t: sec });
      setProgressText(`抽帧中：${i + 1}/${count}`);
    }
    // 逐档压缩：确保总大小 < 600KB
    for (const attempt of ENCODE_ATTEMPTS) {
      const scaled: { canvas: HTMLCanvasElement; t: number }[] = canvases.map(({ canvas, t }) => {
        const out = document.createElement("canvas");
        out.width = attempt.width;
        out.height = Math.max(1, Math.round((canvas.height * attempt.width) / canvas.width));
        const ctx = out.getContext("2d");
        if (ctx) ctx.drawImage(canvas, 0, 0, out.width, out.height);
        return { canvas: out, t };
      });
      const dataUrls = scaled.map(({ canvas }) => canvas.toDataURL("image/jpeg", attempt.quality));
      const totalBytes = dataUrls.reduce((sum, d) => sum + Math.ceil((d.length * 3) / 4), 0);
      if (totalBytes <= FRAME_BUDGET_BYTES) {
        return scaled.map(({ t }, i) => ({ timestampSec: t, dataUrl: dataUrls[i] }));
      }
      setProgressText(
        `画质压缩中：档位 ${attempt.quality} / ${attempt.width}px（预估 ${(totalBytes / 1024).toFixed(0)}KB，超 600KB 降档重试）`,
      );
    }
    // 最低档仍超预算：按最后档返回（后端还有 800KB 兜底校验）
    const last = ENCODE_ATTEMPTS[ENCODE_ATTEMPTS.length - 1];
    return canvases.map(({ canvas, t }) => {
      const out = document.createElement("canvas");
      out.width = last.width;
      out.height = Math.max(1, Math.round((canvas.height * last.width) / canvas.width));
      const ctx = out.getContext("2d");
      if (ctx) ctx.drawImage(canvas, 0, 0, out.width, out.height);
      return { timestampSec: t, dataUrl: out.toDataURL("image/jpeg", last.quality) };
    });
  };

  /** 开始取证：抽帧 → 后端 Zod 校验 + 钳位 → 取证卡 */
  const analyze = async (): Promise<void> => {
    if (!tape) return;
    setConvertResult(null);
    setConvertError("");
    try {
      setState("extracting");
      const extracted =
        tape.source === "demo" ? paintDemoFrames(tape) : await extractUploadFrames(tape);
      if (extracted.length === 0) {
        setState("error");
        setProgressText("抽帧失败：没有取得任何画面帧。");
        return;
      }
      setFrames(extracted);
      setState("analyzing");
      setProgressText("取证分析中：后端 Zod 校验 + 时间戳钳位…");
      const res = await fetch("/api/multimodal/forensics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: tape.source,
          tapeId: tape.source === "demo" ? tape.tapeId : undefined,
          tapeName: tape.name,
          durationSec: tape.durationSec,
          frames: extracted.map((f) => ({ timestampSec: f.timestampSec, imagePresent: true })),
        }),
      });
      const data = (await res.json()) as ForensicsResponse & { error?: string };
      if (!res.ok || data.error) {
        setState("error");
        setProgressText(`取证失败：${data.error ?? `HTTP ${res.status}`}`);
        return;
      }
      setForensics(data);
      setActiveIndex(0);
      setState("done");
      setProgressText("");
    } catch (err: unknown) {
      setState("error");
      setProgressText(`取证异常：${err instanceof Error ? err.message : "未知错误"}`);
    }
  };

  /** 一键转为待审工单：真实写入 intake_requests（黄区人工提交，非 AI 代填） */
  const convertToTicket = async (): Promise<void> => {
    if (!forensics || !tape) return;
    setConvertError("");
    const amount = Number.parseInt(convertAmount, 10);
    if (!Number.isInteger(amount) || amount <= 0) {
      setConvertError("金额必须是大于 0 的整数（元）。");
      return;
    }
    const summary =
      tape.source === "demo"
        ? (findDemoTape(tape.tapeId)?.summary ?? forensics.summary)
        : `《${tape.name}》视频取证：${forensics.cards.length} 帧取样，${forensics.flaggedCount} 帧存疑/疑似异常，需人工复核`;
    try {
      const res = await fetch("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          department: convertDept,
          amount,
          summary: summary.slice(0, 200),
          customerName: "张*",
          bankAccount: "6222000012341234",
        }),
      });
      const data = (await res.json()) as {
        ticket?: { id: string; isFin001: boolean; status: string };
        error?: string;
      };
      if (!res.ok || !data.ticket) {
        setConvertError(data.error ?? `建单失败（HTTP ${res.status}）`);
        return;
      }
      setConvertResult({
        ticketNo: data.ticket.id,
        isFin001: data.ticket.isFin001,
        status: data.ticket.status,
      });
    } catch (err: unknown) {
      setConvertError(err instanceof Error ? err.message : "建单请求异常");
    }
  };

  const activeFrame = frames[activeIndex];
  const activeCard = forensics?.cards[activeIndex];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* 左侧：取证来源 */}
      <div className="space-y-4">
        <div className="rounded-2xl border border-zinc-200 bg-white p-4">
          <h3 className="mb-3 text-sm font-bold text-zinc-900">① 选择取证来源</h3>
          <label className="mb-3 block cursor-pointer rounded-xl border-2 border-dashed border-zinc-300 px-4 py-6 text-center transition-colors hover:border-zinc-500">
            <input
              type="file"
              accept="video/mp4"
              className="hidden"
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const file = e.target.files?.[0];
                if (file) pickUpload(file);
              }}
            />
            <span className="block text-sm font-semibold text-zinc-700">⬆ 上传本地 MP4 录像</span>
            <span className="mt-1 block text-xs text-zinc-500">
              浏览器离屏 canvas 均匀抽帧（最多 16 张 640px JPEG，总大小压 &lt;600KB，防 413）
            </span>
          </label>
          <div className="space-y-2">
            {DEMO_TAPES.map((t) => (
              <button
                key={t.id}
                onClick={() => pickDemoTape(t.id)}
                className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${
                  tape?.tapeId === t.id
                    ? "border-zinc-900 bg-zinc-900 text-white"
                    : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-400"
                }`}
              >
                <span className="block text-sm font-bold">🎬 {t.name}</span>
                <span
                  className={`mt-0.5 block text-xs ${
                    tape?.tapeId === t.id ? "text-zinc-300" : "text-zinc-500"
                  }`}
                >
                  {t.description}
                </span>
              </button>
            ))}
          </div>
          {tape && (
            <button
              onClick={() => void analyze()}
              disabled={state === "extracting" || state === "analyzing"}
              className="mt-3 w-full rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-zinc-700 disabled:opacity-50"
            >
              {state === "extracting" || state === "analyzing" ? "取证分析中…" : "▶ 开始取证分析"}
            </button>
          )}
          {progressText && (
            <p className="mt-2 text-xs text-zinc-500">{progressText}</p>
          )}
        </div>
      </div>

      {/* 右侧：取证播放器 + 取证卡 */}
      <div className="space-y-4">
        <div className="rounded-2xl border border-zinc-900 bg-zinc-950 p-4">
          <h3 className="mb-3 text-sm font-bold text-zinc-200">② 取证画面回放</h3>
          {activeFrame ? (
            <div className="relative overflow-hidden rounded-xl border border-zinc-700">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={activeFrame.dataUrl} alt={`取证帧 ${activeIndex + 1}`} className="block w-full" />
              <span className="absolute left-3 top-3 rounded-md bg-black/80 px-2 py-1 font-mono text-sm font-bold text-amber-300">
                {formatMmss(activeFrame.timestampSec)}
              </span>
              {activeCard && activeCard.level !== "info" && (
                <span
                  className={`absolute right-3 top-3 rounded-md px-2 py-1 text-xs font-bold text-white ${
                    activeCard.level === "risk" ? "bg-red-600" : "bg-amber-500"
                  }`}
                >
                  {activeCard.level === "risk" ? "疑似异常" : "存疑"}
                </span>
              )}
            </div>
          ) : (
            <div className="grid h-44 place-items-center rounded-xl border border-dashed border-zinc-700 text-sm text-zinc-500">
              选择来源并点击「开始取证分析」后展示画面
            </div>
          )}
          {/* 时间戳徽章时间线：点徽章秒跳画面 */}
          {frames.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {frames.map((f, i) => (
                <button
                  key={i}
                  onClick={() => setActiveIndex(i)}
                  className={`rounded-md px-2 py-1 font-mono text-xs font-bold transition-colors ${
                    i === activeIndex
                      ? "bg-amber-300 text-zinc-950"
                      : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                  }`}
                >
                  {formatMmss(f.timestampSec)}
                </button>
              ))}
            </div>
          )}
        </div>

        {forensics && (
          <div className="rounded-2xl border border-zinc-200 bg-white p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-zinc-900">取证结论 · {forensics.tapeName}</h3>
              <span className="text-xs text-zinc-500">
                {forensics.cards.length} 帧取样 · 存疑 {forensics.flaggedCount} 帧
                {forensics.clampedCount > 0 && ` · 时间戳钳位修正 ${forensics.clampedCount} 处`}
              </span>
            </div>
            <p className="mb-3 rounded-xl bg-zinc-50 px-3 py-2 text-sm text-zinc-700">
              {forensics.summary}
            </p>
            <div className="space-y-2">
              {forensics.cards.map((c) => (
                <div
                  key={c.index}
                  className={`flex items-start gap-3 rounded-xl border px-3 py-2 ${
                    c.level === "risk"
                      ? "border-red-200 bg-red-50"
                      : c.level === "warn"
                        ? "border-amber-200 bg-amber-50"
                        : "border-zinc-200 bg-white"
                  }`}
                >
                  <button
                    onClick={() => setActiveIndex(c.index)}
                    title="点徽章秒跳画面"
                    className={`shrink-0 rounded-md px-2 py-1 font-mono text-xs font-bold text-white transition-opacity hover:opacity-80 ${
                      c.level === "risk" ? "bg-red-600" : c.level === "warn" ? "bg-amber-500" : "bg-zinc-700"
                    }`}
                  >
                    {c.badge}
                  </button>
                  <div>
                    <p className="text-sm text-zinc-800">{c.finding}</p>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      帧 #{c.index + 1} · {c.level === "risk" ? "疑似异常（只标记，结论归人工）" : c.level === "warn" ? "存疑，建议人工复核" : "未见明显异常"}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 一键转为待审工单（黄区，紧贴取证结论，与证据卡同屏） */}
        {forensics && (
          <div className="rounded-2xl border-2 border-amber-300 bg-white p-4">
            <h3 className="mb-2 text-sm font-bold text-zinc-900">③ 一键转为待审工单</h3>
            <p className="mb-3 text-xs text-zinc-500">
              真实写入 WorkBot 自有 intake_requests 表（黄区人工提交，非 AI 代填）；
              客户信息为虚构演示数据（张* / 6222 **** **** 1234）。
            </p>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs font-semibold text-zinc-600">
                部门
                <select
                  value={convertDept}
                  onChange={(e) => setConvertDept(e.target.value as typeof convertDept)}
                  className="mt-1 w-full rounded-lg border border-zinc-300 px-2 py-1.5 text-sm"
                >
                  <option value="财务部">财务部</option>
                  <option value="运营部">运营部</option>
                  <option value="客服部">客服部</option>
                </select>
              </label>
              <label className="text-xs font-semibold text-zinc-600">
                金额（元）
                <input
                  type="number"
                  min={1}
                  value={convertAmount}
                  onChange={(e) => setConvertAmount(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-zinc-300 px-2 py-1.5 text-sm"
                />
              </label>
            </div>
            <button
              onClick={() => void convertToTicket()}
              className="mt-3 w-full rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-amber-600"
            >
              ⚡ 一键转为待审工单
            </button>
            {convertError && (
              <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{convertError}</p>
            )}
            {convertResult && (
              <div
                className={`mt-3 rounded-xl border-2 p-3 ${
                  convertResult.isFin001
                    ? "border-amber-400 bg-amber-50"
                    : "border-green-300 bg-green-50"
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  {convertResult.isFin001 && (
                    <span className="rounded-full bg-amber-500 px-2 py-0.5 text-xs font-bold text-white">
                      FIN-001 强制人工审批
                    </span>
                  )}
                  <strong className="font-mono text-sm text-zinc-900">
                    {convertResult.ticketNo}
                  </strong>
                  <span className="text-sm text-zinc-600">状态：{convertResult.status}</span>
                </div>
                <p className="mt-1 text-xs text-zinc-600">
                  已真实写入 intake_requests，可在「工单协同台」查看；放行一律由具名审批人处理，
                  全站无任何自动打款按钮。
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ================================================================
 * 页面外壳：双标签
 * ================================================================ */

export default function MultimodalPage(): ReactElement {
  const [tab, setTab] = useState<"voice" | "video">("voice");

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <div className="mb-4">
        <h1 className="text-xl font-bold tracking-tight text-zinc-900">多模态工作台</h1>
        <p className="mt-1 text-sm text-zinc-500">
          实时语音助手（60 秒临时令牌 · 未配 Key 自动降级浏览器语音识别）+ 时间戳视频取证（Zod 校验 · 钳位 · 转待审工单）。
          全程遵守三色权限边界：绿区只读、黄区预演等审批，全站无任何自动打款。
        </p>
      </div>

      <div className="mb-4 inline-flex rounded-xl border border-zinc-200 bg-white p-1">
        <button
          onClick={() => setTab("voice")}
          className={`rounded-lg px-4 py-2 text-sm font-bold transition-colors ${
            tab === "voice" ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"
          }`}
        >
          🎙 实时语音助手
        </button>
        <button
          onClick={() => setTab("video")}
          className={`rounded-lg px-4 py-2 text-sm font-bold transition-colors ${
            tab === "video" ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"
          }`}
        >
          🎬 时间戳视频取证
        </button>
      </div>

      {tab === "voice" ? <VoiceLab /> : <ForensicsLab />}
    </main>
  );
}
