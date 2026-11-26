/**
 * channels/types.ts —— 4 渠道统一接入网关的共享类型（Day 32）
 * 溯源：ADR-004（新入口只准经门面接 core-engine）、ADR-005（类型显式、文件 150~400 行）、
 *      AGENTS.md 三色权限边界（渠道网关只做验签/识别/归一/上下文串联，不新增任何写权限）。
 * 边界：
 * - 渠道网关不产生任何新的业务动作：绿区只读勘察 + 黄区审批「挂起登记」，打款物理不存在；
 * - 审批状态唯一真源 = approval_audit_logs（只增不改），网关层状态是派生缓存。
 */

/* ================================================================
 * 一、渠道与信封
 * ================================================================ */

/** 统一接入的 4 个入站通道 */
export type ChannelId = "web" | "im" | "email" | "h5";

/** 企业 IM 平台细分（企微 / 飞书共用 im 通道，验签口径一致、信封字段区分） */
export type ImPlatform = "wecom" | "feishu";

export const CHANNEL_IDS: readonly ChannelId[] = ["web", "im", "email", "h5"];

/** 渠道元信息（GET meta 下发；demo 模式才携带演示签名密钥） */
export interface ChannelMeta {
  id: ChannelId;
  /** 展示名 */
  label: string;
  /** 真实接入方式说明（页面展示用） */
  accessNote: string;
  /** 签名模式：demo = 演示密钥（可下发页面联调）；production = 环境变量接管（密钥绝不下发） */
  mode: "demo" | "production";
  /** 演示签名密钥（仅 mode=demo 时下发；生产环境该字段不存在） */
  demoSecret?: string;
}

/** 归一化后的入站消息（验签通过后的唯一形态，路由进 core-engine 的输入） */
export interface NormalizedMessage {
  channel: ChannelId;
  /** 仅 im 通道：企微 / 飞书 */
  platform?: ImPlatform;
  /** 租户 ID（Day 27 多租户；fail-closed 校验） */
  tenantId: string;
  /** 渠道侧原始用户标识（企微 userid / 邮箱地址 / H5 设备号 / Web 会话标识） */
  channelUserId: string;
  /** 归一化正文（邮件 = 正文优先、主题兜底） */
  text: string;
  /** 邮件主题（仅 email 通道） */
  subject?: string;
}

/** 信封归一结果（fail-closed：不合法一律拒绝，绝不猜测兜底） */
export type ParsedEnvelope =
  | { ok: true; msg: NormalizedMessage }
  | { ok: false; status: number; error: string };

/* ================================================================
 * 二、跨端统一线程（网关层的上下文串联核心）
 * ================================================================ */

export interface ThreadMessage {
  seq: number;
  role: "user" | "assistant";
  channel: ChannelId;
  platform?: ImPlatform;
  text: string;
  /** epoch ms */
  at: number;
}

/** 挂起的 / 已决的审批登记（网关层派生缓存；状态真源在 approval_audit_logs） */
export interface ThreadApproval {
  approvalId: string;
  ticketId: string;
  title: string;
  summary: string;
  amountYuan: number;
  createdAt: number;
  /** 已批准信息（approval_audit_logs 查得）；null = 仍在等待具名审批人 */
  decided: { approver: string; at: number } | null;
}

export interface ChannelSeen {
  channel: ChannelId;
  platform?: ImPlatform;
  lastAt: number;
}

export interface ThreadView {
  threadId: string;
  tenantId: string;
  /** 跨端统一身份（渠道别名解析后的具名用户） */
  userKey: string;
  messages: ThreadMessage[];
  approvals: ThreadApproval[];
  channelsSeen: ChannelSeen[];
}

/* ================================================================
 * 三、网关层确定性小票（跨端同步的可视证据）
 * ================================================================ */

export interface InspectedTicket {
  ticketId: string;
  customerId: string;
  title: string;
  department: string;
  amountYuan: number;
  status: string;
  fin001Triggered: boolean;
}

export type ChannelReceipt =
  | { kind: "ticket_inspect"; tickets: InspectedTicket[] }
  | {
      kind: "fin001_approval";
      approvalId: string;
      ticketId: string;
      title: string;
      amountYuan: number;
      /** 本次是否为新登记（false = 该工单此前已有挂起审批单） */
      isNew: boolean;
    }
  | {
      kind: "approval_status";
      lines: {
        approvalId: string;
        title: string;
        status: "pending" | "approved";
        approver?: string;
        decidedAt?: number;
      }[];
      /** 数据库暂不可达时的如实降级说明（绝不硬凑状态） */
      degradedNote?: string;
    }
  | {
      kind: "context_sync";
      threadId: string;
      userKey: string;
      channels: ChannelSeen[];
      pendingCount: number;
      approvedCount: number;
    };

/* ================================================================
 * 四、Webhook 出站响应
 * ================================================================ */

export interface ChannelNotice {
  level: "info" | "warn" | "fallback";
  text: string;
}

export interface ChannelWebhookResponse {
  ok: true;
  channel: ChannelId;
  platform?: ImPlatform;
  thread: ThreadView;
  /** 引擎正文（core-engine 经门面返回的全文） */
  engineText: string;
  /** 引擎标识（如 core-engine / core:chat） */
  engineTag: string;
  notices: ChannelNotice[];
  /** 网关层确定性小票（跨端同步证据） */
  receipts: ChannelReceipt[];
}
