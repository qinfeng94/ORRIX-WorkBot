/**
 * pipeline.ts —— Day 12 四代理客服专班流水线编排（仅限服务端使用）
 * 溯源：04 号文档三色权限边界（分诊/调查只读；起草只出草稿；质检只裁定不代笔）；
 *      AGENTS.md 业务红线（FIN-001 / 红区严禁自动打款 / 日志只增不改）。
 * 编排：
 *   入口护栏 → ① 分诊员（轻量快模型，省 ~65% 成本）→ ② 调查员（复用 Day 11 探针，$0 费用；
 *   涉及华东区物流报销 / 出现 EWB: 编号时，经 a2a-client 以 2500ms 超时熔断跨组织委派外部
 *   华东物流 A2A 代理验真运单，作为紫色 Span 记入瀑布图：真单放行 / 假单转人工 / 超时降级不崩）
 *   → ③ 起草员 ⇄ ④ 独立质检官（发现漏写 [DOC-XX §X.X] 引文或越权承诺必须打回，
 *      最多返工 2 次，超限自动转人工）→ 出口护栏 → 终稿（仍是草稿，放行永远归人）。
 * 护栏：
 * - 入口：恶意注入毫秒级正则拦截（$0 费用），命中即拒绝进入任何岗位；
 * - 出口：拦截「承诺自动退还 >¥50,000」与明文手机号 / 身份证号（PII 就地脱敏）。
 * 留痕：每个岗位 / 护栏步骤记一条 AgentSpan（耗时 / 费用 / Token / 状态），
 *      由 API 路由在流结束后写入 agent_traces + agent_spans（只增不改触发器）。
 */

import {
  runInvestigation,
  type InvestigationConclusion,
} from "@/lib/ai/react-agent";
import { estimateTokens } from "@/lib/memory";
import {
  A2A_CIRCUIT_THRESHOLD,
  A2A_TIMEOUT_MS,
  delegateEwbVerify,
  detectA2aNeed,
  type A2aVerifyResult,
} from "./a2a-client";
import {
  draftEnvelopeSchema,
  investigationEnvelopeSchema,
  newEnvelopeId,
  parseEnvelope,
  qaVerdictEnvelopeSchema,
  ROLE_LABELS,
  triageEnvelopeSchema,
  type DraftEnvelope,
  type InvestigationEnvelope,
  type PipelineRole,
  type QaVerdictEnvelope,
  type TriageEnvelope,
} from "./envelopes";
import {
  FIN001_THRESHOLD_CNY,
  runInputGuard,
  runOutputGuard,
} from "./guardrails";

/* ================================================================
 * 一、成本口径（离线高仿真定价；与 llm-client 旗舰档同口径对照）
 * ================================================================ */

/** 旗舰档定价（与 lib/llm MODEL_REGISTRY.claude 一致：$3 / $15 每百万 Token） */
const FLAGSHIP_PRICE = { priceInPerM: 3, priceOutPerM: 15 } as const;

/**
 * 分诊员轻量快档定价：约为旗舰的 1/3（$1 / $5 每百万 Token）。
 * 同 Token 口径下固定节省 1 - 1/3 ≈ 66.7%，对应「轻量快模型省 65% 成本」的需求量级；
 * 页面展示的节省百分比按实际 Token 组成实时计算，不做硬编码。
 */
const TRIAGE_LIGHT_PRICE = { priceInPerM: 1, priceOutPerM: 5 } as const;

function costUsdOf(
  price: { priceInPerM: number; priceOutPerM: number },
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens / 1e6) * price.priceInPerM +
    (outputTokens / 1e6) * price.priceOutPerM
  );
}

/* ================================================================
 * 二、Span 与 SSE 事件（页面瀑布图与直播的数据契约）
 * ================================================================ */

/** Span 主体：四个岗位 + 两个护栏位 + 跨组织 A2A 验真位（瀑布图每行一条） */
export type SpanRole = PipelineRole | "guard_input" | "guard_output" | "external_a2a";

export const SPAN_ROLE_LABELS: Record<SpanRole, string> = {
  ...ROLE_LABELS,
  guard_input: "入口护栏（注入拦截）",
  guard_output: "出口护栏（承诺 / PII 拦截）",
  external_a2a: "外部 A2A 物流验真（华东 · 跨组织委派）",
};

export type SpanStatus =
  | "ok"
  | "rejected"
  | "rewritten"
  | "escalated"
  | "blocked";

export interface AgentSpan {
  /** 流水线内递增序号（瀑布图行序） */
  seq: number;
  role: SpanRole;
  /** 第几次尝试（起草 / 质检的返工轮次；护栏与分诊恒为 1） */
  attempt: number;
  label: string;
  status: SpanStatus;
  /** 本步耗时（毫秒） */
  durationMs: number;
  /** 本步费用（美元） */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** 一句话结果说明（不含 PII 明文） */
  detail: string;
}

export interface QaIssue {
  code: "missing_doc_citation" | "unauthorized_auto_refund" | "pii_leak" | "fin001_not_mentioned";
  detail: string;
}

export type MultiAgentSseEvent =
  | { type: "trace_start"; traceId: string }
  | {
      type: "guard_input";
      blocked: boolean;
      patterns: string[];
      elapsedMs: number;
      costUsd: number;
    }
  | { type: "stage_start"; role: SpanRole; attempt: number; label: string }
  | {
      type: "stage_result";
      role: SpanRole;
      attempt: number;
      status: SpanStatus;
      summary: string;
      span: AgentSpan;
    }
  | {
      type: "envelope";
      /** 信封类型（页面按类型着色展示 Zod 校验后的结构化 JSON） */
      envelopeKind: "triage" | "investigation" | "draft" | "qa_verdict";
      payload: unknown;
    }
  | {
      type: "investigator_activity";
      kind: "thought" | "action" | "observation" | "circuit_break";
      step: number;
      text: string;
    }
  | { type: "qa_reject"; attempt: number; issues: QaIssue[]; willRewrite: boolean }
  | { type: "escalate_human"; reason: string }
  | {
      type: "final_result";
      status: "completed" | "escalated" | "blocked";
      /** 终稿文本（已过出口护栏脱敏；escalated 时为被打回的问题草稿） */
      draftText: string | null;
      citations: string[];
      evidenceChain: InvestigationEnvelope["evidenceChain"] | null;
      fin001Triggered: boolean;
      reworkCount: number;
      escalateReason: string | null;
      /** 证据不足时跳过起草直接转人工的说明 */
      skippedDraftingReason: string | null;
    }
  | {
      type: "trace_done";
      traceId: string;
      totalDurationMs: number;
      totalCostUsd: number;
      /** 分诊员轻量快档相对旗舰档的节省百分比（同 Token 口径实时计算） */
      triageSavingsPercent: number;
      spans: AgentSpan[];
    };

type EmitEvent = (event: MultiAgentSseEvent) => void;

/* ================================================================
 * 三、可变流水线状态（Span 收集器）
 * ================================================================ */

interface PipelineState {
  seq: number;
  spans: AgentSpan[];
}

function recordSpan(state: PipelineState, span: Omit<AgentSpan, "seq">): AgentSpan {
  const full: AgentSpan = { ...span, seq: state.seq + 1 };
  state.seq += 1;
  state.spans.push(full);
  return full;
}

/* ================================================================
 * 四、岗位①：分诊员（轻量快模型）
 * ================================================================ */

/** 从文本提取金额（¥ / 元口径，支持千分位） */
function extractAmountsCny(text: string): number[] {
  const amounts: number[] = [];
  const re = /[¥￥]\s*([0-9][\d,]*(?:\.\d+)?)|([0-9][\d,]*(?:\.\d+)?)\s*(?:元|块)/g;
  for (const m of text.matchAll(re)) {
    const n = Number((m[1] ?? m[2] ?? "").replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) amounts.push(n);
  }
  return amounts;
}

function classifyCategory(question: string): TriageEnvelope["category"] {
  if (/重复扣款|扣款|退款|错账|对公账户|费用/.test(question)) return "finance";
  if (/投诉|客诉|赔偿|致歉|破损/.test(question)) return "complaint";
  if (/超期|物流|干线|入仓|仓储|海运/.test(question)) return "logistics";
  return "generic";
}

/**
 * 分诊员：轻量快模型档（离线高仿真为确定性规则分类，定价按轻量档计）。
 * 只做只读分类与派工，不判定 FIN-001（只标记风险），不派任何写操作。
 */
function runTriage(state: PipelineState, emit: EmitEvent, question: string): TriageEnvelope {
  const t0 = Date.now();
  emit({
    type: "stage_start",
    role: "triage",
    attempt: 1,
    label: SPAN_ROLE_LABELS.triage,
  });

  const customerId = question.match(/CUST-\d{3,}/)?.[0] ?? null;
  const ticketId = question.match(/TCK-[A-Z]?\d+/)?.[0] ?? null;
  const category = classifyCategory(question);
  const amounts = extractAmountsCny(question);
  // FIN-001 风险标记：提问中出现超过 ¥50,000 的金额（「超过」才触发，等于不触发）
  const fin001Risk = amounts.some((n) => n > FIN001_THRESHOLD_CNY);
  const priority: TriageEnvelope["priority"] =
    fin001Risk || category === "complaint" ? "high" : "normal";

  // 轻量快模型 Token 口径：输入 = 原始提问 + 分诊指令骨架；输出 = 派工单要素
  const inputTokens =
    estimateTokens(question) + estimateTokens("分诊指令：分类 / 客户号 / 工单号 / 金额红线标记 / 派工提示");
  const hint =
    `按「先证据后结论」调查该${category === "generic" ? "综合" : category}线索` +
    (customerId ? `（客户 ${customerId}` : "") +
    (ticketId ? `，工单 ${ticketId}` : "") +
    (fin001Risk ? "；疑似触发 FIN-001，须核实拆单合并口径" : "") +
    "。处置建议全部归人，AI 不打款不审批。";
  const outputTokens = estimateTokens(hint);
  const costUsd = costUsdOf(TRIAGE_LIGHT_PRICE, inputTokens, outputTokens);

  const envelope: TriageEnvelope = parseEnvelope(
    triageEnvelopeSchema,
    "分诊员派工信封",
    {
      envelopeId: newEnvelopeId(),
      from: "triage",
      to: "investigator",
      createdAt: new Date().toISOString(),
      category,
      customerId,
      ticketId,
      priority,
      fin001Risk,
      summaryHint: hint,
      tokensUsed: inputTokens + outputTokens,
      costUsd,
    },
  );

  const span = recordSpan(state, {
    role: "triage",
    attempt: 1,
    label: "分诊员 · 轻量快模型分类派工",
    status: "ok",
    durationMs: Math.max(1, Date.now() - t0),
    costUsd,
    inputTokens,
    outputTokens,
    detail: `分类 ${category} · 优先级 ${priority}${fin001Risk ? " · FIN-001 风险标记" : ""}`,
  });
  emit({ type: "envelope", envelopeKind: "triage", payload: envelope });
  emit({
    type: "stage_result",
    role: "triage",
    attempt: 1,
    status: "ok",
    summary: span.detail,
    span,
  });
  return envelope;
}

/* ================================================================
 * 五、岗位②：调查员（复用 Day 11 探针，$0 模型费用）
 * ================================================================ */

/** 调查员岗位产出：结论信封（null = 证据不足或跨组织验真未通过）+ A2A 验真结果 + 转人工理由 */
interface InvestigatorOutcome {
  envelope: InvestigationEnvelope | null;
  a2a: A2aVerifyResult | null;
  escalateReason: string | null;
}

/** 调查员岗位可选项（A2A 跨组织委派参数，由 API 路由透传） */
export interface InvestigatorOptions {
  /** 页面「模拟外部代理超时」开关：外部代理延迟应答，触发 2500ms 熔断演习 */
  simulateExternalTimeout?: boolean;
  /** 外部代理基址（从请求 origin 传入，dev 任意端口可用） */
  a2aBaseUrl?: string;
}

/** A2A 验真未通过时的转人工理由（按结果类型区分口径，绝不硬凑放行） */
function a2aEscalateReason(a: A2aVerifyResult): string {
  switch (a.outcome) {
    case "verified_forged":
      return `外部华东物流 A2A 代理验真判定运单 ${a.ewbId ?? ""} 为伪造，按制度不放行、不起草，转人工核处。`;
    case "unregistered":
      return `外部物流代理承运商注册表查无运单 ${a.ewbId ?? ""}，跨组织验真未通过，转人工核实编号。`;
    case "timeout_degraded":
      return `外部华东物流 A2A 代理 ${String(A2A_TIMEOUT_MS)}ms 超时熔断降级：跨组织验真未完成即不放行，转人工核实（流水线已安全降级，未崩溃）。`;
    case "circuit_open":
      return `外部验真熔断器打开（连续失败 ${String(A2A_CIRCUIT_THRESHOLD)} 次进入冷却期），本次快速失败降级，转人工核实。`;
    default:
      return "外部华东物流 A2A 代理调用异常，跨组织验真未完成，降级转人工核实。";
  }
}

/**
 * 调查员：直接复用 Day 11 零框架 ReAct 调查引擎（3 把绿区只读探针）。
 * 引擎确定性执行、零模型费用；Thought / Action / Observation 逐条转播给页面直播。
 * 升级（跨组织 A2A）：当工单涉及华东区物流报销或出现 EWB: 编号时，经 a2a-client 以
 * 2500ms 超时熔断跨组织委派外部华东物流代理验真运单——此次调用作为紫色 Span 记入瀑布图；
 * 真单放行继续起草，假单 / 查无此单 / 超时熔断一律转人工（降级不崩，绝不硬凑放行）。
 */
async function runInvestigator(
  state: PipelineState,
  emit: EmitEvent,
  triage: TriageEnvelope,
  question: string,
  opts: InvestigatorOptions = {},
): Promise<InvestigatorOutcome> {
  const t0 = Date.now();
  emit({
    type: "stage_start",
    role: "investigator",
    attempt: 1,
    label: SPAN_ROLE_LABELS.investigator,
  });

  let stepsUsed = 0;
  let holder: { conclusion: InvestigationConclusion | null } = { conclusion: null };

  runInvestigation(question, (ev) => {
    if (ev.type === "thought" || ev.type === "action" || ev.type === "observation" || ev.type === "circuit_break") {
      emit({
        type: "investigator_activity",
        kind: ev.type,
        step: ev.step,
        text:
          ev.type === "thought"
            ? ev.text
            : ev.type === "action"
              ? `调用探针 ${ev.tool}（${ev.label}）`
              : ev.type === "observation"
                ? ev.summary
                : ev.message,
      });
      if (ev.type !== "circuit_break") stepsUsed = Math.max(stepsUsed, ev.step);
    } else if (ev.type === "conclusion") {
      holder.conclusion = ev.conclusion;
    }
  });

  const c = holder.conclusion;
  if (!c) {
    throw new Error("调查员未产出结论（Day 11 引擎异常），流水线熔断留痕。");
  }

  // 证据不足：不硬凑结论信封（信封契约要求至少 1 条制度引文），记录 Span 后交给编排层转人工
  if (c.evidenceChain.length === 0) {
    const span = recordSpan(state, {
      role: "investigator",
      attempt: 1,
      label: "调查员 · Day 11 只读探针（ReAct 循环）",
      status: "ok",
      durationMs: Math.max(1, Date.now() - t0),
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      detail: `${triage.priority === "high" ? "高" : "常规"}优先级派工 · 证据不足：快照未命中调查对象，不硬凑结论`,
    });
    emit({
      type: "stage_result",
      role: "investigator",
      attempt: 1,
      status: "ok",
      summary: span.detail,
      span,
    });
    return { envelope: null, a2a: null, escalateReason: null };
  }

  // 调查员本岗位收工：先发自己的 stage_result（瀑布图行序：调查员在 A2A 验真之前）
  const invSpan = recordSpan(state, {
    role: "investigator",
    attempt: 1,
    label: "调查员 · Day 11 只读探针（ReAct 循环）",
    status: "ok",
    durationMs: Math.max(1, Date.now() - t0),
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    detail: `${triage.priority === "high" ? "高" : "常规"}优先级派工 · ${String(stepsUsed)} 步推理 · 证据链 ${String(c.evidenceChain.length)} 条 · 探针只读 $0 费用`,
  });
  emit({
    type: "stage_result",
    role: "investigator",
    attempt: 1,
    status: "ok",
    summary: invSpan.detail,
    span: invSpan,
  });

  /* ---- 跨组织 A2A 验真（紫色 Span）：华东区物流报销 / EWB 编号触发 ---- */
  const a2aNeed = detectA2aNeed(question);
  let a2a: A2aVerifyResult | null = null;
  let escalateReason: string | null = null;
  if (a2aNeed.needed) {
    emit({
      type: "stage_start",
      role: "external_a2a",
      attempt: 1,
      label: SPAN_ROLE_LABELS.external_a2a,
    });
    const ewbId = a2aNeed.ewbIds[0] ?? null;
    emit({
      type: "investigator_activity",
      kind: "action",
      step: stepsUsed + 1,
      text: ewbId
        ? `跨组织委派外部华东物流 A2A 代理验真运单 ${ewbId}（${String(A2A_TIMEOUT_MS)}ms 超时熔断保护；触发原因：${a2aNeed.trigger}）`
        : `工单涉及华东区物流报销但未提供 EWB 运单编号（触发原因：${a2aNeed.trigger}），无法跨组织验真`,
    });

    if (ewbId === null) {
      escalateReason =
        "工单涉及华东区物流报销但未提供 EWB 运单编号，无法跨组织验真，转人工核对运单号。";
      const span = recordSpan(state, {
        role: "external_a2a",
        attempt: 1,
        label: "外部 A2A 物流验真 · 跨组织委派",
        status: "escalated",
        durationMs: Math.max(1, Date.now() - t0),
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        detail: "缺少 EWB 运单编号，跨组织验真无法执行 → 转人工核对运单号。",
      });
      emit({
        type: "stage_result",
        role: "external_a2a",
        attempt: 1,
        status: "escalated",
        summary: span.detail,
        span,
      });
    } else {
      const amountCny = Math.max(0, ...extractAmountsCny(question));
      a2a = await delegateEwbVerify(
        {
          ewbId,
          ticketId: triage.ticketId,
          customerId: triage.customerId,
          amountCny: amountCny > 0 ? amountCny : null,
        },
        {
          baseUrl: opts.a2aBaseUrl,
          simulateTimeout: opts.simulateExternalTimeout,
        },
      );
      const a2aStatus: SpanStatus =
        a2a.outcome === "verified_genuine"
          ? "ok"
          : a2a.outcome === "verified_forged" || a2a.outcome === "unregistered"
            ? "rejected"
            : "escalated";
      const span = recordSpan(state, {
        role: "external_a2a",
        attempt: 1,
        label: "外部 A2A 物流验真 · 跨组织委派",
        status: a2aStatus,
        durationMs: a2a.elapsedMs,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        detail: a2a.detail,
      });
      emit({
        type: "stage_result",
        role: "external_a2a",
        attempt: 1,
        status: a2aStatus,
        summary: span.detail,
        span,
      });
      emit({
        type: "investigator_activity",
        kind: "observation",
        step: stepsUsed + 1,
        text: `外部代理验真返回：${a2a.detail}`,
      });
      if (a2a.outcome !== "verified_genuine") {
        // 假单 / 查无此单 / 超时熔断：绝不把未验真的运单送进起草，直接转人工（降级不崩）
        escalateReason = a2aEscalateReason(a2a);
      }
    }
  }
  if (escalateReason !== null) {
    return { envelope: null, a2a, escalateReason };
  }

  // 验真通过：把跨组织验真结论追加进处置建议（起草员会写进草稿的「接下来我们将」）
  if (a2a !== null && a2a.verified === true) {
    c.nextActions = [
      ...c.nextActions,
      `运单 ${a2a.ewbId ?? ""} 已通过外部华东物流 A2A 代理跨组织验真（承运商存档回单一致），请报销岗按人工复核流程完成确认`,
    ];
  }

  const docRefs = [
    ...new Set(c.evidenceChain.flatMap((e) => e.docRefs)),
  ];

  const envelope: InvestigationEnvelope = parseEnvelope(
    investigationEnvelopeSchema,
    "调查员结论信封",
    {
      envelopeId: newEnvelopeId(),
      from: "investigator",
      to: "drafter",
      createdAt: new Date().toISOString(),
      headline: c.headline,
      rootCause: c.rootCause,
      body: c.body,
      evidenceChain: c.evidenceChain,
      docRefs,
      fin001Triggered: c.fin001Triggered,
      nextActions: c.nextActions,
      stepsUsed: stepsUsed || c.stepsUsed,
      maxSteps: c.maxSteps,
    },
  );

  emit({ type: "envelope", envelopeKind: "investigation", payload: envelope });
  return { envelope, a2a, escalateReason: null };
}

/* ================================================================
 * 六、岗位③：起草员（草稿 → 质检官；被打回按问题清单重写）
 * ================================================================ */

/** 用户话术里的越权诱导信号（命中时起草员第一稿会"上头"——这正是质检官存在的意义） */
const REFUND_INDUCEMENT_RE = /自动退|全额退|直接退|承诺退|立即退|马上退|秒退|先退再说|无需审批/;
const PII_INDUCEMENT_RE = /(?<!\d)1[3-9]\d{9}(?!\d)|\d{17}[\dXx]|回电|回拨|拨打|联系方式/;

/** 按调查结论拼装合规草稿（含全部制度引文；退款话术永远指向人工审批正规通道） */
function buildCompliantDraft(
  inv: InvestigationEnvelope,
  attempt: number,
  reworkOf: string | null,
): Omit<DraftEnvelope, "envelopeId" | "from" | "to" | "createdAt"> {
  const citationText = inv.docRefs.map((d) => `[${d}]`).join(" ");
  const refundClause = inv.fin001Triggered
    ? `关于退款：单笔金额超过 ¥50,000，按现行制度 ${citationText}，必须由具名在职审批人签字放行后方可执行，` +
      "退款一律走既有正规通道并先行挂「疑似错账」标记，我们绝不会以任何「自动退款 / 直接打款」形式操作。"
    : `相关处置按现行制度 ${citationText} 执行，全部走既有正规通道，由具名负责人确认。`;

  const draftText =
    `尊敬的客户：\n` +
    `您好！关于您反馈的问题（${inv.headline}），我们已完成专项调查：${inv.rootCause}\n` +
    `${refundClause}\n` +
    (inv.nextActions.length > 0
      ? `接下来我们将：${inv.nextActions.map((a, i) => `${String(i + 1)}) ${a}`).join("；")}。\n`
      : "") +
    `处理进度会由您的客户经理主动同步，无需您重复催办。\n` +
    `——星辰跨境企服集团 客服专班（第 ${String(attempt)} 稿；本回复为草稿，` +
    `经独立质检与人工确认后才会发出${reworkOf ? `；返工依据：质检单 ${reworkOf}` : ""}）`;

  return {
    draftText,
    docCitations: inv.docRefs,
    autoRefundPromised: false,
    fin001Triggered: inv.fin001Triggered,
    attempt,
    reworkOf,
  };
}

/** 第一稿：命中诱导话术时起草员"上头"，产出越权草稿（供质检官拦截演示） */
function buildInducedDraft(
  inv: InvestigationEnvelope,
  question: string,
): Omit<DraftEnvelope, "envelopeId" | "from" | "to" | "createdAt"> {
  const refundInduced = REFUND_INDUCEMENT_RE.test(question);
  const piiMatch = question.match(/(?<!\d)1[3-9]\d{9}(?!\d)|\d{17}[\dXx]/)?.[0] ?? null;

  if (refundInduced) {
    // 越权草稿：承诺自动退还大额款项，且漏写制度引文（质检官两个问题一起抓）
    const overLine = extractAmountsCny(question).sort((a, b) => b - a)[0] ?? 52800;
    return {
      draftText:
        `尊敬的客户：\n` +
        `您好！您反馈的问题已核实，我们将在 1 个工作日内自动退还 ¥${overLine.toLocaleString("zh-CN")} 至您的对公账户，` +
        `无需任何审批手续，直接到账。\n` +
        `——星辰跨境企服集团 客服专班`,
      docCitations: [],
      autoRefundPromised: true,
      fin001Triggered: inv.fin001Triggered,
      attempt: 1,
      reworkOf: null,
    };
  }

  if (piiMatch) {
    // 泄露草稿：把用户粘贴的明文联系方式原样写进对外草稿（质检官 PII 护栏兜底）
    return {
      draftText:
        `尊敬的客户：\n` +
        `您好！您反馈的问题已核实，处理专员将直接回电 ${piiMatch} 与您对接退款事宜，请保持电话畅通。\n` +
        `——星辰跨境企服集团 客服专班`,
      docCitations: [],
      autoRefundPromised: false,
      fin001Triggered: inv.fin001Triggered,
      attempt: 1,
      reworkOf: null,
    };
  }

  // 未命中诱导：常规第一稿（合规）
  return buildCompliantDraft(inv, 1, null);
}

function runDrafter(
  state: PipelineState,
  emit: EmitEvent,
  inv: InvestigationEnvelope,
  attempt: number,
  question: string,
  reworkOf: string | null,
): DraftEnvelope {
  const t0 = Date.now();
  emit({
    type: "stage_start",
    role: "drafter",
    attempt,
    label: `${SPAN_ROLE_LABELS.drafter} · 第 ${String(attempt)} 稿`,
  });

  const body =
    attempt === 1
      ? buildInducedDraft(inv, question)
      : buildCompliantDraft(inv, attempt, reworkOf);
  const envelope: DraftEnvelope = parseEnvelope(
    draftEnvelopeSchema,
    "起草员草稿信封",
    {
      envelopeId: newEnvelopeId(),
      from: "drafter",
      to: "qa_reviewer",
      createdAt: new Date().toISOString(),
      ...body,
    },
  );

  const inputTokens = estimateTokens(inv.body + inv.rootCause) + 60;
  const outputTokens = estimateTokens(envelope.draftText);
  const costUsd = costUsdOf(FLAGSHIP_PRICE, inputTokens, outputTokens);

  const span = recordSpan(state, {
    role: "drafter",
    attempt,
    label: `起草员 · 第 ${String(attempt)} 稿`,
    status: attempt === 1 ? "ok" : "rewritten",
    durationMs: Math.max(1, Date.now() - t0),
    costUsd,
    inputTokens,
    outputTokens,
    detail:
      attempt === 1
        ? "产出草稿信封（待独立质检）"
        : `按质检问题清单重写（返工第 ${String(attempt - 1)} 次）`,
  });
  emit({ type: "envelope", envelopeKind: "draft", payload: envelope });
  emit({
    type: "stage_result",
    role: "drafter",
    attempt,
    status: span.status,
    summary: span.detail,
    span,
  });
  return envelope;
}

/* ================================================================
 * 七、岗位④：独立质检官（只裁定，不代笔；不合格打回，超限转人工）
 * ================================================================ */

/** 质检官法定质检项：草稿必须写明人工审批口径（FIN-001 触发时） */
const HUMAN_APPROVAL_RE = /人工审批|具名(在职)?(审批人|审批)|签字放行/;

/**
 * 独立质检官核心检查（导出供单元测试）：纯函数级质检项裁定。
 * 质检官只裁定、不代笔——发现问题清单交编排层决定打回还是转人工。
 */
export function runQaReview(
  state: PipelineState,
  emit: EmitEvent,
  draft: DraftEnvelope,
  inv: InvestigationEnvelope,
  reworkCount: number,
): QaVerdictEnvelope {
  const t0 = Date.now();
  const attempt = reworkCount + 1;
  emit({
    type: "stage_start",
    role: "qa_reviewer",
    attempt,
    label: `${SPAN_ROLE_LABELS.qa_reviewer} · 检第 ${String(attempt)} 稿`,
  });

  const issues: QaIssue[] = [];

  // 出口护栏复检（承诺 / PII）——护栏与质检双保险
  const guard = runOutputGuard(draft.draftText);
  for (const v of guard.violations) {
    issues.push({
      code:
        v.code === "unauthorized_auto_refund"
          ? "unauthorized_auto_refund"
          : "pii_leak",
      detail: v.detail,
    });
  }

  // ① 制度引文完整性：正文必须真的写有 [DOC-XX §X.X]，且与信封申报一致
  const inText = [...draft.draftText.matchAll(/\[(DOC-\d+ §\d+(?:\.\d+)?)\]/g)].map(
    (m) => m[1],
  );
  const missing = draft.docCitations.filter((c) => !inText.includes(c));
  if (inText.length === 0) {
    issues.push({
      code: "missing_doc_citation",
      detail: "草稿正文漏写 [DOC-XX §X.X] 制度引文（质检项 ①：每份对外话术必须挂现行制度出处）",
    });
  } else if (missing.length > 0) {
    issues.push({
      code: "missing_doc_citation",
      detail: `草稿信封申报的引文未写进正文：${missing.join("、")}`,
    });
  }

  // ② FIN-001 口径：触发红线的草稿必须写明「人工审批 / 具名签字放行」
  if (draft.fin001Triggered && !HUMAN_APPROVAL_RE.test(draft.draftText)) {
    issues.push({
      code: "fin001_not_mentioned",
      detail: "触发 FIN-001 但草稿未写明「须由具名审批人人工签字放行」（质检项 ②）",
    });
  }

  const pass = issues.length === 0;
  // 最多返工 2 次：已返工 2 次（第 3 稿）仍不合格 → 升级转人工
  const escalateToHuman = !pass && reworkCount >= 2;

  const inputTokens = estimateTokens(draft.draftText) + estimateTokens("质检清单：引文完整性 / 越权承诺 / PII 泄露 / FIN-001 口径");
  const outputTokens = estimateTokens(JSON.stringify({ pass, issues }));
  const costUsd = costUsdOf(FLAGSHIP_PRICE, inputTokens, outputTokens);

  const verdict: QaVerdictEnvelope = parseEnvelope(
    qaVerdictEnvelopeSchema,
    "质检官裁定信封",
    {
      envelopeId: newEnvelopeId(),
      from: "qa_reviewer",
      to: "triage",
      createdAt: new Date().toISOString(),
      pass,
      checkedAttempt: draft.attempt,
      checkedEnvelopeId: draft.envelopeId,
      issues,
      escalateToHuman,
    },
  );

  const span = recordSpan(state, {
    role: "qa_reviewer",
    attempt,
    label: `独立质检官 · 检第 ${String(attempt)} 稿`,
    status: pass ? "ok" : escalateToHuman ? "escalated" : "rejected",
    durationMs: Math.max(1, Date.now() - t0),
    costUsd,
    inputTokens,
    outputTokens,
    detail: pass
      ? `放行：引文 ${inText.join("、")} 全部落款，无越权承诺、无 PII 泄露`
      : escalateToHuman
        ? `返工 ${String(reworkCount)} 次仍不合格 → 升级转人工`
        : `打回第 ${String(draft.attempt)} 稿：${issues.map((i) => i.code).join("、")}`,
  });
  emit({ type: "envelope", envelopeKind: "qa_verdict", payload: verdict });
  emit({
    type: "stage_result",
    role: "qa_reviewer",
    attempt,
    status: span.status,
    summary: span.detail,
    span,
  });
  if (!pass && !escalateToHuman) {
    emit({ type: "qa_reject", attempt: draft.attempt, issues, willRewrite: true });
  }
  if (escalateToHuman) {
    emit({
      type: "escalate_human",
      reason: `质检官返工 ${String(reworkCount)} 次后仍不合格（${issues
        .map((i) => i.code)
        .join("、")}），按制度自动转人工处理。`,
    });
  }
  return verdict;
}

/* ================================================================
 * 八、主编排：入口护栏 → 四岗位循环 → 出口护栏 → 终稿
 * ================================================================ */

export interface PipelineRunResult {
  traceId: string;
  status: "completed" | "escalated" | "blocked";
  reworkCount: number;
  spans: AgentSpan[];
  totalDurationMs: number;
  totalCostUsd: number;
  triageSavingsPercent: number;
  finalDraftText: string | null;
  finalCitations: string[];
  escalateReason: string | null;
  questionLabel: string;
}

export const MAX_REWORKS = 2;

/** 工单标签（不含 PII，用于 agent_traces 留痕检索） */
function questionLabelOf(question: string): string {
  const category = classifyCategory(question);
  const cid = question.match(/CUST-\d{3,}/)?.[0];
  const tid = question.match(/TCK-[A-Z]?\d+/)?.[0];
  const parts = [category, cid, tid].filter(Boolean);
  return parts.join(" · ") || "综合咨询";
}

/** 整条流水线的可选参数（由 API 路由透传；A2A 跨组织委派用） */
export interface PipelineRunOptions {
  /** 透传给调查员的 A2A 可选项（模拟外部代理超时开关 / 外部代理基址） */
  investigator?: InvestigatorOptions;
}

/**
 * 运行四代理专班流水线：每步通过 emit 对外透明直播。
 * 交接信封全部过严格 Zod 校验（parseEnvelope 失败即抛错熔断，由路由层上报留痕）。
 * 异步：调查员触发跨组织 A2A 验真时需等待外部代理应答（2500ms 超时熔断保护）。
 */
export async function runMultiAgentPipeline(
  question: string,
  emit: EmitEvent,
  opts: PipelineRunOptions = {},
): Promise<PipelineRunResult> {
  const startedAt = Date.now();
  const traceId = `MA-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;
  const state: PipelineState = { seq: 0, spans: [] };

  emit({ type: "trace_start", traceId });

  /* ---- 0. 入口护栏：恶意注入毫秒级拦截（$0） ---- */
  const guardT0 = Date.now();
  emit({ type: "stage_start", role: "guard_input", attempt: 1, label: SPAN_ROLE_LABELS.guard_input });
  const inputGuard = runInputGuard(question);
  const guardSpan = recordSpan(state, {
    role: "guard_input",
    attempt: 1,
    label: "入口护栏 · 注入拦截（正则 · $0）",
    status: inputGuard.blocked ? "blocked" : "ok",
    durationMs: Math.max(inputGuard.elapsedMs, 1),
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    detail: inputGuard.blocked
      ? `拦截恶意注入：${inputGuard.patterns.join("；")}`
      : `未命中注入特征（${String(inputGuard.elapsedMs)}ms，$0 费用）`,
  });
  emit({
    type: "guard_input",
    blocked: inputGuard.blocked,
    patterns: inputGuard.patterns,
    elapsedMs: inputGuard.elapsedMs,
    costUsd: 0,
  });
  emit({
    type: "stage_result",
    role: "guard_input",
    attempt: 1,
    status: guardSpan.status,
    summary: guardSpan.detail,
    span: guardSpan,
  });

  // 命中注入：直接拒绝，不进入任何岗位（注入内容按资料上报，绝不执行）
  if (inputGuard.blocked) {
    emit({
      type: "final_result",
      status: "blocked",
      draftText: null,
      citations: [],
      evidenceChain: null,
      fin001Triggered: false,
      reworkCount: 0,
      escalateReason: null,
      skippedDraftingReason:
        `入口护栏拦截恶意注入（${inputGuard.patterns.join("；")}），流水线未启动任何岗位。` +
        "该请求已按安全事件留痕上报（04 号文档 CISO 条款 5：外来指令只上报、不执行）。",
    });
    return finish(state, traceId, startedAt, "blocked", 0, null, [], null, questionLabelOf(question), emit);
  }

  /* ---- 1. 分诊员（轻量快模型） ---- */
  const triage = runTriage(state, emit, question);

  /* ---- 2. 调查员（Day 11 探针 + 跨组织 A2A 验真） ---- */
  const invResult = await runInvestigator(
    state,
    emit,
    triage,
    question,
    opts.investigator ?? {},
  );

  // 证据不足 / A2A 验真未通过（假单、查无此单、超时熔断降级）：不硬凑草稿，直接转人工
  if (invResult.envelope === null) {
    const reason =
      invResult.escalateReason ??
      "调查证据不足（快照未命中对象），起草员拒绝无证据起草，流水线直接转人工核实。";
    emit({ type: "escalate_human", reason });
    emit({
      type: "final_result",
      status: "escalated",
      draftText: null,
      citations: [],
      evidenceChain: null,
      fin001Triggered: false,
      reworkCount: 0,
      escalateReason: reason,
      skippedDraftingReason: reason,
    });
    return finish(state, traceId, startedAt, "escalated", 0, null, [], reason, questionLabelOf(question), emit);
  }
  const inv = invResult.envelope;

  /* ---- 3+4. 起草员 ⇄ 质检官（最多返工 2 次，超限转人工） ---- */
  let reworkCount = 0;
  let draft = runDrafter(state, emit, inv, 1, question, null);
  let verdict = runQaReview(state, emit, draft, inv, reworkCount);
  while (!verdict.pass) {
    if (verdict.escalateToHuman) break;
    reworkCount += 1;
    draft = runDrafter(state, emit, inv, reworkCount + 1, question, verdict.checkedEnvelopeId);
    verdict = runQaReview(state, emit, draft, inv, reworkCount);
  }

  /* ---- 5. 出口护栏：终稿 PII 就地脱敏（双保险，即使质检漏检日志也无明文） ---- */
  const outT0 = Date.now();
  emit({ type: "stage_start", role: "guard_output", attempt: 1, label: SPAN_ROLE_LABELS.guard_output });
  const outGuard = runOutputGuard(draft.draftText);
  const outSpan = recordSpan(state, {
    role: "guard_output",
    attempt: 1,
    label: "出口护栏 · 越权承诺 / PII 拦截（正则 · $0）",
    status: "ok",
    durationMs: Math.max(outGuard.elapsedMs, 1),
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    detail:
      outGuard.violations.length === 0
        ? `终稿无越权承诺、无 PII 明文（${String(outGuard.elapsedMs)}ms，$0 费用）`
        : `发现并处理 ${String(outGuard.violations.length)} 项风险（已脱敏 / 已留痕）`,
  });
  emit({
    type: "stage_result",
    role: "guard_output",
    attempt: 1,
    status: outSpan.status,
    summary: outSpan.detail,
    span: outSpan,
  });

  /* ---- 终稿裁定 ---- */
  const escalated = verdict.escalateToHuman;
  const finalDraftText = outGuard.sanitizedText;
  if (escalated) {
    // 转人工：终稿仍是问题草稿，页面以琥珀色警示展示，绝不直接对外发出
    emit({
      type: "final_result",
      status: "escalated",
      draftText: finalDraftText,
      citations: draft.docCitations,
      evidenceChain: inv.evidenceChain,
      fin001Triggered: inv.fin001Triggered,
      reworkCount,
      escalateReason: `质检官返工 ${String(MAX_REWORKS)} 次后仍不合格，自动转人工处理。`,
      skippedDraftingReason: null,
    });
    return finish(
      state,
      traceId,
      startedAt,
      "escalated",
      reworkCount,
      finalDraftText,
      draft.docCitations,
      `质检官返工 ${String(MAX_REWORKS)} 次后仍不合格，自动转人工处理。`,
      questionLabelOf(question),
      emit,
    );
  }

  emit({
    type: "final_result",
    status: "completed",
    draftText: finalDraftText,
    citations: draft.docCitations,
    evidenceChain: inv.evidenceChain,
    fin001Triggered: inv.fin001Triggered,
    reworkCount,
    escalateReason: null,
    skippedDraftingReason: null,
  });
  return finish(
    state,
    traceId,
    startedAt,
    "completed",
    reworkCount,
    finalDraftText,
    draft.docCitations,
    null,
    questionLabelOf(question),
    emit,
  );
}

/* ================================================================
 * 九、收尾：trace_done 汇总（瀑布图数据）
 * ================================================================ */

function finish(
  state: PipelineState,
  traceId: string,
  startedAt: number,
  status: PipelineRunResult["status"],
  reworkCount: number,
  finalDraftText: string | null,
  finalCitations: string[],
  escalateReason: string | null,
  questionLabel: string,
  emit: EmitEvent,
): PipelineRunResult {
  const totalDurationMs = Date.now() - startedAt;
  const totalCostUsd = state.spans.reduce((sum, s) => sum + s.costUsd, 0);

  // 分诊员轻量快档 vs 旗舰档（同 Token 口径）的节省百分比：实时计算，不硬编码
  const triageSpan = state.spans.find((s) => s.role === "triage");
  let triageSavingsPercent = 0;
  if (triageSpan) {
    const flagshipCost = costUsdOf(
      FLAGSHIP_PRICE,
      triageSpan.inputTokens,
      triageSpan.outputTokens,
    );
    if (flagshipCost > 0) {
      triageSavingsPercent = Math.round((1 - triageSpan.costUsd / flagshipCost) * 100);
    }
  }

  emit({
    type: "trace_done",
    traceId,
    totalDurationMs,
    totalCostUsd,
    triageSavingsPercent,
    spans: state.spans,
  });

  return {
    traceId,
    status,
    reworkCount,
    spans: state.spans,
    totalDurationMs,
    totalCostUsd,
    triageSavingsPercent,
    finalDraftText,
    finalCitations,
    escalateReason,
    questionLabel,
  };
}
