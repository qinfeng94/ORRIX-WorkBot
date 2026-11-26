/**
 * WorkBot 核心数据表定义（Drizzle ORM · PostgreSQL）
 * 溯源：04 号文档 CISO 条款 3（具名审批人）、条款 4（不可篡改审计日志 + PII 脱敏）；
 *      AGENTS.md 业务红线（FIN-001 / 日志只增不改）。
 * 边界：approval_audit_logs 只增不改——数据库层用触发器物理禁止 UPDATE / DELETE（红区 R3）。
 */

import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * 工单表：异常工单的唯一真实数据来源（替代原前端内存数组）
 * 测试数据一律虚构（AGENTS.md 代码红线 3）；PII 字段仅存储原始值，展示层统一脱敏。
 */
export const intakeRequests = pgTable("intake_requests", {
  /** 自增主键 */
  id: serial("id").primaryKey(),
  /**
   * 租户 ID（Day 27 多租户逻辑隔离）：所有查询必须携带本列过滤，
   * 访问唯一入口 = src/lib/ontology/tenant-repo.ts（强制 WHERE tenant_id）。
   */
  tenantId: text("tenant_id").notNull().default("xingchen"),
  /** 工单编号（业务主键，如 T-2026-1101） */
  ticketNo: text("ticket_no").notNull().unique(),
  /** 所属部门：财务部 | 运营部 | 客服部 */
  department: text("department").notNull(),
  /** 金额（单位：元，整数口径） */
  amount: integer("amount").notNull(),
  /** 异常摘要 */
  summary: text("summary").notNull(),
  /** 状态：待林总审批 | 处理中 | 待财务复核 | 待寄回验收 | 已批准 */
  status: text("status").notNull().default("待林总审批"),
  /** 具名人工审批放行时间（未审批为 null） */
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  /** 客户姓名（展示层脱敏为 张*） */
  customerName: text("customer_name").notNull(),
  /** 银行账号（展示层脱敏为 6222 **** **** 1234） */
  bankAccount: text("bank_account").notNull(),
  /** 是否触发 FIN-001 强制人工审批（服务端写入时按单一阈值判定） */
  isFin001: boolean("is_fin001").notNull().default(false),
  /** 创建时间 */
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * 审批审计日志表：只增不改（CISO 条款 4 / 红区 R3）
 * 本表没有暴露任何 update/delete 的代码入口；数据库触发器物理拒绝篡改。
 */
export const approvalAuditLogs = pgTable("approval_audit_logs", {
  /** 自增主键 */
  id: serial("id").primaryKey(),
  /** 租户 ID（Day 27 多租户逻辑隔离：审计留痕同样按租户归属） */
  tenantId: text("tenant_id").notNull().default("xingchen"),
  /** 关联工单编号（软关联，日志独立存续，切断不丢） */
  ticketNo: text("ticket_no").notNull(),
  /** 具名审批人（禁止匿名 / 部门 / 值班等模糊身份） */
  approver: text("approver").notNull(),
  /** 动作描述（中文大白话） */
  action: text("action").notNull(),
  /** 是否为 FIN-001 大额放行事件 */
  isFin001: boolean("is_fin001").notNull().default(false),
  /** 留痕时间戳 */
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * 大模型用量台账表：每次 /chat 调用结束后由服务端 after() 追加一条（只增不改）
 * 溯源：Day 6 双模型引擎——费用必须落库防 Vercel 冻结丢账；AGENTS.md 日志红线（只增不改）。
 * 边界：本表没有暴露任何 update/delete 的代码入口；数据库触发器物理拒绝篡改。
 */
export const llmUsageLogs = pgTable("llm_usage_logs", {
  /** 自增主键 */
  id: serial("id").primaryKey(),
  /** 服务厂商：anthropic | openai */
  providerId: text("provider_id").notNull(),
  /** 实际模型名 */
  model: text("model").notNull(),
  /** 调用模式：live（真实 API）| offline-sim（离线高仿真） */
  mode: text("mode").notNull(),
  /** effort 档位：low | medium | high */
  effort: text("effort").notNull(),
  /** 首字延迟（毫秒） */
  ttftMs: integer("ttft_ms").notNull(),
  /** 总耗时（毫秒） */
  totalMs: integer("total_ms").notNull(),
  /** 输入 Token 数 */
  inputTokens: integer("input_tokens").notNull(),
  /** 输出 Token 数 */
  outputTokens: integer("output_tokens").notNull(),
  /** 美元花费 */
  usdCost: text("usd_cost").notNull(),
  /** 是否发生主→备自动切换 */
  wasFallback: boolean("was_fallback").notNull().default(false),
  /** 本次是否为故障演习注入 */
  simulatedOutage: boolean("simulated_outage").notNull().default(false),
  /** 会话标识（不含任何 PII） */
  sessionId: text("session_id").notNull().default(""),
  /** 问题摘要标签（不含 PII，如「财务查重复扣款」） */
  questionLabel: text("question_label").notNull().default(""),
  /** 留痕时间戳 */
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * 情景记忆表（Day 9 三层记忆 · 第 2 层）：跨会话自动提取的关键工单结论
 * 例：「CUST-8842 重复扣款 ¥52,800 · 本次结论：已挂疑似错账标记」。
 * 边界：记忆必须可控（AGENTS.md 用户红线 3 的镜像要求）——本表允许查看/编辑/删除，
 *      不挂只增不改触发器；用户随时可让 AI「忘掉」任何一条。
 */
export const memoryEpisodes = pgTable("memory_episodes", {
  /** 自增主键 */
  id: serial("id").primaryKey(),
  /** 产生该条记忆的会话标识（不含 PII） */
  sessionId: text("session_id").notNull().default(""),
  /** 记忆类型：ticket_conclusion（工单结论）| summary（对话摘要） */
  episodeType: text("episode_type").notNull(),
  /** 情景摘要正文（大白话，可被用户编辑） */
  content: text("content").notNull(),
  /** 关联单号引用（如 CUST-8842 / TCK-3117，多个用空格分隔，可为空） */
  ticketRefs: text("ticket_refs").notNull().default(""),
  /** 片段开关：true=注入 AI 上下文；false=用户停用（AI 下轮起不再参考） */
  enabled: boolean("enabled").notNull().default(true),
  /** 记忆产生时间 */
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * 语义记忆表（Day 9 三层记忆 · 第 3 层）：当前用户的部门偏好与称呼风格
 * 边界：同上，允许查看/编辑/删除；一个用户一行（user_key 唯一）。
 */
export const userPreferences = pgTable("user_preferences", {
  /** 自增主键 */
  id: serial("id").primaryKey(),
  /** 用户标识（演示环境为具名审批人名，不含其他 PII） */
  userKey: text("user_key").notNull().unique(),
  /** 称呼（如「王经理」，AI 回复时沿用） */
  displayName: text("display_name").notNull().default(""),
  /** 常关注部门（如「财务部」，由提问自动学习，可手改） */
  department: text("department").notNull().default(""),
  /** 称呼风格（如「正式敬语」/「直接简短」，可手改） */
  style: text("style").notNull().default(""),
  /** 其他已记住的事实清单（每条一句话，可逐条编辑/删除） */
  facts: jsonb("facts").$type<string[]>().notNull().default([]),
  /** 被用户停用的事实（facts 的子集；停用后不注入 AI 上下文） */
  disabledFacts: jsonb("disabled_facts").$type<string[]>().notNull().default([]),
  /** 最近更新时间 */
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Day 12 四代理专班 · 追踪主表：一次流水线运行一条（只增不改）
 * 溯源：AGENTS.md 日志红线（审计日志只增不改）；04 号文档 CISO 条款 4（全过程留痕带时间戳）。
 * 边界：本表没有暴露任何 update/delete 的代码入口；数据库触发器物理拒绝篡改。
 */
export const agentTraces = pgTable("agent_traces", {
  /** 自增主键 */
  id: serial("id").primaryKey(),
  /** 追踪编号（业务主键，如 MA-20261126-XXXX） */
  traceId: text("trace_id").notNull().unique(),
  /** 会话标识（不含任何 PII） */
  sessionId: text("session_id").notNull().default(""),
  /** 工单标签（如 finance · CUST-8842 · TCK-3117，不含 PII） */
  questionLabel: text("question_label").notNull().default(""),
  /** 终态：completed（质检放行）| escalated（返工超限 / 证据不足转人工）| blocked（入口护栏拦截） */
  status: text("status").notNull(),
  /** QA 打回次数（0 = 一次过检） */
  reworkCount: integer("rework_count").notNull().default(0),
  /** 全流程总耗时（毫秒） */
  totalDurationMs: integer("total_duration_ms").notNull(),
  /** 全流程总费用（美元，文本防浮点精度问题） */
  totalCostUsd: text("total_cost_usd").notNull(),
  /** 分诊员轻量快档相对旗舰档的节省百分比 */
  triageSavingsPercent: integer("triage_savings_percent").notNull().default(0),
  /** 入口护栏是否拦截恶意注入 */
  inputGuardBlocked: boolean("input_guard_blocked").notNull().default(false),
  /** 转人工原因（escalated 时有值，不含 PII） */
  escalateReason: text("escalate_reason").notNull().default(""),
  /** 留痕时间戳 */
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Day 12 四代理专班 · 追踪瀑布明细表：每个岗位 / 护栏步骤一条（只增不改）
 * 瀑布图数据源：每步耗时、费用、Token 与状态（QA 打回 / 转人工 / 拦截）。
 * 边界：同上，只增不改——数据库触发器物理拒绝篡改。
 */
export const agentSpans = pgTable("agent_spans", {
  /** 自增主键 */
  id: serial("id").primaryKey(),
  /** 所属追踪编号（软关联 agent_traces.trace_id，日志独立存续，切断不丢） */
  traceId: text("trace_id").notNull(),
  /** 流水线内递增序号（瀑布图行序） */
  seq: integer("seq").notNull(),
  /** 岗位 / 护栏标识：triage | investigator | drafter | qa_reviewer | guard_input | guard_output */
  role: text("role").notNull(),
  /** 第几次尝试（QA 打回轮次；护栏与分诊恒为 1） */
  attempt: integer("attempt").notNull().default(1),
  /** 步骤名（中文大白话） */
  label: text("label").notNull(),
  /** 状态：ok | rejected（QA 打回）| rewritten（返工重写）| escalated（转人工）| blocked（拦截） */
  status: text("status").notNull(),
  /** 本步耗时（毫秒） */
  durationMs: integer("duration_ms").notNull(),
  /** 本步费用（美元，文本防浮点精度问题） */
  costUsd: text("cost_usd").notNull(),
  /** 输入 / 输出 Token 数（护栏与确定性引擎为 0） */
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  /** 一句话结果说明（不含 PII 明文） */
  detail: text("detail").notNull().default(""),
  /** 留痕时间戳 */
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Day 14 浏览器实验室 · 老 ERP 超期单据结构化入库表（WorkBot 自己的结构化存储）
 * 边界：本表是 WorkBot 侧的抓取产物副本，绝不回写老 ERP 生产库（Day 2 红线）；
 *      同一发票号重复抓取按最新快照覆盖（派生数据，非审计日志，允许更新 scraped_at）。
 */
export const erpScrapedInvoices = pgTable("erp_scraped_invoices", {
  /** 自增主键 */
  id: serial("id").primaryKey(),
  /** 租户 ID（Day 27 多租户逻辑隔离：抓取副本按租户归属） */
  tenantId: text("tenant_id").notNull().default("xingchen"),
  /** 发票号（业务主键，如 INV-2026-0901） */
  invoiceNo: text("invoice_no").notNull().unique(),
  /** 供应商名称（虚构演示数据） */
  supplier: text("supplier").notNull(),
  /** 金额（元，整数口径） */
  amount: integer("amount").notNull(),
  /** 到期日（YYYY-MM-DD） */
  dueDate: text("due_date").notNull(),
  /** 超期天数 */
  daysOverdue: integer("days_overdue").notNull(),
  /** 抓取来源页码（1~3） */
  sourcePage: integer("source_page").notNull(),
  /** 最近一次抓取入库时间 */
  scrapedAt: timestamp("scraped_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// 类型导出：全站统一从 schema 取行类型，严禁重新手写
export type IntakeRequestRow = typeof intakeRequests.$inferSelect;
export type ApprovalAuditLogRow = typeof approvalAuditLogs.$inferSelect;
export type LlmUsageLogRow = typeof llmUsageLogs.$inferSelect;
export type MemoryEpisodeRow = typeof memoryEpisodes.$inferSelect;
export type UserPreferenceRow = typeof userPreferences.$inferSelect;
export type AgentTraceRow = typeof agentTraces.$inferSelect;
export type AgentSpanRow = typeof agentSpans.$inferSelect;

/**
 * Day 15 企业尽调研究台 · 简报归档表（只增不改）
 * 溯源：AGENTS.md 日志红线（只增不改）；/research 纪律（结论必须可溯源，归档即留痕）。
 * 边界：归档后的简报任何人不得篡改——数据库触发器物理拒绝 UPDATE / DELETE，
 *      重新尽调只会生成新简报，绝不覆盖旧档。
 */
export const researchReports = pgTable("research_reports", {
  /** 自增主键 */
  id: serial("id").primaryKey(),
  /** 简报编号（业务主键，如 RA-20261126-0001） */
  reportId: text("report_id").notNull().unique(),
  /** 尽调课题原文（不含 PII） */
  topic: text("topic").notNull(),
  /** 总体风险评分（0-100） */
  overallScore: integer("overall_score").notNull(),
  /** 总体风险等级：低 | 中 | 高 */
  overallLevel: text("overall_level").notNull(),
  /** 覆盖供应商数量 */
  supplierCount: integer("supplier_count").notNull().default(0),
  /** FIN-001 强制人工审批缺口数 */
  fin001Gaps: integer("fin001_gaps").notNull().default(0),
  /** 自愈容错告警条数 */
  alertsCount: integer("alerts_count").notNull().default(0),
  /** 降级数据源清单（顿号分隔，可为空） */
  degradedSources: text("degraded_sources").notNull().default(""),
  /** 简报 Markdown 全文（导出与展示同源） */
  markdown: text("markdown").notNull(),
  /** 结构化简报 JSON（与前端展示完全同源，防篡改归档） */
  report: jsonb("report").$type<Record<string, unknown>>().notNull(),
  /** 归档操作人（演示环境为具名高管，不含其他 PII） */
  archivedBy: text("archived_by").notNull().default("demo-林总"),
  /** 归档时间戳 */
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ResearchReportRow = typeof researchReports.$inferSelect;
export type ErpScrapedInvoiceRow = typeof erpScrapedInvoices.$inferSelect;

/**
 * Day 19 提示词版本管理表：WorkBot 核心提示词的唯一真源（配置表，允许切换激活，不允许删史）
 * 溯源：AGENTS.md「验收即考卷」——提示词变更必须可追溯、可秒级回滚（无需重新部署）。
 * 边界：切换激活只改 is_active / activated_at；历史版本行永不删除，版本史完整可审计。
 */
export const promptVersions = pgTable("prompt_versions", {
  /** 自增主键 */
  id: serial("id").primaryKey(),
  /** 版本号（业务主键，如 v1.0 / v1.1） */
  version: text("version").notNull().unique(),
  /** 版本标签（中文大白话，如「稳定版」「故障演练版」） */
  label: text("label").notNull(),
  /** 提示词正文（注入每次对话的系统提示） */
  content: text("content").notNull(),
  /** 是否为故障版（故障版会复现违规幻觉，用于演练热回滚） */
  isFaulty: boolean("is_faulty").notNull().default(false),
  /** 是否为当前激活版本（全站恒有且仅有一个 true） */
  isActive: boolean("is_active").notNull().default(false),
  /** 最近一次被激活的时间（热回滚的审计口径） */
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  /** 版本入库时间 */
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Day 19 监控日志表：所有对话请求 / 响应在落库前强制过 scrubPii 脱敏（只增不改）
 * 溯源：AGENTS.md 日志红线（只增不改）+ 代码红线 3（严禁 PII 明文落库）。
 * 边界：request_text / response_text 已在服务端写入前完成确定性脱敏；
 *      数据库触发器物理拒绝 UPDATE / DELETE。
 */
export const monitorLogs = pgTable("monitor_logs", {
  /** 自增主键 */
  id: serial("id").primaryKey(),
  /** 日志来源：chat（对话工作台）等 */
  source: text("source").notNull().default("chat"),
  /** 会话标识（不含任何 PII） */
  sessionId: text("session_id").notNull().default(""),
  /** 问题标签（如「财务查重复扣款」，不含 PII） */
  questionLabel: text("question_label").notNull().default(""),
  /** 本次对话使用的提示词版本（如 v1.0 / v1.1，热回滚审计口径） */
  promptVersion: text("prompt_version").notNull().default(""),
  /** 用户请求原文（已过 scrubPii，PII 为 [REDACTED_PII]） */
  requestText: text("request_text").notNull(),
  /** 模型响应原文（已过 scrubPii，PII 为 [REDACTED_PII]） */
  responseText: text("response_text").notNull().default(""),
  /** 本条日志拦下的 PII 处数（手机号+身份证+银行卡） */
  piiRedactions: integer("pii_redactions").notNull().default(0),
  /** 本次请求总耗时（毫秒） */
  latencyMs: integer("latency_ms").notNull().default(0),
  /** 留痕时间戳 */
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type PromptVersionRow = typeof promptVersions.$inferSelect;
export type MonitorLogRow = typeof monitorLogs.$inferSelect;

/**
 * Day 18 跨重启持久化审批流 · 运行主表（状态表，可推进）
 * 溯源：FIN-001（大额强制人工审批）；「挂起不占内存」——挂起态只存 Postgres，
 *      dev 服务器断电重启后凭 runId 原样恢复，绝不依赖进程内内存。
 * 边界：本表是「状态」不是「日志」，允许按状态机推进（UPDATE 由 engine.ts 单点负责）；
 *      历史痕迹一律另存 workflow_events（只增不改）。
 */
export const workflowRuns = pgTable("workflow_runs", {
  /** 自增主键 */
  id: serial("id").primaryKey(),
  /** 租户 ID（Day 27 多租户逻辑隔离：审批流运行按租户归属） */
  tenantId: text("tenant_id").notNull().default("xingchen"),
  /** 运行编号（业务主键，如 WF-20261126-A1B2） */
  runId: text("run_id").notNull().unique(),
  /** 工单编号（如 T-2026-1101） */
  ticketNo: text("ticket_no").notNull(),
  /** 所属部门（FIN-001 只对财务部金额超 5 万触发） */
  department: text("department").notNull(),
  /** 客户姓名（展示层脱敏为 张*） */
  customerName: text("customer_name").notNull(),
  /** 单据申报总额（元，整数口径） */
  amountClaimed: integer("amount_claimed").notNull(),
  /** 单据明细行（desc / qty / unitPrice），算术校验的数据源 */
  items: jsonb("items").$type<WorkflowLineItem[]>().notNull().default([]),
  /** 编排引擎：postgres（等价演练模式）| inngest（真实 Inngest Dev Server） */
  engine: text("engine").notNull().default("postgres"),
  /**
   * 状态机当前阶段：
   * queued（已受理，等 Inngest 领取）| invalid（算术校验不过，流程终止）|
   * awaiting_approval（挂起等待林总审批，最长 7 天）| completed | rejected | expired
   */
  phase: text("phase").notNull().default("queued"),
  /** 是否触发 FIN-001 强制人工审批 */
  isFin001: boolean("is_fin001").notNull().default(false),
  /** 算术校验是否通过（申报总额 === Σ 数量×单价） */
  arithmeticOk: boolean("arithmetic_ok").notNull().default(false),
  /** 算术校验明细（逐行小计 + 汇总对比），供状态灯下方展开 */
  arithmeticDetail: jsonb("arithmetic_detail")
    .$type<WorkflowArithmeticDetail>()
    .notNull(),
  /** 审计凭据号（批准后生成，如 AP-WF-20261126-A1B2） */
  auditCredential: text("audit_credential").notNull().default(""),
  /** 具名审批人（完成 / 退回时写入） */
  approver: text("approver").notNull().default(""),
  /** 进入挂起态的时刻（跨重启判定：进程启动晚于它，即证明恢复跨越了一次重启） */
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  /** 挂起最长等待截止时刻（7 天，不占内存——纯数据库字段，无任何定时器） */
  waitExpiresAt: timestamp("wait_expires_at", { withTimezone: true }),
  /** 流程终态落定时刻 */
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  /** 创建时刻 */
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** 最近状态机推进时刻 */
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Day 18 · 运行事件流水表（只增不改）
 * 溯源：AGENTS.md 日志红线——全过程留痕带时间戳；修改/删除能力物理不存在（触发器拒绝）。
 * 每次状态机推进（入库 / 校验 / 挂起 / 批准 / 退回 / 过期 / 通知）都追加一条。
 */
export const workflowEvents = pgTable("workflow_events", {
  /** 自增主键（事件顺序以此为准） */
  id: serial("id").primaryKey(),
  /** 所属运行编号（软关联 workflow_runs.run_id，日志独立存续，切断不丢） */
  runId: text("run_id").notNull(),
  /** 事件类型：run_created | step1_intake | step1_invalid | suspended | approval_received | audit_written | downstream_notified | rejected | expired */
  eventType: text("event_type").notNull(),
  /** 一句话事件说明（中文大白话，不含 PII 明文） */
  detail: text("detail").notNull().default(""),
  /** 留痕时间戳 */
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Day 18 · MCP Tasks 异步长任务表（状态表，可按轮询推进）
 * 进度是「时间的确定性函数」：progress = (now - started_at) / total_ms，
 * 没有任何后台定时器/内存计时器——服务器重启后按同一公式照常续算，天然断电不丢。
 */
export const mcpTasks = pgTable("mcp_tasks", {
  /** 自增主键 */
  id: serial("id").primaryKey(),
  /** 任务编号（业务主键，如 MCP-20261126-X9Y8，即 MCP Tasks 规范里的 taskId） */
  taskId: text("task_id").notNull().unique(),
  /** 任务类型：overdue_invoice_audit（超期发票批量核对） */
  taskType: text("task_type").notNull(),
  /** 任务标题（中文大白话） */
  label: text("label").notNull(),
  /** 预计总耗时（毫秒，演示用 20 秒量级） */
  totalMs: integer("total_ms").notNull(),
  /** 开工时刻（进度公式基准点） */
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** 阶段权重清单（label + weight，权重总和 = 100，用于推导当前所处阶段） */
  steps: jsonb("steps").$type<WorkflowTaskStep[]>().notNull().default([]),
  /** 确定性结果（开工前即定稿，进度到 100% 才对外揭晓） */
  result: jsonb("result").$type<Record<string, unknown>>(),
  /** 创建时刻 */
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** 单据明细行（算术校验数据源） */
export interface WorkflowLineItem {
  desc: string;
  qty: number;
  unitPrice: number;
}

/** 算术校验明细（逐行小计 + 汇总对比） */
export interface WorkflowArithmeticDetail {
  lines: Array<{ desc: string; qty: number; unitPrice: number; subtotal: number }>;
  computedTotal: number;
  claimedTotal: number;
  ok: boolean;
}

/** MCP 任务阶段（权重求和 = 100） */
export interface WorkflowTaskStep {
  label: string;
  weight: number;
}

export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
export type WorkflowEventRow = typeof workflowEvents.$inferSelect;
export type McpTaskRow = typeof mcpTasks.$inferSelect;
