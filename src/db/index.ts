/**
 * 数据库连接层（postgres.js 驱动 + Drizzle）
 * 溯源：AGENTS.md 代码红线 2（密钥只进环境变量，严禁硬编码/打印）；
 *      04 号文档 CISO 条款 4（审计日志只增不改 → 建表时挂物理触发器）。
 * 兼容：Neon / Supabase 的免费 Postgres 连接串可直接使用（自动识别 sslmode）。
 */

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/** 数据库客户端类型（全站统一引用，避免重复手写） */
export type WorkBotDatabase = PostgresJsDatabase<typeof schema>;

// 全局单例：Next.js 开发模式热重载时复用连接，避免连接池打满
declare global {
  var __workbotPg: postgres.Sql | undefined;
}

function getConnectionUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url || url.trim().length === 0) {
    throw new Error(
      "数据库未接入：请在项目根目录 .env.local 中填写 DATABASE_URL（Neon 或 Supabase 免费 Postgres 连接串），然后重启开发服务器。",
    );
  }
  return url.trim();
}

function getClient(): postgres.Sql {
  if (globalThis.__workbotPg) return globalThis.__workbotPg;
  const sql = postgres(getConnectionUrl(), {
    // 免费云库连接串自带 sslmode=require，这里兜底开启
    ssl: "prefer",
    // Serverless/边缘环境连接数要克制
    max: 5,
  });
  globalThis.__workbotPg = sql;
  return sql;
}

/** Drizzle 实例（工单 / 审计日志的读写唯一入口） */
export function getDb(): WorkBotDatabase {
  return drizzle(getClient(), { schema });
}

/**
 * Day 39 只读分析代理专用：暴露底层 postgres.Sql 客户端（仅用于只读角色 bootstrap，
 * 管理面操作与业务查询一律走 getDb() / 专用只读连接，不经过此函数）。
 */
export function getRawSqlClient(): postgres.Sql {
  return getClient();
}

export { schema };

/**
 * 物理审计触发器：审批日志表禁止 UPDATE / DELETE（红区 R3——不是提示词劝阻，是数据库层拒绝）
 */
const AUDIT_IMMUTABLE_TRIGGER_SQL = `
  CREATE OR REPLACE FUNCTION forbid_audit_log_mutation() RETURNS trigger AS $fn$
  BEGIN
    RAISE EXCEPTION '审计日志只增不改：% 操作已被数据库层拒绝（04号文档红区 R3）', TG_OP;
  END;
  $fn$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS approval_audit_logs_immutable ON approval_audit_logs;
  CREATE TRIGGER approval_audit_logs_immutable
    BEFORE UPDATE OR DELETE ON approval_audit_logs
    FOR EACH ROW EXECUTE FUNCTION forbid_audit_log_mutation();
`;

/** 建表 DDL：幂等，可重复执行 */
const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS intake_requests (
    id            serial PRIMARY KEY,
    ticket_no     text NOT NULL UNIQUE,
    department    text NOT NULL,
    amount        integer NOT NULL,
    summary       text NOT NULL,
    status        text NOT NULL DEFAULT '待林总审批',
    approved_at   timestamptz,
    customer_name text NOT NULL,
    bank_account  text NOT NULL,
    is_fin001     boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS approval_audit_logs (
    id         serial PRIMARY KEY,
    ticket_no  text NOT NULL,
    approver   text NOT NULL,
    action     text NOT NULL,
    is_fin001  boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS llm_usage_logs (
    id               serial PRIMARY KEY,
    provider_id      text NOT NULL,
    model            text NOT NULL,
    mode             text NOT NULL,
    effort           text NOT NULL,
    ttft_ms          integer NOT NULL,
    total_ms         integer NOT NULL,
    input_tokens     integer NOT NULL,
    output_tokens    integer NOT NULL,
    usd_cost         text NOT NULL,
    was_fallback     boolean NOT NULL DEFAULT false,
    simulated_outage boolean NOT NULL DEFAULT false,
    session_id       text NOT NULL DEFAULT '',
    question_label   text NOT NULL DEFAULT '',
    created_at       timestamptz NOT NULL DEFAULT now()
  );

  -- Day 9 三层记忆：情景记忆 / 语义记忆（允许编辑删除，不挂只增不改触发器）
  CREATE TABLE IF NOT EXISTS memory_episodes (
    id           serial PRIMARY KEY,
    session_id   text NOT NULL DEFAULT '',
    episode_type text NOT NULL,
    content      text NOT NULL,
    ticket_refs  text NOT NULL DEFAULT '',
    enabled      boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS user_preferences (
    id             serial PRIMARY KEY,
    user_key       text NOT NULL UNIQUE,
    display_name   text NOT NULL DEFAULT '',
    department     text NOT NULL DEFAULT '',
    style          text NOT NULL DEFAULT '',
    facts          jsonb NOT NULL DEFAULT '[]'::jsonb,
    disabled_facts jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_at     timestamptz NOT NULL DEFAULT now()
  );

  -- Day 12 四代理专班：追踪主表 + 瀑布明细表（只增不改，不提供任何修改入口）
  CREATE TABLE IF NOT EXISTS agent_traces (
    id                     serial PRIMARY KEY,
    trace_id               text NOT NULL UNIQUE,
    session_id             text NOT NULL DEFAULT '',
    question_label         text NOT NULL DEFAULT '',
    status                 text NOT NULL,
    rework_count           integer NOT NULL DEFAULT 0,
    total_duration_ms      integer NOT NULL,
    total_cost_usd         text NOT NULL,
    triage_savings_percent integer NOT NULL DEFAULT 0,
    input_guard_blocked    boolean NOT NULL DEFAULT false,
    escalate_reason        text NOT NULL DEFAULT '',
    created_at             timestamptz NOT NULL DEFAULT now()
  );

  -- Day 14 浏览器实验室：老 ERP 超期单据结构化入库（WorkBot 侧副本，不回写老 ERP 生产库）
  CREATE TABLE IF NOT EXISTS erp_scraped_invoices (
    id            serial PRIMARY KEY,
    invoice_no    text NOT NULL UNIQUE,
    supplier      text NOT NULL,
    amount        integer NOT NULL,
    due_date      text NOT NULL,
    days_overdue  integer NOT NULL,
    source_page   integer NOT NULL,
    scraped_at    timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS agent_spans (
    id            serial PRIMARY KEY,
    trace_id      text NOT NULL,
    seq           integer NOT NULL,
    role          text NOT NULL,
    attempt       integer NOT NULL DEFAULT 1,
    label         text NOT NULL,
    status        text NOT NULL,
    duration_ms   integer NOT NULL,
    cost_usd      text NOT NULL,
    input_tokens  integer NOT NULL DEFAULT 0,
    output_tokens integer NOT NULL DEFAULT 0,
    detail        text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now()
  );

  -- Day 15 尽调研究台：简报归档表（只增不改，重新尽调只产新简报，绝不覆盖旧档）
  CREATE TABLE IF NOT EXISTS research_reports (
    id               serial PRIMARY KEY,
    report_id        text NOT NULL UNIQUE,
    topic            text NOT NULL,
    overall_score    integer NOT NULL,
    overall_level    text NOT NULL,
    supplier_count   integer NOT NULL DEFAULT 0,
    fin001_gaps      integer NOT NULL DEFAULT 0,
    alerts_count     integer NOT NULL DEFAULT 0,
    degraded_sources text NOT NULL DEFAULT '',
    markdown         text NOT NULL,
    report           jsonb NOT NULL,
    archived_by      text NOT NULL DEFAULT 'demo-林总',
    created_at       timestamptz NOT NULL DEFAULT now()
  );

  -- Day 18 跨重启持久化审批流：运行状态表（状态机单点推进，挂起态只存库里不占内存）
  CREATE TABLE IF NOT EXISTS workflow_runs (
    id                serial PRIMARY KEY,
    run_id            text NOT NULL UNIQUE,
    ticket_no         text NOT NULL,
    department        text NOT NULL,
    customer_name     text NOT NULL,
    amount_claimed    integer NOT NULL,
    items             jsonb NOT NULL DEFAULT '[]'::jsonb,
    engine            text NOT NULL DEFAULT 'postgres',
    phase             text NOT NULL DEFAULT 'queued',
    is_fin001         boolean NOT NULL DEFAULT false,
    arithmetic_ok     boolean NOT NULL DEFAULT false,
    arithmetic_detail jsonb NOT NULL,
    audit_credential  text NOT NULL DEFAULT '',
    approver          text NOT NULL DEFAULT '',
    suspended_at      timestamptz,
    wait_expires_at   timestamptz,
    finished_at       timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
  );

  -- Day 18 运行事件流水表（只增不改，全过程留痕）
  CREATE TABLE IF NOT EXISTS workflow_events (
    id         serial PRIMARY KEY,
    run_id     text NOT NULL,
    event_type text NOT NULL,
    detail     text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
  );

  -- Day 18 MCP Tasks 异步长任务表（进度 = 时间的确定性函数，重启照常续算）
  CREATE TABLE IF NOT EXISTS mcp_tasks (
    id         serial PRIMARY KEY,
    task_id    text NOT NULL UNIQUE,
    task_type  text NOT NULL,
    label      text NOT NULL,
    total_ms   integer NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    steps      jsonb NOT NULL DEFAULT '[]'::jsonb,
    result     jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  -- Day 36 BYOK 信封加密：敏感单据密文库（敏感字段只存信封密文，明文永不落库；
  -- 派生演示数据非审计日志，允许按 (tenant_id, ticket_no) 幂等补种）
  CREATE TABLE IF NOT EXISTS byok_secure_docs (
    id         serial PRIMARY KEY,
    tenant_id  text NOT NULL,
    ticket_no  text NOT NULL,
    department text NOT NULL DEFAULT '',
    amount     integer NOT NULL DEFAULT 0,
    summary    text NOT NULL DEFAULT '',
    envelope   jsonb NOT NULL,
    key_fp     text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_byok_secure_docs_ticket
    ON byok_secure_docs (tenant_id, ticket_no);

  -- Day 19 提示词版本管理表（配置表：可切换激活，历史版本永不删除）
  CREATE TABLE IF NOT EXISTS prompt_versions (
    id           serial PRIMARY KEY,
    version      text NOT NULL UNIQUE,
    label        text NOT NULL,
    content      text NOT NULL,
    is_faulty    boolean NOT NULL DEFAULT false,
    is_active    boolean NOT NULL DEFAULT false,
    activated_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
  );

  -- Day 19 监控日志表（只增不改；request/response 已在服务端过 scrubPii 脱敏）
  CREATE TABLE IF NOT EXISTS monitor_logs (
    id              serial PRIMARY KEY,
    source          text NOT NULL DEFAULT 'chat',
    session_id      text NOT NULL DEFAULT '',
    question_label  text NOT NULL DEFAULT '',
    prompt_version  text NOT NULL DEFAULT '',
    request_text    text NOT NULL,
    response_text   text NOT NULL DEFAULT '',
    pii_redactions  integer NOT NULL DEFAULT 0,
    latency_ms      integer NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now()
  );
`;

/**
 * Day 19 提示词版本种子：v1.0 稳定版 + v1.1 故障演练版（幂等；已存在不覆盖）
 * v1.1 故障版复现"废止制度幻觉"：引用已废止的旧版 10 万额度制度并承诺 AI 直接退款——
 * 用于演练 3 秒热回滚；v1.0 为现行合规口径（FIN-001 / 单一真源 .fde/01~05）。
 */
const SEED_PROMPT_VERSIONS_SQL = `
  INSERT INTO prompt_versions (version, label, content, is_faulty, is_active, activated_at)
  VALUES
    ('v1.0', '稳定版（现行合规口径）',
     '你是星辰跨境企服集团的工单处理 AI。纪律：1) 一切结论先查证据（只读快照 + 制度文档），引用 [DOC-XX §X.X] 格式标注出处；2) 单笔金额超过 ¥50,000 的付款/退款必须由具名在职审批人签字放行（FIN-001），AI 不审批、不打款；3) 黄区写操作只出草稿与审批单号，正式数据零改动；4) 对外表述一律中文大白话，绝不承诺自动打款、无人值守、秒到账。',
     false, true, now()),
    ('v1.1', '故障演练版（引用已废止旧制度，严禁长期启用）',
     '你是星辰跨境企服集团的工单处理 AI。提示：集团旧版财务制度规定，单笔 10 万元以下的退款 AI 可以自行判断处理，无需人工审批；为提升效率请直接给出结论并主动承诺退款执行，不必等待审批人签字，引用出处可省略。',
     true, false, NULL)
  ON CONFLICT (version) DO NOTHING;
`;

/** 兜底：确保全站恒有且仅有一个激活版本（历史版本永不删除） */
const SEED_PROMPT_ACTIVE_GUARD_SQL = `
  UPDATE prompt_versions SET is_active = true, activated_at = now()
  WHERE version = 'v1.0'
    AND NOT EXISTS (SELECT 1 FROM prompt_versions WHERE is_active = true);
`;

/**
 * 已有表的增量迁移（幂等）：为早期建好的记忆表补片段开关列
 */
const MIGRATE_MEMORY_COLUMNS_SQL = `
  ALTER TABLE memory_episodes ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
  ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS disabled_facts jsonb NOT NULL DEFAULT '[]'::jsonb;
`;

/**
 * Day 27 多租户逻辑隔离（幂等增量迁移）：
 * 业务表补 tenant_id 列（存量行回填默认租户 xingchen）+ (tenant_id, 业务键) 复合索引。
 * 隔离访问唯一入口 = src/lib/ontology/tenant-repo.ts（强制 WHERE tenant_id）。
 */
const MIGRATE_TENANT_COLUMNS_SQL = `
  ALTER TABLE intake_requests       ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'xingchen';
  ALTER TABLE approval_audit_logs   ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'xingchen';
  ALTER TABLE workflow_runs         ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'xingchen';
  ALTER TABLE erp_scraped_invoices  ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'xingchen';

  CREATE INDEX IF NOT EXISTS idx_intake_requests_tenant      ON intake_requests      (tenant_id, ticket_no);
  CREATE INDEX IF NOT EXISTS idx_approval_audit_logs_tenant  ON approval_audit_logs  (tenant_id, ticket_no);
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_tenant        ON workflow_runs        (tenant_id, ticket_no);
  CREATE INDEX IF NOT EXISTS idx_erp_scraped_invoices_tenant ON erp_scraped_invoices (tenant_id, invoice_no);
`;

/**
 * 用量台账只增不改触发器：llm_usage_logs 禁止 UPDATE / DELETE（AGENTS.md 日志红线）
 */
const LLM_LOG_IMMUTABLE_TRIGGER_SQL = `
  DROP TRIGGER IF EXISTS llm_usage_logs_immutable ON llm_usage_logs;
  CREATE TRIGGER llm_usage_logs_immutable
    BEFORE UPDATE OR DELETE ON llm_usage_logs
    FOR EACH ROW EXECUTE FUNCTION forbid_audit_log_mutation();
`;

/**
 * Day 12 四代理专班追踪表只增不改触发器：agent_traces / agent_spans
 * 禁止 UPDATE / DELETE（AGENTS.md 日志红线——专班全过程留痕，切断不丢）
 */
const AGENT_TRACE_IMMUTABLE_TRIGGER_SQL = `
  DROP TRIGGER IF EXISTS agent_traces_immutable ON agent_traces;
  CREATE TRIGGER agent_traces_immutable
    BEFORE UPDATE OR DELETE ON agent_traces
    FOR EACH ROW EXECUTE FUNCTION forbid_audit_log_mutation();

  DROP TRIGGER IF EXISTS agent_spans_immutable ON agent_spans;
  CREATE TRIGGER agent_spans_immutable
    BEFORE UPDATE OR DELETE ON agent_spans
    FOR EACH ROW EXECUTE FUNCTION forbid_audit_log_mutation();
`;

/**
 * Day 15 尽调简报归档表只增不改触发器：research_reports 禁止 UPDATE / DELETE
 * （AGENTS.md 日志红线——归档即留痕，任何人不得篡改历史简报）
 */
const RESEARCH_REPORT_IMMUTABLE_TRIGGER_SQL = `
  DROP TRIGGER IF EXISTS research_reports_immutable ON research_reports;
  CREATE TRIGGER research_reports_immutable
    BEFORE UPDATE OR DELETE ON research_reports
    FOR EACH ROW EXECUTE FUNCTION forbid_audit_log_mutation();
`;

/**
 * Day 18 运行事件流水表只增不改触发器：workflow_events 禁止 UPDATE / DELETE
 * （AGENTS.md 日志红线——审批流全过程留痕，切断不丢、篡改无效）
 */
const WORKFLOW_EVENT_IMMUTABLE_TRIGGER_SQL = `
  DROP TRIGGER IF EXISTS workflow_events_immutable ON workflow_events;
  CREATE TRIGGER workflow_events_immutable
    BEFORE UPDATE OR DELETE ON workflow_events
    FOR EACH ROW EXECUTE FUNCTION forbid_audit_log_mutation();
`;

/**
 * Day 19 监控日志表只增不改触发器：monitor_logs 禁止 UPDATE / DELETE
 * （AGENTS.md 日志红线——监控日志写入前已过 scrubPii 脱敏，落库后任何人不得篡改）
 */
const MONITOR_LOG_IMMUTABLE_TRIGGER_SQL = `
  DROP TRIGGER IF EXISTS monitor_logs_immutable ON monitor_logs;
  CREATE TRIGGER monitor_logs_immutable
    BEFORE UPDATE OR DELETE ON monitor_logs
    FOR EACH ROW EXECUTE FUNCTION forbid_audit_log_mutation();
`;

let schemaReady: Promise<void> | null = null;

/**
 * 确保表结构与审计触发器就绪（进程内只执行一次；失败不缓存，可重试）
 */
export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const sql = getClient();
      await sql.unsafe(CREATE_TABLES_SQL);
      await sql.unsafe(MIGRATE_MEMORY_COLUMNS_SQL);
      // Day 27：多租户 tenant_id 列与复合索引（幂等；审计表加列与只增触发器互不影响）
      await sql.unsafe(MIGRATE_TENANT_COLUMNS_SQL);
      await sql.unsafe(AUDIT_IMMUTABLE_TRIGGER_SQL);
      // llm_usage_logs 的触发器依赖 forbid_audit_log_mutation()（上面已创建），在其后挂载
      await sql.unsafe(LLM_LOG_IMMUTABLE_TRIGGER_SQL);
      // agent_traces / agent_spans 同样复用 forbid_audit_log_mutation()（只增不改）
      await sql.unsafe(AGENT_TRACE_IMMUTABLE_TRIGGER_SQL);
      // research_reports 归档简报同样只增不改（Day 15）
      await sql.unsafe(RESEARCH_REPORT_IMMUTABLE_TRIGGER_SQL);
      // workflow_events 审批流事件流水只增不改（Day 18）
      await sql.unsafe(WORKFLOW_EVENT_IMMUTABLE_TRIGGER_SQL);
      // Day 19：提示词版本种子（幂等）+ 激活兜底
      await sql.unsafe(SEED_PROMPT_VERSIONS_SQL);
      await sql.unsafe(SEED_PROMPT_ACTIVE_GUARD_SQL);
      // monitor_logs 监控日志只增不改（Day 19）
      await sql.unsafe(MONITOR_LOG_IMMUTABLE_TRIGGER_SQL);
    })().catch((err: unknown) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

/** 进程结束时主动断开（避免本地 free 套餐连接悬挂） */
export async function closeDb(): Promise<void> {
  if (globalThis.__workbotPg) {
    await globalThis.__workbotPg.end();
    globalThis.__workbotPg = undefined;
  }
}
