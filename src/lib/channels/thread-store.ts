/**
 * channels/thread-store.ts —— 跨端统一线程存储（Day 32 的上下文串联核心）
 * 溯源：联调目标「跨 4 端上下文 100% 同步」——同一租户 + 统一身份只有一条 canonical 线程；
 *      渠道别名解析（企微 userid / 邮箱地址 / H5 设备号 → 同一具名用户）；
 *      Day 6 沙盒先例：进程内状态挂 globalThis，dev 热更不丢。
 * 边界：
 * - 线程只存「对话 + 审批登记」这类派生数据，不是审计日志（审计在 DB 只增不改表）；
 * - 审批状态唯一真源 = approval_audit_logs，本存储的 decided 字段只是查询后的缓存镜像；
 * - 单线程消息上限 200 条（超限丢最旧），审批登记按工单号去重（一单一挂起，绝不重复挂起）。
 */

import type { ChannelId, ChannelSeen, ImPlatform, NormalizedMessage, ThreadApproval, ThreadMessage, ThreadView } from "@/lib/channels/types";

/* ================================================================
 * 一、跨端身份解析（渠道别名 → 统一具名身份）
 * 演示别名表：联调模拟器的 4 个通道演示身份都解析为「林总」；
 * 未登记的标识按原样收敛（同一标识在多渠道出现即天然同线程）。
 * ================================================================ */

const IDENTITY_ALIASES: Record<string, string> = {
  "web-linzong": "林总",
  "wecom-linzong": "林总",
  "feishu-linzong": "林总",
  "lin.zong@xingchen-demo.com": "林总",
  "h5-linzong": "林总",
};

export function resolveCanonicalUser(channelUserId: string): string {
  const direct = IDENTITY_ALIASES[channelUserId];
  if (direct) return direct;
  // 邮箱地址统一小写后再查一次（大小写别名归一）
  const lower = IDENTITY_ALIASES[channelUserId.toLowerCase()];
  if (lower) return lower;
  return channelUserId.slice(0, 64);
}

/* ================================================================
 * 二、线程存储（globalThis 单例，dev 热更不丢、重启清零并如实重建）
 * ================================================================ */

export interface ChannelThread {
  threadId: string;
  tenantId: string;
  userKey: string;
  messages: ThreadMessage[];
  /** 工单号 → 审批登记（一单一挂起） */
  approvals: Map<string, ThreadApproval>;
  channelsSeen: Map<string, ChannelSeen>;
  nextSeq: number;
}

const STORE_KEY = Symbol.for("workbot.channels.thread-store");
interface StoreShape {
  threads: Map<string, ChannelThread>;
  approvalSeq: number;
}
function store(): StoreShape {
  const g = globalThis as typeof globalThis & Record<symbol, StoreShape>;
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = { threads: new Map(), approvalSeq: 0 };
  }
  return g[STORE_KEY];
}

const MESSAGES_CAP = 200;

export function buildThreadId(tenantId: string, userKey: string): string {
  return `T-${tenantId}::${userKey}`;
}

export function getOrCreateThread(tenantId: string, userKey: string): ChannelThread {
  const threadId = buildThreadId(tenantId, userKey);
  const existing = store().threads.get(threadId);
  if (existing) return existing;
  const thread: ChannelThread = {
    threadId,
    tenantId,
    userKey,
    messages: [],
    approvals: new Map(),
    channelsSeen: new Map(),
    nextSeq: 1,
  };
  store().threads.set(threadId, thread);
  return thread;
}

export function getThreadIfPresent(tenantId: string, userKey: string): ChannelThread | null {
  return store().threads.get(buildThreadId(tenantId, userKey)) ?? null;
}

/** 渠道身份归一 + 取线程（入口统一走这里，别名解析不外泄） */
export function resolveThread(msg: NormalizedMessage): ChannelThread {
  const userKey = resolveCanonicalUser(msg.channelUserId);
  return getOrCreateThread(msg.tenantId, userKey);
}

function channelKey(channel: ChannelId, platform?: ImPlatform): string {
  return platform ? `${channel}:${platform}` : channel;
}

export function recordChannelSeen(thread: ChannelThread, channel: ChannelId, platform?: ImPlatform): void {
  const key = channelKey(channel, platform);
  const prev = thread.channelsSeen.get(key);
  const seen: ChannelSeen = { channel, ...(platform ? { platform } : {}), lastAt: Date.now() };
  thread.channelsSeen.set(key, prev ? { ...prev, lastAt: seen.lastAt } : seen);
}

export function appendUserMessage(thread: ChannelThread, msg: NormalizedMessage): ThreadMessage {
  recordChannelSeen(thread, msg.channel, msg.platform);
  return pushMessage(thread, {
    role: "user",
    channel: msg.channel,
    ...(msg.platform ? { platform: msg.platform } : {}),
    text: msg.text,
  });
}

export function appendAssistantMessage(
  thread: ChannelThread,
  channel: ChannelId,
  text: string,
  platform?: ImPlatform,
): ThreadMessage {
  return pushMessage(thread, {
    role: "assistant",
    channel,
    ...(platform ? { platform } : {}),
    text: text.slice(0, 4000),
  });
}

function pushMessage(thread: ChannelThread, base: Omit<ThreadMessage, "seq" | "at">): ThreadMessage {
  const message: ThreadMessage = { ...base, seq: thread.nextSeq++, at: Date.now() };
  thread.messages.push(message);
  if (thread.messages.length > MESSAGES_CAP) {
    thread.messages.splice(0, thread.messages.length - MESSAGES_CAP);
  }
  return message;
}

/** 最近 N 轮对话（core-engine history 形态），按 seq 升序 */
export function recentHistory(thread: ChannelThread, maxTurns = 6): { role: "user" | "assistant"; content: string }[] {
  return thread.messages
    .slice(-maxTurns * 2)
    .map((m) => ({ role: m.role, content: m.text }));
}

/* ================================================================
 * 三、FIN-001 审批登记（一单一挂起，去重键 = 工单号）
 * ================================================================ */

export function nextApprovalId(): string {
  const s = store();
  s.approvalSeq += 1;
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ymd = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const hms = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  // 带时分秒：进程重启后序号归零也不会与审计库历史单号撞车（approval_audit_logs 只增不改）
  return `AP-CH-${ymd}-${hms}-${String(s.approvalSeq).padStart(3, "0")}`;
}

export interface RegisterOutcome {
  approval: ThreadApproval;
  isNew: boolean;
}

/** 按「发起渠道 + 工单号」登记挂起审批：同工单已挂起则复用原单（绝不重复挂起） */
export function registerPendingApproval(
  thread: ChannelThread,
  entry: { ticketId: string; title: string; summary: string; amountYuan: number },
): RegisterOutcome {
  const existing = thread.approvals.get(entry.ticketId);
  if (existing) return { approval: existing, isNew: false };
  const approval: ThreadApproval = {
    approvalId: nextApprovalId(),
    ticketId: entry.ticketId,
    title: entry.title,
    summary: entry.summary,
    amountYuan: entry.amountYuan,
    createdAt: Date.now(),
    decided: null,
  };
  thread.approvals.set(entry.ticketId, approval);
  return { approval, isNew: true };
}

export function listApprovals(thread: ChannelThread): ThreadApproval[] {
  return [...thread.approvals.values()].sort((a, b) => a.createdAt - b.createdAt);
}

/** 把 DB 查得的批准结果镜像回线程缓存（真源仍在 approval_audit_logs） */
export function mirrorApprovalDecision(ticketId: string, decided: { approver: string; at: number } | null): void {
  for (const thread of store().threads.values()) {
    const approval = thread.approvals.get(ticketId);
    if (approval && !approval.decided && decided) {
      approval.decided = decided;
    }
  }
}

export function toThreadView(thread: ChannelThread): ThreadView {
  return {
    threadId: thread.threadId,
    tenantId: thread.tenantId,
    userKey: thread.userKey,
    messages: [...thread.messages],
    approvals: listApprovals(thread),
    channelsSeen: [...thread.channelsSeen.values()].sort((a, b) => a.lastAt - b.lastAt),
  };
}
