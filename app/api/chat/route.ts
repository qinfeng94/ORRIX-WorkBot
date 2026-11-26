/**
 * /api/chat —— 全栈透明对话工作台的 SSE 流式接口（仅服务端，POST）
 * 溯源：Day 6 双模型引擎升级——所有 API Key 只能服务端读取（绝不用 NEXT_PUBLIC_ 传递）；
 *      04 号文档三色权限边界（黄区写操作只出草稿，绿区只读快照）。
 * 事件序列：context_notice → tool_start → tool_result → dry_run_required →
 *           fallback_notice → text_delta* → usage_done
 *          （context_notice 为 Day 9 三层记忆新增：汇报滑窗摘要压缩与上下文占用）。
 * 记账：流结束前用 after() 把厂商 / Token / 美元花费写入 llm_usage_logs 表
 *      （防 Vercel 冻结丢账；表为只增不改，数据库触发器物理拒绝篡改）。
 * 记忆：同一 after() 里还会做三层记忆持久化——情景记忆提取工单结论入 memory_episodes，
 *      语义记忆按提问流自动学习部门偏好入 user_preferences（均可被用户编辑/删除）。
 */

import { after } from "next/server";
import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { ensureSchema, getDb } from "@/db";
import {
  llmUsageLogs,
  memoryEpisodes,
  monitorLogs,
  promptVersions,
  userPreferences,
} from "@/db/schema";
import {
  DEFAULT_PROMPT_CONTEXT,
  classifyQuestion,
  FLOW_LABELS,
  runToolFlow,
  type PromptVersionContext,
} from "@/lib/chat-engine";
import { assertScrubberHealthy, scrubPiiDetailed } from "@/lib/pii-scrubber";
import {
  buildWorkingMemory,
  estimateTokens,
  extractEpisode,
  learnPreference,
  selectInjectableFacts,
  CONTEXT_BUDGET_TOKENS,
  type ChatRound,
} from "@/lib/memory";
import {
  MODEL_REGISTRY,
  streamChat,
  type ProviderKey,
} from "@/lib/llm/llm-client.mjs";
import {
  buildSystemPrompt,
  loadTenantConfig,
  TENANT_ID_PATTERN,
  type TenantConfig,
} from "@/lib/ontology/tenant-config";

// 注：本项目 next.config.ts 开启 cacheComponents，路由段不可再声明 runtime/maxDuration
// （默认即 Node.js 运行时）。

// Day 19 启动自检：脱敏工具核心用例任一失败即拒绝服务（PII 防线必须先证明自己健康）
assertScrubberHealthy();

/** 主模型选择：自动容灾默认 Claude 主、OpenAI 备；其余选项主备对调 */
function resolvePrimary(selector: string): ProviderKey {
  return selector === "openai" ? "openai" : "claude";
}

interface ChatRequestBody {
  question: string;
  primary: string;
  simulateOutage: boolean;
  sessionId: string;
  /** 用户标识（语义记忆归属；演示环境为具名审批人名，不含其他 PII） */
  userKey: string;
  /** 历史已完成对话轮次（工作记忆滑动窗口的输入） */
  history: ChatRound[];
  /** 租户 ID（Day 27 多租户；缺省 = 默认租户 xingchen） */
  tenantId?: string;
}

/** 请求体内历史轮次消毒：只收干净的 {user, assistant} 字符串，防脏数据膨胀 */
function sanitizeHistory(raw: unknown): ChatRound[] {
  if (!Array.isArray(raw)) return [];
  const rounds: ChatRound[] = [];
  for (const item of raw.slice(-30)) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as { user?: unknown; assistant?: unknown };
    const user = typeof r.user === "string" ? r.user.trim().slice(0, 2000) : "";
    const assistant =
      typeof r.assistant === "string" ? r.assistant.trim().slice(0, 4000) : "";
    if (user.length > 0) rounds.push({ user, assistant });
  }
  return rounds;
}

export async function POST(request: Request): Promise<Response> {
  const raw: unknown = await request.json().catch(() => null);
  const body = (raw ?? {}) as Partial<ChatRequestBody>;
  const question = String(body.question ?? "").trim();
  if (question.length === 0) {
    return NextResponse.json({ error: "提问内容不能为空。" }, { status: 400 });
  }
  const primary = resolvePrimary(String(body.primary ?? "auto"));
  const simulateOutage = body.simulateOutage === true;
  const sessionId = String(body.sessionId ?? "").slice(0, 64);
  const userKey = String(body.userKey ?? "").trim().slice(0, 64) || "demo-林总";

  // Day 27 多租户：租户 ID 白名单校验（fail-closed）+ 配置加载（提示词/部门/门槛真源）
  const tenantId = String(body.tenantId ?? "").trim() || "xingchen";
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    return NextResponse.json({ error: "租户 ID 非法。" }, { status: 400 });
  }
  let tenantCfg: TenantConfig;
  try {
    tenantCfg = await loadTenantConfig(tenantId);
  } catch {
    return NextResponse.json(
      { error: `租户配置不存在或非法：${tenantId}（fail-closed，拒绝兜底）。` },
      { status: 400 },
    );
  }
  const history = sanitizeHistory(body.history);

  // 密钥只在这里（服务端内存）读取，绝不进入响应体，绝不打印
  const apiKeys = {
    claude: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
    openai: process.env.OPENAI_API_KEY?.trim() || undefined,
  } as Partial<Record<ProviderKey, string>>;
  const live = Boolean(apiKeys[primary]);

  const flow = classifyQuestion(question);
  const questionLabel = FLOW_LABELS[flow];
  const encoder = new TextEncoder();

  /** 三层记忆组装（流开始前算好；工作记忆 6 轮滑窗 + 溢出摘要压缩） */
  const working = buildWorkingMemory(history);
  let semanticDepartment = "";
  let semanticDisplayName = "";
  let semanticStyle = "";
  let enabledFacts: string[] = [];
  let enabledEpisodes: { content: string; ticketRefs: string }[] = [];
  /** Day 19：激活的提示词版本（数据库未接入时降级 v1.0 稳定口径） */
  let promptContext: PromptVersionContext = DEFAULT_PROMPT_CONTEXT;
  let promptContent = "";
  try {
    await ensureSchema();
    // Day 19：读取当前激活的提示词版本（热回滚后下一次对话立即换版，无需重新部署）
    const promptRows = await getDb()
      .select()
      .from(promptVersions)
      .where(eq(promptVersions.isActive, true))
      .limit(1);
    if (promptRows[0]) {
      promptContext = { version: promptRows[0].version, faulty: promptRows[0].isFaulty };
      // Day 27 提示词真源切换：稳定版文案从租户配置文件动态渲染（公司名/门槛/审批人
      // 全部租户化，不再写死）；prompt_versions 表只保留版本开关与演练标记。
      // 故障演练版保持 DB 内容不变（演练语义必须与 Day 19 验收考卷完全一致）。
      promptContent = promptRows[0].isFaulty
        ? promptRows[0].content
        : buildSystemPrompt(tenantCfg);
    }
    const prefRows = await getDb()
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userKey, userKey))
      .limit(1);
    if (prefRows[0]) {
      semanticDepartment = prefRows[0].department;
      semanticDisplayName = prefRows[0].displayName;
      semanticStyle = prefRows[0].style;
      // 片段开关：被停用的事实不注入上下文（与面板预览共用同一口径函数）
      enabledFacts = selectInjectableFacts(prefRows[0].facts ?? [], prefRows[0].disabledFacts ?? []);
    }
    // 情景记忆片段：只取启用中的最近 5 条，作为跨会话参考
    const episodeRows = await getDb()
      .select({
        content: memoryEpisodes.content,
        ticketRefs: memoryEpisodes.ticketRefs,
      })
      .from(memoryEpisodes)
      .where(eq(memoryEpisodes.enabled, true))
      .orderBy(desc(memoryEpisodes.id))
      .limit(5);
    enabledEpisodes = episodeRows;
  } catch {
    // 记忆读取失败不阻塞对话（如数据库未接入）：三层记忆静默降级为纯滑窗
  }

  /** 组装发送给模型的 messages：核心提示词 → 语义记忆 → 情景记忆 → 前情摘要 → 保留原文 → 当前提问 */
  const composedMessages: { role: "user" | "assistant"; content: string }[] = [];
  if (promptContent.length > 0) {
    composedMessages.push({
      role: "user",
      content: `[核心提示词 ${promptContext.version}] ${promptContent}`,
    });
  }
  const prefParts = [
    semanticDisplayName ? `称呼：${semanticDisplayName}` : "",
    semanticDepartment ? `常关注部门：${semanticDepartment}` : "",
    semanticStyle ? `称呼风格：${semanticStyle}` : "",
    ...enabledFacts,
  ].filter((s) => s.length > 0);
  if (prefParts.length > 0) {
    composedMessages.push({
      role: "user",
      content: `[用户语义记忆] ${prefParts.join("；")}（回复时请沿用该称呼与风格）`,
    });
  }
  if (enabledEpisodes.length > 0) {
    composedMessages.push({
      role: "user",
      content: `[相关历史记忆（情景）] ${enabledEpisodes
        .map((e) => e.content)
        .join("；")}`,
    });
  }
  if (working.summaryText) {
    composedMessages.push({ role: "user", content: working.summaryText });
  }
  composedMessages.push(...working.keptMessages);
  composedMessages.push({ role: "user", content: question });

  /** 上下文窗口占用估算（仪表盘口径：语义记忆 + 摘要 + 保留原文 + 本轮提问） */
  const contextTokens = composedMessages.reduce(
    (sum, m) => sum + estimateTokens(m.content),
    0,
  );

  /** 本轮最终回复文本（after() 提取情景记忆用） */
  let finalReplyText = "";

  /** 流结束后由 after() 落库的记账数据（流执行期间填充） */
  let usageRecord:
    | {
        providerId: string;
        model: string;
        mode: "live" | "offline-sim" | "error";
        effort: string;
        ttftMs: number;
        totalMs: number;
        inputTokens: number;
        outputTokens: number;
        usdCost: number;
        wasFallback: boolean;
      }
    | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // 客户端已断开（如点击「停止生成」）：停止推送
          closed = true;
        }
      };

      const startedAt = Date.now();
      try {
        // 第〇段：上下文占用播报（Day 9 三层记忆——滑窗压缩 + Token 节省）
        send({
          type: "context_notice",
          summarizedRounds: working.summarizedRounds,
          originalTokens: working.originalTokens,
          compressedTokens: working.compressedTokens,
          savedPercent: working.savedPercent,
          contextTokens,
          contextBudget: CONTEXT_BUDGET_TOKENS,
        });

        // 第一段：工具链直播（tool_start / tool_result / dry_run_required）；提示词版本决定行为口径
        const { replyText } = runToolFlow(flow, send, promptContext);

        // 第二段：大模型流式答复（text_delta*），主厂商 429/503 时秒切备用（fallback_notice）
        const result = await streamChat({
          primary,
          messages: composedMessages,
          effort: "medium",
          live,
          apiKeys,
          forceOutage: simulateOutage,
          offlineReply: replyText,
          onToken: (chunk) => send({ type: "text_delta", text: chunk }),
          onFallback: (info) =>
            send({
              type: "fallback_notice",
              from: info.from,
              to: info.to,
              reason: info.reason,
            }),
        });
        finalReplyText = result.text;

        // 第三段：用量小结
        const usageEvent = {
          type: "usage_done" as const,
          providerId: result.providerId,
          model: result.model,
          mode: result.offlineSim ? ("offline-sim" as const) : ("live" as const),
          effort: "medium",
          ttftMs: result.ttftMs,
          totalMs: result.totalMs,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          usdCost: result.costUsd,
          wasFallback: result.wasFallback,
          sessionId,
          questionLabel,
        };
        send(usageEvent);
        usageRecord = {
          providerId: usageEvent.providerId,
          model: usageEvent.model,
          mode: usageEvent.mode,
          effort: usageEvent.effort,
          ttftMs: usageEvent.ttftMs,
          totalMs: usageEvent.totalMs,
          inputTokens: usageEvent.inputTokens,
          outputTokens: usageEvent.outputTokens,
          usdCost: usageEvent.usdCost,
          wasFallback: usageEvent.wasFallback,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "未知错误";
        send({
          type: "text_delta",
          text: `抱歉，本次对话调用失败：${message}。请在「设置」里检查厂商 Key，或稍后重试；已如实留痕，不会静默吞错。`,
        });
        usageRecord = {
          providerId: MODEL_REGISTRY[primary].providerId,
          model: MODEL_REGISTRY[primary].model,
          mode: "error",
          effort: "medium",
          ttftMs: 0,
          totalMs: Date.now() - startedAt,
          inputTokens: 0,
          outputTokens: 0,
          usdCost: 0,
          wasFallback: false,
        };
        send({
          type: "usage_done",
          ...usageRecord,
          sessionId,
          questionLabel,
        });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // 客户端早已断开：忽略
        }
      }
    },
  });

  // 记账兜底：响应结束后（含客户端中途断开）必须写入 llm_usage_logs，防 Vercel 冻结丢账
  after(async () => {
    // Day 19 PII 脱敏咽喉：请求与响应在写任何监控日志 / 记忆表之前，强制先过确定性脱敏。
    // 脱敏后的文本同时喂给情景记忆提取——记忆表同样绝不存 PII 明文。
    const reqScrub = scrubPiiDetailed(question);
    const resScrub = scrubPiiDetailed(finalReplyText);
    const piiRedactions = reqScrub.stats.total + resScrub.stats.total;

    if (usageRecord) {
      try {
        await ensureSchema();
        await getDb().insert(llmUsageLogs).values({
          providerId: usageRecord.providerId,
          model: usageRecord.model,
          mode: usageRecord.mode,
          effort: usageRecord.effort,
          ttftMs: usageRecord.ttftMs,
          totalMs: usageRecord.totalMs,
          inputTokens: usageRecord.inputTokens,
          outputTokens: usageRecord.outputTokens,
          usdCost: String(usageRecord.usdCost),
          wasFallback: usageRecord.wasFallback,
          simulatedOutage: simulateOutage,
          sessionId,
          questionLabel,
        });
      } catch (err: unknown) {
        console.error(
          "[llm_usage_logs] 记账失败（不阻塞对话）：",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Day 19 监控日志：脱敏后的请求 / 响应原文落 monitor_logs（只增不改），PII 拦截数一并留痕
    try {
      await ensureSchema();
      await getDb().insert(monitorLogs).values({
        source: "chat",
        sessionId,
        questionLabel,
        promptVersion: promptContext.version,
        requestText: reqScrub.text,
        responseText: resScrub.text,
        piiRedactions,
        latencyMs: usageRecord?.totalMs ?? 0,
      });
    } catch (err: unknown) {
      console.error(
        "[monitor_logs] 监控日志写入失败（不阻塞对话）：",
        err instanceof Error ? err.message : err,
      );
    }

    // Day 9 三层记忆持久化：情景记忆提取 + 语义记忆部门偏好学习（失败不阻塞）
    try {
      await ensureSchema();

      // ② 情景记忆：命中工单/客户/审批单号才写一条（确定性规则，不用大模型）；
      //    输入是脱敏后的文本，记忆表绝不存 PII 明文（Day 19）
      const episode = extractEpisode(reqScrub.text, resScrub.text);
      if (episode) {
        await getDb().insert(memoryEpisodes).values({
          sessionId,
          episodeType: episode.episodeType,
          content: episode.content,
          ticketRefs: episode.ticketRefs,
        });
      }

      // ③ 语义记忆：按本轮业务流自动学习部门偏好（称呼/风格只由用户手改）
      const prevPrefRows = await getDb()
        .select()
        .from(userPreferences)
        .where(eq(userPreferences.userKey, userKey))
        .limit(1);
      const prev = prevPrefRows[0] ?? { department: "", facts: [] as string[] };
      const learned = learnPreference(prev, flow, tenantCfg.flowDepartments);
      await getDb()
        .insert(userPreferences)
        .values({
          userKey,
          displayName: prevPrefRows[0]?.displayName ?? "",
          department: learned.department,
          style: prevPrefRows[0]?.style ?? "",
          facts: learned.facts,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: userPreferences.userKey,
          set: {
            department: learned.department,
            facts: learned.facts,
            updatedAt: new Date(),
          },
        });
    } catch (err: unknown) {
      console.error(
        "[memory] 记忆持久化失败（不阻塞对话）：",
        err instanceof Error ? err.message : err,
      );
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
