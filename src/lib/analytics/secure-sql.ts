/**
 * Day 39 五重安全死锁 SQL 执行器（secure-sql.ts）
 * 溯源：AGENTS.md 红区「严禁直写业务系统正式数据」「物理 Kill Switch 优先」；
 *      Day 39 需求：只读 SQL 分析代理的 5 层死锁防线。
 *
 * ① 仅限 SELECT 词法白名单（语句形态 + 可触达表白名单 + 危险函数黑名单）
 * ② 严禁多语句分号与写动词（DROP/DELETE/UPDATE/INSERT/SET/FOR UPDATE …）
 * ③ tenant_id 租户隔离条件强制校验（模板自动拼入 + 校验器 fail-closed 复核）
 * ④ 强制 LIMIT 100 + 3 秒查询超时（数据库层 statement_timeout 物理挂载）
 * ⑤ 连接层只读兜底（专用只读角色 workbot_ro，降级时事务级 BEGIN READ ONLY）
 *
 * 设计原则：宁可错杀（fail-closed），绝不硬凑放行；任何一层拦截即整条 SQL 作废。
 */

import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { getRawSqlClient } from "@/db";

/* ================================================================
 * 一、常量与类型
 * ================================================================ */

export const ANALYTICS_LIMIT_MAX = 100;
export const ANALYTICS_STATEMENT_TIMEOUT_MS = 3000;
export const ANALYTICS_JS_TIMEOUT_MS = ANALYTICS_STATEMENT_TIMEOUT_MS + 200;
export const READONLY_ROLE_NAME = "workbot_ro";

/** 分析代理允许触达的表白名单（第①重） */
export const ANALYTICS_TABLE_WHITELIST = [
  "intake_requests",
  "approval_audit_logs",
  "agent_traces",
  "agent_spans",
  "llm_usage_logs",
  "workflow_runs",
  "workflow_events",
  "research_reports",
  "monitor_logs",
  "erp_scraped_invoices",
] as const;

/** 租户隔离表（第③重的强制对象；缺 tenant_id 条件一律拦截） */
export const TENANT_SCOPED_TABLES = [
  "intake_requests",
  "approval_audit_logs",
  "workflow_runs",
  "erp_scraped_invoices",
] as const;

/** 第②重：写动词黑名单（词边界匹配，作用于剥离字符串字面量后的纯代码） */
const WRITE_KEYWORDS =
  /\b(drop|delete|update|insert|truncate|set|reset|prepare|execute|grant|revoke|alter|create|copy|vacuum|merge|call|do|listen|notify|cluster|reindex|comment|lock|with)\b/i;

/** 第①重：危险函数黑名单（读文件 / 关连接 / 拖时间等逃逸向量） */
const DANGEROUS_FUNCTIONS =
  /\b(pg_sleep|pg_sleep_for|pg_sleep_until|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|dblink|dblink_send_query|lo_import|lo_export|lo_get_fragment|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_create_restore_point|pg_replication_origin|pg_logical_slot|pg_current_logfile|current_setting|set_config|query_to_xml|ts_read_file)\s*\(/i;

const LAYER_TITLES = [
  "① 仅限 SELECT 词法白名单",
  "② 禁多语句与写动词",
  "③ tenant_id 租户隔离",
  "④ LIMIT 100 + 3 秒超时",
  "⑤ 连接层只读兜底",
] as const;

export type LayerNumber = 1 | 2 | 3 | 4 | 5;

export type LayerVerdict = "pass" | "enforced" | "clamped" | "blocked";

export interface LayerAudit {
  layer: LayerNumber;
  title: string;
  verdict: LayerVerdict;
  detail: string;
}

export interface ValidateContext {
  /** 服务端会话租户（绝不取自客户端输入） */
  tenantId: string;
  /** 计划是否声明触碰租户业务表（声明了就必须带 tenant_id 条件） */
  scoped: boolean;
}

export interface ValidateResult {
  ok: boolean;
  blockedLayer: LayerNumber | null;
  audits: LayerAudit[];
  /** 校验后允许执行的最终 SQL（可能被第④重改写 LIMIT） */
  finalSql: string;
}

/* ================================================================
 * 二、词法剥离：把字符串字面量 / 注释 / 引号标识符的内容置空，
 *    防止「把恶意 SQL 藏进字符串」骗过正则；未闭合引号 = 词法失败。
 * ================================================================ */

interface ScrubOutcome {
  scrubbed: string;
  malformed: boolean;
}

export function scrubLexical(raw: string): ScrubOutcome {
  const out: string[] = [];
  let state: "code" | "line" | "block" | "str" | "qid" | "dollar" = "code";
  let dollarTag = "";
  let i = 0;
  const n = raw.length;

  while (i < n) {
    const c = raw[i];
    const c2 = raw.slice(i, i + 2);

    if (state === "code") {
      if (c2 === "--") { state = "line"; out.push("  "); i += 2; continue; }
      if (c2 === "/*") { state = "block"; out.push("  "); i += 2; continue; }
      if (c === "'") { state = "str"; out.push("'"); i += 1; continue; }
      if (c === '"') { state = "qid"; out.push("#"); i += 1; continue; }
      if (c === "$") {
        const m = /^\$[A-Za-z0-9_]*\$/.exec(raw.slice(i));
        if (m) { state = "dollar"; dollarTag = m[0]; out.push("#".repeat(m[0].length)); i += m[0].length; continue; }
      }
      out.push(c); i += 1; continue;
    }
    if (state === "line") {
      if (c === "\n" || c === "\r") { state = "code"; out.push(c); } else { out.push(" "); }
      i += 1; continue;
    }
    if (state === "block") {
      if (c2 === "*/") { state = "code"; out.push("  "); i += 2; }
      else { out.push(c === "\n" ? "\n" : " "); i += 1; }
      continue;
    }
    if (state === "str") {
      if (c2 === "''") { out.push("  "); i += 2; continue; }
      if (c === "'") { state = "code"; out.push("'"); i += 1; continue; }
      out.push(" "); i += 1; continue;
    }
    if (state === "qid") {
      if (c2 === '""') { out.push("  "); i += 2; continue; }
      if (c === '"') { state = "code"; out.push("#"); i += 1; continue; }
      out.push(" "); i += 1; continue;
    }
    // dollar
    if (raw.startsWith(dollarTag, i)) {
      out.push("#".repeat(dollarTag.length)); i += dollarTag.length; state = "code"; continue;
    }
    out.push(c === "\n" ? "\n" : " "); i += 1;
  }

  return { scrubbed: out.join(""), malformed: state !== "code" };
}

/* ================================================================
 * 三、五重死锁校验器（纯函数，无 IO；护栏自检也复用它）
 * ================================================================ */

function auditEntry(layer: LayerNumber, verdict: LayerVerdict, detail: string): LayerAudit {
  return { layer, title: LAYER_TITLES[layer - 1], verdict, detail };
}

function skippedEntry(layer: LayerNumber): LayerAudit {
  return { layer, title: LAYER_TITLES[layer - 1], verdict: "pass", detail: "前序层已拦截，本层未进入（死锁即止）" };
}

function extractTables(scrubbed: string): string[] {
  const names: string[] = [];
  const re = /\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_.]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scrubbed)) !== null) {
    names.push(m[1].toLowerCase().split(".")[0]);
  }
  return [...new Set(names)];
}

export function validateSecureSql(rawSql: string, ctx: ValidateContext): ValidateResult {
  const audits: LayerAudit[] = [];
  let finalSql = rawSql.trim().replace(/\s+/g, " ");
  const block = (layer: LayerNumber, detail: string): ValidateResult => {
    audits.push(auditEntry(layer, "blocked", detail));
    for (let l = layer + 1; l <= 5; l += 1) audits.push(skippedEntry(l as LayerNumber));
    return { ok: false, blockedLayer: layer, audits, finalSql };
  };

  /* ---- 第①重：仅限 SELECT 词法白名单 ---- */
  const { scrubbed, malformed } = scrubLexical(finalSql);
  if (malformed) {
    return block(1, "存在未闭合的字符串/引号/注释：词法解析失败，宁杀错不放过");
  }
  if (!/^select\b/i.test(scrubbed.trim())) {
    return block(1, `语句开头不是 SELECT（首词法单元被拒绝）：${scrubbed.trim().slice(0, 24) || "空语句"}`);
  }
  const fnHit = DANGEROUS_FUNCTIONS.exec(scrubbed);
  if (fnHit) {
    return block(1, `命中危险函数黑名单：${fnHit[1]}()（逃逸向量一律拒绝）`);
  }
  const tables = extractTables(scrubbed);
  const illegal = tables.filter((t) => !ANALYTICS_TABLE_WHITELIST.includes(t as (typeof ANALYTICS_TABLE_WHITELIST)[number]));
  if (illegal.length > 0) {
    return block(1, `触达表白名单之外的表：${illegal.join("、")}（information_schema 等系统目录不可见）`);
  }
  audits.push(auditEntry(1, "pass", `SELECT 形态 ✓ 白名单表 ${tables.length ? tables.join("、") : "（纯计算，无表）"} ✓ 无危险函数 ✓`));

  /* ---- 第②重：多语句分号 + 写动词深扫 + 行锁写意图 ---- */
  if (scrubbed.includes(";")) {
    return block(2, "检测到分号：疑似多语句串接（一问一 SQL，多语句直接作废）");
  }
  const writeHit = WRITE_KEYWORDS.exec(scrubbed);
  if (writeHit) {
    return block(2, `深扫命中写动词：${writeHit[1].toUpperCase()}`);
  }
  if (/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i.test(scrubbed)) {
    return block(2, "SELECT ... FOR UPDATE/SHARE 行锁写意图被拒绝");
  }
  audits.push(auditEntry(2, "pass", "无分号多语句 ✓ 无写动词 ✓ 无行锁写意图 ✓"));

  /* ---- 第③重：tenant_id 租户隔离强制 ---- */
  const mentionsTenantTable = tables.some((t) => TENANT_SCOPED_TABLES.includes(t as (typeof TENANT_SCOPED_TABLES)[number]));
  if (mentionsTenantTable && !ctx.scoped) {
    return block(3, `计划未声明租户隔离却触碰租户业务表（${tables.join("、")}）：fail-closed 拦截`);
  }
  if (ctx.scoped) {
    const tenantOk = /\btenant_id\s*=\s*\$\d+\b/i.test(scrubbed);
    if (!tenantOk) {
      return block(3, "缺少 tenant_id = $n 强制条件：租户隔离缺失，拒绝执行（模板拼入 + 校验器复核双重锁）");
    }
    audits.push(auditEntry(3, "enforced", `模板已自动拼入 tenant_id = $n，值由服务端注入「${ctx.tenantId}」，客户端不可影响`));
  } else {
    audits.push(auditEntry(3, "pass", "纯统计表（无租户列），且未触碰任何租户业务表"));
  }

  /* ---- 第④重：LIMIT 100 + 3 秒超时 ---- */
  const limits = [...scrubbed.matchAll(/\blimit\s+(\d+)\b/gi)];
  if (limits.length > 1) {
    return block(4, `检测到 ${limits.length} 段 LIMIT（子查询藏 LIMIT 规避上限），直接作废`);
  }
  let limitVerdict: LayerVerdict = "enforced";
  let limitDetail = `已强制拼入 LIMIT ${ANALYTICS_LIMIT_MAX}`;
  if (limits.length === 1) {
    const n = Number(limits[0][1]);
    if (n > ANALYTICS_LIMIT_MAX) {
      finalSql = finalSql.replace(/\blimit\s+\d+\b/i, `LIMIT ${ANALYTICS_LIMIT_MAX}`);
      limitVerdict = "clamped";
      limitDetail = `原 LIMIT ${n} 超上限，已强制钳制为 LIMIT ${ANALYTICS_LIMIT_MAX}`;
    } else {
      limitVerdict = "pass";
      limitDetail = `自带 LIMIT ${n} ≤ ${ANALYTICS_LIMIT_MAX} 上限，放行`;
    }
  } else {
    finalSql = `${finalSql} LIMIT ${ANALYTICS_LIMIT_MAX}`;
  }
  audits.push(auditEntry(4, limitVerdict, `${limitDetail}；statement_timeout = ${ANALYTICS_STATEMENT_TIMEOUT_MS}ms 由数据库层物理挂载，超时即中止（57014）`));

  /* ---- 第⑤重：连接层只读兜底（执行时生效，这里标注结论） ---- */
  audits.push(auditEntry(5, "enforced", `执行连接 = ${READONLY_ROLE_NAME} 只读角色（仅 SELECT 授权）；降级时事务级 BEGIN READ ONLY + 会话 default_transaction_read_only=on`));

  return { ok: true, blockedLayer: null, audits, finalSql };
}

/* ================================================================
 * 四、连接层（第⑤重实体）：专用只读客户端
 *    优先创建只读角色 workbot_ro（仅 SELECT 授权）；云库权限受限时
 *    自动降级为主连接 + 会话级 default_transaction_read_only=on。
 * ================================================================ */

interface AnalyticsClient {
  client: postgres.Sql;
  mechanism: string;
  roleActive: boolean;
}

let clientPromise: Promise<AnalyticsClient> | null = null;

declare global {
  // 开发热重载时复用同一份只读客户端（与主连接池同一惯例）
  var __workbotAnalyticsClient: Promise<AnalyticsClient> | undefined;
}

function baseConnectionOptions() {
  // postgres.js 连接参数：会话级只读 + 会话级 3 秒超时（第④/⑤重的连接层实体）
  return {
    max: 2,
    connect_timeout: 3,
    connection: {
      default_transaction_read_only: true,
      statement_timeout: ANALYTICS_STATEMENT_TIMEOUT_MS,
      application_name: "workbot-analytics-readonly",
    },
  };
}

async function bootstrapAnalyticsClient(): Promise<AnalyticsClient> {
  const url = process.env.DATABASE_URL;
  if (!url || url.trim().length === 0) {
    throw new Error("数据库未接入：请在 .env.local 配置 DATABASE_URL 后重启开发服务器。");
  }

  // 尝试创建 / 复位只读角色（最佳努力；云库权限受限时走降级路径）
  try {
    const admin = getRawSqlClient();
    const pwd = `wr_${randomUUID().replace(/-/g, "")}`;
    const existing = await admin.unsafe("SELECT 1 FROM pg_roles WHERE rolname = $1", [READONLY_ROLE_NAME]);
    if (existing.length === 0) {
      await admin.unsafe(`CREATE ROLE ${READONLY_ROLE_NAME} LOGIN PASSWORD '${pwd}'`);
    } else {
      // 角色由本进程历史运行创建，密码不可知 → 直接复位（该角色仅本代理使用）
      await admin.unsafe(`ALTER ROLE ${READONLY_ROLE_NAME} PASSWORD '${pwd}'`);
    }
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${READONLY_ROLE_NAME}`);
    await admin.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${READONLY_ROLE_NAME}`);
    await admin.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${READONLY_ROLE_NAME}`);

    const client = postgres(url.trim(), { ...baseConnectionOptions(), user: READONLY_ROLE_NAME, pass: pwd });
    await client.unsafe("SELECT 1");
    return {
      client,
      roleActive: true,
      mechanism: `只读角色 ${READONLY_ROLE_NAME}（仅 SELECT 授权）· 会话 default_transaction_read_only=on · statement_timeout=${ANALYTICS_STATEMENT_TIMEOUT_MS}ms`,
    };
  } catch {
    // 降级路径：主连接 + 会话级只读 + 事务级 BEGIN READ ONLY（三保险仍在）
    const client = postgres(url.trim(), baseConnectionOptions());
    return {
      client,
      roleActive: false,
      mechanism: `主连接降级兜底（无建角色权限）· 事务级 BEGIN READ ONLY · 会话 default_transaction_read_only=on · statement_timeout=${ANALYTICS_STATEMENT_TIMEOUT_MS}ms`,
    };
  }
}

export function ensureAnalyticsClient(): Promise<AnalyticsClient> {
  if (!globalThis.__workbotAnalyticsClient) {
    clientPromise = bootstrapAnalyticsClient().catch((err: unknown) => {
      globalThis.__workbotAnalyticsClient = undefined;
      clientPromise = null;
      throw err;
    });
    globalThis.__workbotAnalyticsClient = clientPromise;
  }
  return globalThis.__workbotAnalyticsClient;
}

/** 当前第⑤重生效机制（护栏自检 / UI 徽章用） */
export async function getReadOnlyMechanism(): Promise<{ mechanism: string; roleActive: boolean }> {
  const c = await ensureAnalyticsClient();
  return { mechanism: c.mechanism, roleActive: c.roleActive };
}

/* ================================================================
 * 五、执行器：只读事务 + JS 侧超时双保险
 * ================================================================ */

export interface QueryExecution {
  finalSql: string;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  durationMs: number;
  mechanism: string;
}

function normalizeValue(v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) || Number.isFinite(n) ? n : v;
  }
  if (v instanceof Date) return v.toISOString();
  return v;
}

function normalizeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) out[k] = normalizeValue(v);
    return out;
  });
}

export class AnalyticsQueryError extends Error {
  readonly timedOut: boolean;
  constructor(message: string, timedOut: boolean) {
    super(message);
    this.name = "AnalyticsQueryError";
    this.timedOut = timedOut;
  }
}

export async function executeAnalyticsQuery(finalSql: string, params: readonly unknown[]): Promise<QueryExecution> {
  const { client, mechanism } = await ensureAnalyticsClient();
  const started = performance.now();

  const run = client.begin("read only", async (tx) => {
    const rows = (await tx.unsafe(
      finalSql,
      params as unknown as postgres.ParameterOrJSON<never>[],
    )) as unknown as Record<string, unknown>[];
    return rows ?? [];
  });

  // 数据库层 statement_timeout 已挂载；JS 侧再加一道兜底（连接悬挂 / 云库冷启动）
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new AnalyticsQueryError(`查询超过 ${ANALYTICS_STATEMENT_TIMEOUT_MS}ms，已被第④重超时死锁强制中止`, true));
    }, ANALYTICS_JS_TIMEOUT_MS);
    timer.unref?.();
  });

  let raw: Record<string, unknown>[];
  try {
    raw = await Promise.race([run, timeout]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AnalyticsQueryError(`SQL 执行失败（已被数据库层拒绝）：${msg}`, /timeout|canceling/i.test(msg));
  }

  const rows = normalizeRows(raw);
  return {
    finalSql,
    columns: rows.length > 0 ? Object.keys(rows[0]) : [],
    rows,
    rowCount: rows.length,
    durationMs: Math.round(performance.now() - started),
    mechanism,
  };
}
