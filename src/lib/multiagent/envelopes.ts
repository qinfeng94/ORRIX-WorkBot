/**
 * envelopes.ts —— Day 12 四代理客服专班的岗位交接信封契约（仅限服务端 + 类型复用）
 * 溯源：04 号文档三色权限边界（岗位只做本职：分诊只读 / 调查只读 / 起草不执行 / 质检不修改）；
 *      AGENTS.md 业务红线（FIN-001 / 红区严禁自动打款 / 日志只增不改）。
 * 设计：
 * - 岗位之间不传自由文本，只传严格 Zod 校验的结构化交接信封；每个边界 parse 失败即熔断；
 * - 信封自带信封编号 / 发件岗 / 收件岗 / 时间戳，可被 agent_spans 全程留痕（只增不改）；
 * - 质检官的驳回理由也是信封（QaVerdictEnvelope），打回给起草员时作为重写依据。
 */

import { z } from "zod";

/* ================================================================
 * 一、公共字段
 * ================================================================ */

/** 四个专职岗位（起草员编号 DR-01，质检官编号 QA-01，便于审计留痕定位责任人岗位） */
export const PIPELINE_ROLES = [
  "triage",
  "investigator",
  "drafter",
  "qa_reviewer",
] as const;

export type PipelineRole = (typeof PIPELINE_ROLES)[number];

export const ROLE_LABELS: Record<PipelineRole, string> = {
  triage: "分诊员（Triage）",
  investigator: "调查员（Investigator）",
  drafter: "起草员（Drafter）",
  qa_reviewer: "独立质检官（QA Reviewer）",
};

/** 信封头：所有信封共有（收发岗位 + 编号 + 时间戳） */
const envelopeHead = {
  /** 信封编号（ENV-时间戳-随机，全程留痕用） */
  envelopeId: z.string().min(1),
  /** 发件岗位 */
  from: z.enum(PIPELINE_ROLES),
  /** 收件岗位 */
  to: z.enum(PIPELINE_ROLES),
  /** ISO 时间戳 */
  createdAt: z.string().min(1),
};

/** 制度引文格式：必须是 [DOC-XX §X.X] 口径的裸编号（如 "DOC-01 §4.2"） */
export const docRefSchema = z
  .string()
  .regex(/^DOC-\d+ §\d+(\.\d+)?$/, "制度引文必须是「DOC-XX §X.X」格式");

/* ================================================================
 * 二、四类交接信封
 * ================================================================ */

/** ① 分诊员 → 调查员：派工信封（只读分类结论，不派任何写操作） */
export const triageEnvelopeSchema = z.object({
  ...envelopeHead,
  from: z.literal("triage"),
  to: z.literal("investigator"),
  /** 业务分类：财务 / 物流 / 客诉 / 综合 */
  category: z.enum(["finance", "logistics", "complaint", "generic"]),
  /** 客户编号（如 CUST-8842，未识别为 null） */
  customerId: z.string().regex(/^CUST-\d+$/).nullable(),
  /** 工单编号（如 TCK-3117，未识别为 null） */
  ticketId: z.string().regex(/^TCK-[A-Z]?\d+$/).nullable(),
  /** 优先级：命中 FIN-001 风险或重大客诉即 high */
  priority: z.enum(["high", "normal"]),
  /** 是否疑似触发 FIN-001（分诊员只标记，不判定、不审批） */
  fin001Risk: z.boolean(),
  /** 给调查员的一句话任务提示（不含任何 PII 明文） */
  summaryHint: z.string().min(1).max(300),
  /** 本次分诊的 Token 与费用（轻量快模型口径，用于瀑布图与省成本核算） */
  tokensUsed: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type TriageEnvelope = z.infer<typeof triageEnvelopeSchema>;

/** ② 调查员 → 起草员：调查结论信封（强制证据链；复用 Day 11 探针产出） */
export const investigationEnvelopeSchema = z.object({
  ...envelopeHead,
  from: z.literal("investigator"),
  to: z.literal("drafter"),
  headline: z.string().min(1),
  rootCause: z.string().min(1),
  /** 结论正文（内嵌证据编号与 [DOC-XX §X.X] 引文） */
  body: z.string().min(1),
  /** 证据链条目（每条可溯源） */
  evidenceChain: z.array(
    z.object({
      id: z.string().min(1),
      source: z.string().min(1),
      query: z.string().min(1),
      finding: z.string().min(1),
      docRefs: z.array(docRefSchema),
    }),
  ),
  /** 结论命中的全部制度引文（起草员必须逐条带进草稿） */
  docRefs: z.array(docRefSchema).min(1, "调查结论必须命中至少一条制度引文"),
  fin001Triggered: z.boolean(),
  nextActions: z.array(z.string().min(1)),
  stepsUsed: z.number().int().nonnegative(),
  maxSteps: z.number().int().positive(),
});
export type InvestigationEnvelope = z.infer<typeof investigationEnvelopeSchema>;

/** ③ 起草员 → 质检官：草稿信封（只是草稿，未经人类确认不得发出） */
export const draftEnvelopeSchema = z.object({
  ...envelopeHead,
  from: z.literal("drafter"),
  to: z.literal("qa_reviewer"),
  /** 草稿正文（客户通知话术草稿） */
  draftText: z.string().min(1),
  /** 草稿内引用的制度条目清单（质检官逐条核对是否真的写进正文） */
  docCitations: z.array(docRefSchema),
  /** 起草员自报：是否承诺了「自动退还」类表述（自报 + 质检复检双保险） */
  autoRefundPromised: z.boolean(),
  /** 是否触发 FIN-001（草稿必须含「人工审批」字样才可能过检） */
  fin001Triggered: z.boolean(),
  /** 第几次起草（1 起；质检打回后递增） */
  attempt: z.number().int().positive(),
  /** 若为返工，附质检官上一轮的驳回信封编号（留痕溯源） */
  reworkOf: z.string().nullable(),
});
export type DraftEnvelope = z.infer<typeof draftEnvelopeSchema>;

/** 质检问题代码 */
export const qaIssueCodeSchema = z.enum([
  /** 漏写 [DOC-XX §X.X] 制度引文 */
  "missing_doc_citation",
  /** 越权承诺（如承诺自动退还 >¥50,000） */
  "unauthorized_auto_refund",
  /** PII 明文泄露（手机号 / 身份证号） */
  "pii_leak",
  /** 触发 FIN-001 却未写明「须人工审批」 */
  "fin001_not_mentioned",
]);
export type QaIssueCode = z.infer<typeof qaIssueCodeSchema>;

/** ④ 独立质检官 → 流水线：质检裁定信封（打回起草员，或放行 / 升级转人工） */
export const qaVerdictEnvelopeSchema = z.object({
  ...envelopeHead,
  from: z.literal("qa_reviewer"),
  to: z.literal("triage"),
  /** 是否放行 */
  pass: z.boolean(),
  /** 被检草稿的 attempt */
  checkedAttempt: z.number().int().positive(),
  /** 被检草稿的信封编号（留痕溯源） */
  checkedEnvelopeId: z.string().min(1),
  /** 问题清单（打回时起草员按此逐条重写） */
  issues: z.array(
    z.object({
      code: qaIssueCodeSchema,
      detail: z.string().min(1),
    }),
  ),
  /** 最多返工 2 次仍不合格 → 升级转人工（质检官只裁定，不代笔修改） */
  escalateToHuman: z.boolean(),
});
export type QaVerdictEnvelope = z.infer<typeof qaVerdictEnvelopeSchema>;

/* ================================================================
 * 三、边界校验工具（岗位交接的唯一通道：parse 失败即抛错熔断）
 * ================================================================ */

/** 交接边界校验失败（流水线在此处熔断，绝不带病传递） */
export class EnvelopeValidationError extends Error {
  readonly envelopeKind: string;
  readonly issues: string[];

  constructor(envelopeKind: string, issues: string[]) {
    super(
      `交接信封校验失败（${envelopeKind}）：${issues.join("；")}。流水线已熔断，问题留痕上报。`,
    );
    this.name = "EnvelopeValidationError";
    this.envelopeKind = envelopeKind;
    this.issues = issues;
  }
}

/** 在岗位边界做严格 Zod 校验；失败即抛 EnvelopeValidationError（信封不带病传递） */
export function parseEnvelope<T>(
  schema: z.ZodType<T>,
  envelopeKind: string,
  raw: unknown,
): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new EnvelopeValidationError(
      envelopeKind,
      result.error.issues.map(
        (i) => `${i.path.join(".") || "(根字段)"}: ${i.message}`,
      ),
    );
  }
  return result.data;
}

/** 生成信封编号（ENV-YYYYMMDD-XXXX，只增不改日志的关联键） */
export function newEnvelopeId(): string {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `ENV-${today}-${rand}`;
}
