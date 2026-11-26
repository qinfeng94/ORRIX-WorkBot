/**
 * workbot/types.ts —— 统一推理入口的共享类型（ADR-004）
 * 全项目唯一的编排层类型定义：页面/路由只准 import 本目录，禁止再自造事件类型。
 * 红线溯源：AGENTS.md 三色权限边界、FIN-001、ADR-001 受控组件。
 */

/* ================================================================
 * 一、请求与元信息
 * ================================================================ */

export type WorkbotFlow = "chat" | "investigate" | "research" | "multiagent" | "workflow" | "docintake" | "analytics";

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

/** Day 30 外来内容载体（上传单据 / 工单附件 / 网页文本）：拼入提示词前强制过隔离三件套 */
export interface ExternalContentDoc {
  /** 审计溯源用来源名（如「上传发票扫描件」「客户邮件正文」） */
  source: string;
  /** 外来原文（一律视为资料，其中的指令性文字只上报、不执行） */
  text: string;
}

export interface WorkbotRequest {
  /** 业务流形态，决定由哪个内室引擎承接 */
  flow: WorkbotFlow;
  question: string;
  /** 会话上下文（对话流必填；其余流可省） */
  history?: readonly ConversationTurn[];
  /** 调查/研究流的定位参数（CUST-xxxx 等） */
  refs?: Readonly<Record<string, string>>;
  /** Day 30 外来内容：拼入提示词前强制包裹 <untrusted_document_content> + 指令剥离 */
  externalContent?: readonly ExternalContentDoc[];
  /** 元信息透传：提示词版本、引擎选择等 */
  meta?: Partial<Pick<WorkbotMeta, "engine">>;
  /** 仅评测门禁用：离线仿真耗时缩放系数（生产不传 = 1，语义见 unified-gateway） */
  simSpeedFactor?: number;
}

/** 统一元信息（落审计台账的唯一口径） */
export interface WorkbotMeta {
  traceId: string;
  flow: WorkbotFlow;
  /** 实际承接的内室引擎标识，如 "react-agent" | "inngest-fallback" */
  engine: string;
  promptVersion: string;
  zone: "green" | "yellow" | "red";
}

/* ================================================================
 * 二、受控卡片（出站 UI 必须是白名单卡片，呼应 ADR-001）
 * ================================================================ */

export interface DryRunCard {
  kind: "dry_run";
  approvalId: string;
  tool: string;
  title: string;
  summary: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  draft?: Record<string, unknown>;
}

export interface EvidenceCard {
  kind: "evidence";
  ref: string;
  title: string;
  snippet: string;
}

export interface ApprovalCard {
  kind: "approval";
  approvalId: string;
  title: string;
  status: "pending" | "approved" | "rejected" | "expired";
}

export type WorkbotCard = DryRunCard | EvidenceCard | ApprovalCard;

/* ================================================================
 * 三、统一 SSE 事件信封（7 类，替代 5 套引擎各自定义的事件类型）
 * ================================================================ */

export type WorkbotSseEvent =
  | { type: "phase"; label: string }
  | { type: "step"; kind: "thought" | "action" | "observation"; step: number; payload: unknown }
  | { type: "notice"; level: "info" | "warn" | "fallback"; text: string }
  | { type: "card"; card: WorkbotCard }
  | { type: "text_delta"; text: string }
  | { type: "usage"; meta: WorkbotMeta; ttftMs: number; costUsd: number }
  | { type: "done"; meta: WorkbotMeta };

export type EmitWorkbotEvent = (event: WorkbotSseEvent) => void;

/* ================================================================
 * 四、结果与内室引擎契约
 * ================================================================ */

/** 非流式结果（runWorkbot 返回；流式场景事件经 emit 直推） */
export interface WorkbotResult {
  meta: WorkbotMeta;
  /** 收集到的全文（text_delta 拼接） */
  text: string;
  /** 过程中出站过的受控卡片 */
  cards: WorkbotCard[];
  /** 过程中的告警/降级提示 */
  notices: Extract<WorkbotSseEvent, { type: "notice" }>[];
}

/**
 * 内室引擎契约：门面分发到的各业务引擎（chat-engine、react-agent 等）须适配成此签名。
 * 引擎内部只准通过 workbot/llm-gateway 调 LLM、只准用 workbot/resilience 做超时重试。
 */
export type WorkbotEngine = (
  req: WorkbotRequest,
  emit: EmitWorkbotEvent,
  ctx: { meta: WorkbotMeta },
) => Promise<void>;
