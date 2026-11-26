/**
 * /api/voice/tools —— 实时语音助手的 3 把企业工具入口（仅服务端，POST）
 * 溯源：04 号文档三色权限边界——查工单 / 查制度为绿区只读，起草跟进为黄区写操作，
 *      后端强制 dryRun 只出草稿卡与审批单号，绝不落库（红区物理剔除兜底沿用 chat-engine）。
 * 两种用法：
 * - { transcript } ：一段语音识别文本 → 自动分类业务流 → 走 chat-engine 全流程工具链；
 * - { tool, args } ：实时模式（WebRTC function call）按工具名直调单把工具。
 * 输出统一 JSON（语音场景无需 SSE 流式），黄区草稿卡带审批单号等待具名人工审批。
 */

import { NextResponse } from "next/server";
import { badRequest, errorResponse } from "@/lib/api-error";
import {
  classifyQuestion,
  dryRunTool,
  FLOW_LABELS,
  runToolFlow,
  TOOL_REGISTRY,
  type ChatSseEvent,
  type DryRunResult,
  type ToolZone,
} from "@/lib/chat-engine";

/** 单次工具调用结果（前端渲染绿/黄区卡片） */
export interface VoiceToolCallResult {
  tool: string;
  zone: ToolZone;
  label: string;
  summary: string;
}

/** 请求体：自动流（transcript）或直调（tool + args） */
interface VoiceToolsBody {
  transcript?: string;
  tool?: string;
  args?: Record<string, unknown>;
}

/** 响应体：语音助手一问一答的全部素材 */
interface VoiceToolsResponse {
  flowLabel: string;
  replyText: string;
  toolCalls: VoiceToolCallResult[];
  dryRuns: DryRunResult[];
}

export async function POST(request: Request): Promise<Response> {
  const raw: unknown = await request.json().catch(() => null);
  const body = (raw ?? {}) as Partial<VoiceToolsBody>;
  try {
    if (typeof body.tool === "string" && body.tool.length > 0) {
      return handleDirectTool(body.tool, body.args);
    }
    return handleTranscript(String(body.transcript ?? ""));
  } catch (err: unknown) {
    return errorResponse(err);
  }
}

/** 自动流：语音文本 → 业务流分类 → chat-engine 工具链（绿区只读 + 黄区 dryRun） */
function handleTranscript(transcript: string): Response {
  const text = transcript.trim().slice(0, 2000);
  if (text.length === 0) {
    return badRequest("语音识别文本为空，请再试一次。");
  }
  const flow = classifyQuestion(text);
  const toolCalls: VoiceToolCallResult[] = [];
  const dryRuns: DryRunResult[] = [];

  // runToolFlow 的 SSE 事件在这里被收集成 JSON 卡片（语音场景一问一答，无需流式）
  const collect = (event: ChatSseEvent): void => {
    if (event.type === "tool_result") {
      toolCalls.push({ tool: event.tool, zone: "green", label: event.tool, summary: event.summary });
    } else if (event.type === "dry_run_required") {
      const { approvalId, tool, title, summary, before, after, draft } = event;
      dryRuns.push({ approvalId, tool, title, summary, before, after, draft });
    }
  };
  const { replyText } = runToolFlow(flow, collect);

  const payload: VoiceToolsResponse = {
    flowLabel: FLOW_LABELS[flow],
    replyText,
    toolCalls,
    dryRuns,
  };
  return NextResponse.json(payload);
}

/** 直调模式：实时模型 function call 按名字单把调用（黄区强制 dryRun，物理不可落库） */
function handleDirectTool(tool: string, rawArgs: unknown): Response {
  const args: Record<string, unknown> =
    typeof rawArgs === "object" && rawArgs !== null ? (rawArgs as Record<string, unknown>) : {};
  const toolCalls: VoiceToolCallResult[] = [];
  const dryRuns: DryRunResult[] = [];

  if (tool === "query_tickets") {
    const department = typeof args.department === "string" ? args.department : "";
    const result = TOOL_REGISTRY.inspect_case_bundle.run({ department }) as {
      tickets: {
        ticketId: string;
        department: string;
        title: string;
        amountCny: number;
        fin001Triggered: boolean;
      }[];
    };
    toolCalls.push({
      tool: "inspect_case_bundle",
      zone: "green",
      label: TOOL_REGISTRY.inspect_case_bundle.label,
      summary: `勘察 ${result.tickets.length} 条工单（只读快照）：${result.tickets
        .map((t) => `${t.ticketId} ${t.title}`)
        .join("、") || "无"}`,
    });
    const lines = result.tickets.map(
      (t) =>
        `${t.ticketId}（${t.department}）${t.title}，金额 ¥${t.amountCny.toLocaleString("zh-CN")}` +
        `${t.fin001Triggered ? "（FIN-001 大额）" : ""}`,
    );
    const payload: VoiceToolsResponse = {
      flowLabel: "语音直调 · 案情勘察",
      replyText:
        lines.length === 0
          ? "只读快照里暂时没有查到工单。"
          : `勘察到 ${result.tickets.length} 条工单（只读快照）：${lines.join("；")}。我只读不改，处理建议需要人工确认。`,
      toolCalls,
      dryRuns,
    };
    return NextResponse.json(payload);
  }

  if (tool === "search_policy") {
    const keywords = typeof args.keywords === "string" ? args.keywords : "";
    const result = TOOL_REGISTRY.search_compliance_policy.run({ keywords }) as {
      evidence: { docId: string; section: string; title: string }[];
      policyLock: string;
    };
    toolCalls.push({
      tool: "search_compliance_policy",
      zone: "green",
      label: TOOL_REGISTRY.search_compliance_policy.label,
      summary: `命中 ${result.evidence.length} 条现行制度条款（${result.policyLock} 时效锁）`,
    });
    const lines = result.evidence.map((d) => `${d.docId} §${d.section} ${d.title}`);
    const payload: VoiceToolsResponse = {
      flowLabel: "语音直调 · 查制度",
      replyText:
        lines.length === 0
          ? "制度库中暂未命中相关条款，请换个说法再问。"
          : `命中 ${result.evidence.length} 条现行制度条款：${lines.join("；")}。详细原文以制度系统为准。`,
      toolCalls,
      dryRuns,
    };
    return NextResponse.json(payload);
  }

  if (tool === "draft_followup") {
    const customerId = typeof args.customerId === "string" ? args.customerId : "CUST-8842";
    toolCalls.push({
      tool: "prepare_human_approval_draft",
      zone: "yellow",
      label: TOOL_REGISTRY.prepare_human_approval_draft.label,
      summary: "黄区写操作，强制预演：只出草稿卡，绝不落库",
    });
    // 黄区 dryRun 代码层强制锁死（与 /chat 同一函数，调用方传什么都无法落库）
    const draft = dryRunTool("crm_flag", {
      customerId,
    });
    dryRuns.push(draft);
    const payload: VoiceToolsResponse = {
      flowLabel: "语音直调 · Dry-Run 起草跟进",
      replyText: `已为 ${customerId} 起草跟进草稿（预演，未落库），审批单号 ${draft.approvalId}，等待具名审批人签字。我不会直接改动任何正式数据。`,
      toolCalls,
      dryRuns,
    };
    return NextResponse.json(payload);
  }

  return badRequest(
    "未知的语音工具名。可用工具：query_tickets（案情勘察，只读）、search_policy（制度检索，只读）、draft_followup（审批预演草稿，预演）。",
  );
}
