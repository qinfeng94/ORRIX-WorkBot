/**
 * channels/orchestrator.ts —— 渠道网关编排层（Day 32）
 * 溯源：ADR-004「新入口只准经门面进 core-engine」——引擎调用唯一走 runWorkbot(flow=chat)；
 *      联调目标「跨 4 端上下文与审批状态 100% 同步」——同步的证据全部来自确定性小票：
 *      工单勘察（绿区只读工具）+ FIN-001 审批登记（挂起不落库打款物理不存在）+
 *      审批状态查询（唯一真源 approval_audit_logs）+ 跨端上下文小票（统一线程）。
 * 边界：
 * - 网关层不新增任何业务写权限：只读勘察 + 挂起登记 + 状态查询，批准动作仍由
 *   既有 /api/chat/approve 完成（具名审批人 + 幂等 + 审计留痕），AI 永远不审批；
 * - 状态查询失败如实降级（degradedNote），绝不硬凑「已批准 / 未批准」。
 */

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { approvalAuditLogs } from "@/db/schema";
import { TOOL_REGISTRY } from "@/lib/chat-engine";
import { loadTenantConfig, type TenantConfig } from "@/lib/ontology/tenant-config";
import { runWorkbot } from "@/lib/workbot/facade";
import {
  appendAssistantMessage,
  appendUserMessage,
  getThreadIfPresent,
  listApprovals,
  mirrorApprovalDecision,
  recentHistory,
  registerPendingApproval,
  resolveThread,
  toThreadView,
  type ChannelThread,
} from "@/lib/channels/thread-store";
import type {
  ChannelNotice,
  ChannelReceipt,
  ChannelWebhookResponse,
  InspectedTicket,
  NormalizedMessage,
  ThreadApproval,
  ThreadView,
} from "@/lib/channels/types";

/** 审批状态意图：用户在问「批了吗 / 审批状态 / 进度」时才追加状态小票 */
const APPROVAL_STATUS_INTENT = /批|审|状态|进度/;

/** 工单 / 客户引用识别：CUST-xxxx（确定性正则，不经大模型） */
const CUSTOMER_REF_PATTERN = /CUST-\d{3,6}/i;

export class TenantNotFoundError extends Error {
  constructor(tenantId: string) {
    super(`租户不存在或未注册：${tenantId}`);
    this.name = "TenantNotFoundError";
  }
}

/** 校验租户（Day 27 多租户 fail-closed），并返回页面需要的审批人名单 */
export async function assertTenant(tenantId: string): Promise<TenantConfig> {
  try {
    return await loadTenantConfig(tenantId);
  } catch {
    throw new TenantNotFoundError(tenantId);
  }
}

/* ================================================================
 * 一、主编排：入站消息 → 线程串联 → core-engine → 确定性小票
 * ================================================================ */

export async function handleInboundMessage(msg: NormalizedMessage): Promise<ChannelWebhookResponse> {
  // 1) 租户校验（fail-closed）
  await assertTenant(msg.tenantId);

  // 2) 跨端统一线程：同一租户 + 统一身份，任何渠道都汇入同一条 canonical 线程
  const thread = resolveThread(msg);
  appendUserMessage(thread, msg);

  const receipts: ChannelReceipt[] = [];

  // 3) 绿区只读勘察：识别 CUST-xxxx 引用即查老 ERP 仿真快照（物理只读）
  const customerId = CUSTOMER_REF_PATTERN.exec(msg.text)?.[0]?.toUpperCase();
  const inspected = inspectTickets(customerId);
  if (inspected.length > 0) {
    receipts.push({ kind: "ticket_inspect", tickets: inspected });
  }

  // 4) FIN-001 审批登记：命中即挂起（一单一挂起），批准动作仍归具名审批人
  for (const ticket of inspected) {
    if (!ticket.fin001Triggered) continue;
    const { approval, isNew } = registerPendingApproval(thread, {
      ticketId: ticket.ticketId,
      title: `FIN-001 强制人工审批 · ${ticket.ticketId}（${ticket.department} 单笔 ¥${ticket.amountYuan.toLocaleString("zh-CN")}）`,
      summary: ticket.title,
      amountYuan: ticket.amountYuan,
    });
    receipts.push({
      kind: "fin001_approval",
      approvalId: approval.approvalId,
      ticketId: approval.ticketId,
      title: approval.title,
      amountYuan: approval.amountYuan,
      isNew,
    });
  }

  // 5) core-engine（经门面，ADR-004 纪律）：带最近对话历史，跨端上下文天然连续
  const result = await runWorkbot({
    flow: "chat",
    question: msg.text,
    history: recentHistory(thread).slice(0, -1),
    ...(customerId ? { refs: { customerId } } : {}),
    meta: { engine: "core-engine" },
  });

  const notices: ChannelNotice[] = result.notices.map((n) => ({ level: n.level, text: n.text }));

  // 6) 审批状态小票：问「批了吗」时，用 DB 唯一真源回最新状态
  let degradedNote: string | undefined;
  const approvals = listApprovals(thread);
  if (approvals.length > 0 && APPROVAL_STATUS_INTENT.test(msg.text)) {
    const refreshed = await refreshApprovalStatuses(approvals);
    degradedNote = refreshed.degradedNote;
    receipts.push({
      kind: "approval_status",
      lines: refreshed.approvals.map((a) => ({
        approvalId: a.approvalId,
        title: a.title,
        status: a.decided ? ("approved" as const) : ("pending" as const),
        ...(a.decided ? { approver: a.decided.approver, decidedAt: a.decided.at } : {}),
      })),
      ...(degradedNote ? { degradedNote } : {}),
    });
  }

  // 7) 跨端上下文小票：同步的直接证据（哪些渠道汇入过、挂起 / 已批准数量）
  const all = listApprovals(thread);
  receipts.push({
    kind: "context_sync",
    threadId: thread.threadId,
    userKey: thread.userKey,
    channels: [...thread.channelsSeen.values()].sort((a, b) => a.lastAt - b.lastAt),
    pendingCount: all.filter((a) => !a.decided).length,
    approvedCount: all.filter((a) => a.decided !== null).length,
  });

  // 8) 助手侧落一条紧凑摘要（跨端后续追问的历史连续性）
  appendAssistantMessage(thread, msg.channel, result.text, msg.platform);

  return {
    ok: true,
    channel: msg.channel,
    ...(msg.platform ? { platform: msg.platform } : {}),
    thread: toThreadView(thread),
    engineText: result.text,
    engineTag: result.meta.engine || "core-engine",
    notices,
    receipts,
  };
}

/* ================================================================
 * 二、内部工具：勘察 + 状态真源查询
 * ================================================================ */

/** 绿区只读勘察（老 ERP 仿真快照）；无引用或工具异常返回空数组（不中断编排） */
function inspectTickets(customerId: string | undefined): InspectedTicket[] {
  if (!customerId) return [];
  try {
    const inspect = TOOL_REGISTRY.inspect_case_bundle;
    const raw: unknown = inspect.run({ department: "", customerId });
    if (raw === null || typeof raw !== "object" || !("tickets" in raw)) return [];
    const tickets = (raw as { tickets: unknown }).tickets;
    if (!Array.isArray(tickets)) return [];
    return tickets.flatMap((t) => {
      if (t === null || typeof t !== "object") return [];
      const ticket = t as {
        ticketId?: unknown;
        customerId?: unknown;
        title?: unknown;
        department?: unknown;
        amountCny?: unknown;
        status?: unknown;
        fin001Triggered?: unknown;
      };
      if (typeof ticket.ticketId !== "string" || typeof ticket.customerId !== "string") return [];
      return [
        {
          ticketId: ticket.ticketId,
          customerId: ticket.customerId,
          title: typeof ticket.title === "string" ? ticket.title : "",
          department: typeof ticket.department === "string" ? ticket.department : "",
          amountYuan: typeof ticket.amountCny === "number" ? ticket.amountCny : 0,
          status: typeof ticket.status === "string" ? ticket.status : "",
          fin001Triggered: ticket.fin001Triggered === true,
        },
      ];
    });
  } catch {
    return [];
  }
}

/**
 * 审批状态真源查询：approval_audit_logs（只增不改）按 approvalId 查放行凭据。
 * 查得即镜像回线程缓存；查询失败如实降级，绝不硬凑状态。
 */
async function refreshApprovalStatuses(approvals: ThreadApproval[]): Promise<{
  approvals: ThreadApproval[];
  degradedNote?: string;
}> {
  const pending = approvals.filter((a) => !a.decided);
  if (pending.length === 0) return { approvals };
  try {
    const db = getDb();
    for (const approval of pending) {
      const rows = await db
        .select({ approver: approvalAuditLogs.approver, createdAt: approvalAuditLogs.createdAt })
        .from(approvalAuditLogs)
        .where(eq(approvalAuditLogs.ticketNo, approval.approvalId))
        .limit(1);
      if (rows.length > 0) {
        const decided = { approver: rows[0].approver, at: rows[0].createdAt.getTime() };
        approval.decided = decided;
        mirrorApprovalDecision(approval.approvalId, decided);
      }
    }
    return { approvals };
  } catch {
    return {
      approvals,
      degradedNote: "审计库暂不可达，审批状态以网关挂起登记为准（待人工核对），绝不硬凑结论。",
    };
  }
}

/** GET thread 用：只刷新状态并回线程视图（不产生任何新消息 / 小票） */
export async function getThreadView(tenantId: string, userKey: string): Promise<ThreadView | null> {
  const thread: ChannelThread | null = getThreadIfPresent(tenantId, userKey);
  if (!thread) return null;
  const approvals = listApprovals(thread);
  await refreshApprovalStatuses(approvals);
  return toThreadView(thread);
}
