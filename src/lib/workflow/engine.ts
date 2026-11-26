/**
 * Day 18 跨重启持久化审批流 · Postgres 状态机引擎（单点推进，引擎无关）
 * 溯源：FIN-001（单笔超 ¥50,000 强制人工审批，具名审批人）；
 *      AGENTS.md 日志红线（workflow_events 只增不改，触发器物理拒绝篡改）；
 *      红区（严禁自动打款——批准后只生成审计凭据并「通知下游」，绝不触发任何付款动作）。
 *
 * 核心设计：「挂起不占内存」——
 *   等待林总审批的挂起态只存 workflow_runs 一行（suspended_at / wait_expires_at），
 *   没有定时器、没有进程内状态。服务器断电重启后，批准请求一到即从 Postgres 原样恢复，
 *   并用「进程启动时刻 vs 挂起时刻」确定性地证明恢复确实跨越了一次重启。
 *
 * 本文件同时服务两种编排引擎：
 *   - postgres（默认等价演练模式）：API 直接调用本文件的状态机函数；
 *   - inngest（真实 Inngest Dev Server）：Inngest 函数的 step.run 内调用同一批函数。
 */

import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { ensureSchema, getDb } from "@/db";
import {
  approvalAuditLogs,
  mcpTasks,
  type McpTaskRow,
  type WorkflowArithmeticDetail,
  type WorkflowEventRow,
  type WorkflowLineItem,
  type WorkflowRunRow,
  workflowEvents,
  workflowRuns,
} from "@/db/schema";
import { isLargeAmount } from "@/lib/fin001";
import {
  financeRulesOf,
  loadTenantConfig,
  DEFAULT_TENANT_ID,
} from "@/lib/ontology/tenant-config";

/** 当前进程的启动时刻（模块加载即定格；判定「恢复是否跨越重启」的基准点） */
const PROCESS_START_MS = Date.now();

/** 挂起最长等待时长：7 天（FIN-001 大额单据的人工审批窗口） */
export const WAIT_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

/** 运行编号后缀字符集（不含易混淆字符） */
const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeSuffix(len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return out;
}

function todayCompact(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/* ------------------------------------------------------------------ */
/* 输入校验（系统边界处一次性完成，内部信任状态机自身）                  */
/* ------------------------------------------------------------------ */

export interface CreateRunInput {
  ticketNo: string;
  department: string;
  customerName: string;
  amountClaimed: number;
  items: WorkflowLineItem[];
  /** 租户 ID（Day 27 多租户；缺省 = 默认租户 xingchen，门槛从租户配置动态读取） */
  tenantId?: string;
}

/**
 * 校验创建参数：单号非空、金额正整数、明细 1~20 行且数量/单价为非负整数。
 * 全部通过返回结构化输入；否则返回中文错误说明。
 */
export function validateCreateInput(
  raw: Record<string, unknown>,
): { ok: true; input: CreateRunInput } | { ok: false; error: string } {
  const ticketNo = String(raw.ticketNo ?? "").trim();
  if (ticketNo.length === 0 || ticketNo.length > 40) {
    return { ok: false, error: "缺少工单编号（或超长）。" };
  }
  const department = String(raw.department ?? "").trim();
  if (department.length === 0) {
    return { ok: false, error: "缺少所属部门。" };
  }
  const customerName = String(raw.customerName ?? "").trim();
  if (customerName.length === 0) {
    return { ok: false, error: "缺少客户姓名。" };
  }
  const amountClaimed = Number(raw.amountClaimed);
  if (!Number.isInteger(amountClaimed) || amountClaimed <= 0) {
    return { ok: false, error: "申报总额必须是正整数（单位：元）。" };
  }

  const rawItems = raw.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 20) {
    return { ok: false, error: "单据明细需要 1~20 行。" };
  }
  const items: WorkflowLineItem[] = [];
  for (const rawItem of rawItems) {
    const item = rawItem as Record<string, unknown>;
    const desc = String(item.desc ?? "").trim();
    const qty = Number(item.qty);
    const unitPrice = Number(item.unitPrice);
    if (desc.length === 0) {
      return { ok: false, error: "明细行缺少品名说明。" };
    }
    if (!Number.isInteger(qty) || qty <= 0) {
      return { ok: false, error: `明细「${desc}」的数量必须是正整数。` };
    }
    if (!Number.isInteger(unitPrice) || unitPrice < 0) {
      return { ok: false, error: `明细「${desc}」的单价必须是非负整数（元）。` };
    }
    items.push({ desc: desc.slice(0, 60), qty, unitPrice });
  }
  return {
    ok: true,
    input: {
      ticketNo,
      department,
      customerName,
      amountClaimed,
      items,
      // Day 27 多租户：tenantId 可选透传（缺省 = 默认租户；非法格式在这里 fail-closed 拒绝）
      ...(typeof raw.tenantId === "string" && raw.tenantId.trim().length > 0
        ? { tenantId: raw.tenantId.trim() }
        : {}),
    },
  };
}

/** 算术校验：申报总额必须等于 Σ(数量 × 单价)（确定性计算，零 AI 参与、零幻觉空间） */
export function computeArithmetic(
  items: WorkflowLineItem[],
  amountClaimed: number,
): WorkflowArithmeticDetail {
  const lines = items.map((it) => ({
    desc: it.desc,
    qty: it.qty,
    unitPrice: it.unitPrice,
    subtotal: it.qty * it.unitPrice,
  }));
  const computedTotal = lines.reduce((sum, l) => sum + l.subtotal, 0);
  return {
    lines,
    computedTotal,
    claimedTotal: amountClaimed,
    ok: computedTotal === amountClaimed,
  };
}

/* ------------------------------------------------------------------ */
/* 事件流水（只增不改——表上有触发器，INSERT 即永久留痕）                */
/* ------------------------------------------------------------------ */

type WorkflowEventType =
  | "run_created"
  | "step1_intake"
  | "step1_invalid"
  | "suspended"
  | "approval_received"
  | "audit_written"
  | "downstream_notified"
  | "rejected"
  | "expired";

async function appendEvent(
  runId: string,
  eventType: WorkflowEventType,
  detail: string,
): Promise<void> {
  const db = getDb();
  await db.insert(workflowEvents).values({ runId, eventType, detail });
}

/* ------------------------------------------------------------------ */
/* 状态机：创建 → 挂起 → 恢复（批准 / 退回 / 过期）                     */
/* ------------------------------------------------------------------ */

/**
 * 步骤 1（入库 + 算术校验）+ 步骤 2 前半（进入挂起）——postgres 引擎的创建路径。
 * 校验不过：phase = invalid（红灯，流程终止，事件留痕）；
 * 校验通过：phase = awaiting_approval（琥珀灯挂起，等具名人工，最长 7 天）。
 */
export async function createRunPostgres(
  input: CreateRunInput,
): Promise<WorkflowRunRow> {
  await ensureSchema();
  const db = getDb();
  // Day 27 多租户：审批门槛从租户配置文件动态读取（默认租户走经典口径）
  const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
  const tenantCfg = await loadTenantConfig(tenantId);
  const finRules = financeRulesOf(tenantCfg);
  const runId = `WF-${todayCompact()}-${makeSuffix(4)}`;
  const detail = computeArithmetic(input.items, input.amountClaimed);
  const isFin001 = isLargeAmount(
    {
      department: input.department,
      amount: input.amountClaimed,
    },
    finRules,
  );
  const now = new Date();

  const [row] = await db
    .insert(workflowRuns)
    .values({
      tenantId,
      runId,
      ticketNo: input.ticketNo,
      department: input.department,
      customerName: input.customerName,
      amountClaimed: input.amountClaimed,
      items: input.items,
      engine: "postgres",
      phase: detail.ok ? "awaiting_approval" : "invalid",
      isFin001,
      arithmeticOk: detail.ok,
      arithmeticDetail: detail,
      suspendedAt: detail.ok ? now : null,
      waitExpiresAt: detail.ok ? new Date(now.getTime() + WAIT_TIMEOUT_MS) : null,
      finishedAt: detail.ok ? null : now,
    })
    .returning();

  await appendEvent(runId, "run_created", `审批流已受理（等价演练模式 · Postgres 状态机）`);
  if (detail.ok) {
    await appendEvent(
      runId,
      "step1_intake",
      `步骤 1 完成：单据入库，算术校验通过（明细合计 ${detail.computedTotal} 元 = 申报 ${detail.claimedTotal} 元）`,
    );
    await appendEvent(
      runId,
      "suspended",
      isFin001
        ? `步骤 2 挂起：FIN-001 大额（${tenantCfg.approvalThreshold.department}超 ¥${finRules.thresholdYuan.toLocaleString("zh-CN")}），等待${tenantCfg.namedApprovers[0]}具名审批（最长挂起 7 天，不占内存）`
        : `步骤 2 挂起：等待${tenantCfg.namedApprovers[0]}具名审批（最长挂起 7 天，不占内存）`,
    );
  } else {
    await appendEvent(
      runId,
      "step1_invalid",
      `步骤 1 拦截：算术校验不过（明细合计 ${detail.computedTotal} 元 ≠ 申报 ${detail.claimedTotal} 元），流程终止并留痕`,
    );
  }
  return row;
}

/**
 * Inngest 引擎的创建路径：只登记 run（phase = queued）并追加受理事件，
 * 步骤 1 / 2 / 3 全部由 Inngest 函数的 step 驱动。
 */
export async function createRunQueued(
  input: CreateRunInput,
  engine: "inngest",
): Promise<WorkflowRunRow> {
  await ensureSchema();
  const db = getDb();
  // Day 27 多租户：审批门槛从租户配置文件动态读取（默认租户走经典口径）
  const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
  const finRules = financeRulesOf(await loadTenantConfig(tenantId));
  const runId = `WF-${todayCompact()}-${makeSuffix(4)}`;
  const isFin001 = isLargeAmount(
    {
      department: input.department,
      amount: input.amountClaimed,
    },
    finRules,
  );
  const [row] = await db
    .insert(workflowRuns)
    .values({
      tenantId,
      runId,
      ticketNo: input.ticketNo,
      department: input.department,
      customerName: input.customerName,
      amountClaimed: input.amountClaimed,
      items: input.items,
      engine: "inngest",
      phase: "queued",
      isFin001,
      arithmeticOk: false,
      arithmeticDetail: computeArithmetic(input.items, input.amountClaimed),
    })
    .returning();
  await appendEvent(runId, "run_created", "审批流已受理（Inngest 引擎 · 等待 Dev Server 领取）");
  return row;
}

/**
 * 步骤 1（单据入库与算术校验）——Inngest 函数 step.run 内调用；
 * postgres 引擎已在创建时完成，故这里只对 phase = queued 的 run 生效。
 */
export async function runIntakeStep(runId: string): Promise<WorkflowArithmeticDetail> {
  await ensureSchema();
  const db = getDb();
  const result = await db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, runId))
      .for("update");
    if (!run) throw new Error(`审批流 ${runId} 不存在。`);
    if (run.phase !== "queued") {
      // 幂等：已推进过的 run 不重复做步骤 1（Inngest 重试安全）
      return run.arithmeticDetail;
    }
    const detail = computeArithmetic(run.items, run.amountClaimed);
    const now = new Date();
    await tx
      .update(workflowRuns)
      .set({
        phase: detail.ok ? "awaiting_approval" : "invalid",
        arithmeticOk: detail.ok,
        arithmeticDetail: detail,
        suspendedAt: detail.ok ? now : null,
        waitExpiresAt: detail.ok ? new Date(now.getTime() + WAIT_TIMEOUT_MS) : null,
        finishedAt: detail.ok ? null : now,
        updatedAt: now,
      })
      .where(eq(workflowRuns.runId, runId));
    return detail;
  });

  if (result.ok) {
    await appendEvent(
      runId,
      "step1_intake",
      `步骤 1 完成：单据入库，算术校验通过（明细合计 ${result.computedTotal} 元 = 申报 ${result.claimedTotal} 元）`,
    );
    await appendEvent(
      runId,
      "suspended",
      "步骤 2 挂起：step.waitForEvent 等待林总具名审批（最长 7 天，状态在 Inngest 持久层）",
    );
  } else {
    await appendEvent(
      runId,
      "step1_invalid",
      `步骤 1 拦截：算术校验不过（明细合计 ${result.computedTotal} 元 ≠ 申报 ${result.claimedTotal} 元），流程终止并留痕`,
    );
  }
  return result;
}

export interface CompleteResult {
  alreadyCompleted: boolean;
  auditCredential: string;
}

/**
 * 步骤 3（生成审计凭据 + 通知下游）——批准事件的恢复动作，两种引擎共用。
 * 幂等：已完成的 run 直接返回原凭据（调用方据此回 409）；绝不产生第二张凭据。
 * 红线：本函数只写审计与事件，不触碰任何付款/打款动作（红区物理剔除）。
 */
export async function completeRun(
  runId: string,
  approver: string,
): Promise<CompleteResult> {
  await ensureSchema();
  const db = getDb();
  const now = new Date();
  const freshCredential = `AP-WF-${todayCompact()}-${makeSuffix(4)}`;
  let alreadyCompleted = false;
  let auditCredential = freshCredential;

  await db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, runId))
      .for("update");
    if (!run) throw new Error(`审批流 ${runId} 不存在。`);

    if (run.phase === "completed") {
      // 幂等：凭据已生成，返回原凭据（调用方据此回 409，不产生第二张凭据）
      alreadyCompleted = true;
      auditCredential = run.auditCredential;
      return;
    }
    if (run.phase !== "awaiting_approval") {
      throw new Error(
        `审批流 ${runId} 当前状态为「${run.phase}」，不在等待审批，无法批准。`,
      );
    }

    // 审计凭据 = approval_audit_logs 里的一行（只增不改，切断不丢）
    await tx.insert(approvalAuditLogs).values({
      ticketNo: run.runId,
      approver,
      action: `批准大额审批流 ${run.runId}（工单 ${run.ticketNo}，金额 ¥${run.amountClaimed}，FIN-001 强制人工审批）`,
      isFin001: run.isFin001,
    });

    await tx
      .update(workflowRuns)
      .set({
        phase: "completed",
        auditCredential,
        approver,
        suspendedAt: run.suspendedAt,
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(workflowRuns.runId, runId));
  });

  if (alreadyCompleted) {
    return { alreadyCompleted: true, auditCredential };
  }

  await appendEvent(runId, "approval_received", `步骤 2 恢复：收到林总批准（审批人：${approver}）`);
  await appendEvent(runId, "audit_written", `步骤 3 完成：审计凭据 ${auditCredential} 已写入 approval_audit_logs（只增不改）`);
  await appendEvent(runId, "downstream_notified", `步骤 3 完成：下游通知已发出（财务复核队列 + 审计留痕），全程未触发任何打款动作`);

  return { alreadyCompleted: false, auditCredential };
}

/** 退回（林总不批准）：挂起 → rejected，事件留痕 */
export async function rejectRun(runId: string, approver: string): Promise<void> {
  await ensureSchema();
  const db = getDb();
  const now = new Date();
  await db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, runId))
      .for("update");
    if (!run) throw new Error(`审批流 ${runId} 不存在。`);
    if (run.phase === "rejected") return; // 幂等
    if (run.phase !== "awaiting_approval") {
      throw new Error(
        `审批流 ${runId} 当前状态为「${run.phase}」，不在等待审批，无法退回。`,
      );
    }
    await tx
      .update(workflowRuns)
      .set({ phase: "rejected", approver, finishedAt: now, updatedAt: now })
      .where(eq(workflowRuns.runId, runId));
  });
  await appendEvent(runId, "rejected", `林总退回该审批流（审批人：${approver}），流程终止并留痕`);
}

/** 7 天挂起到期：挂起 → expired（两种引擎共用；无定时器，靠读取时惰性清算） */
export async function expireRun(runId: string, reason: string): Promise<void> {
  await ensureSchema();
  const db = getDb();
  const now = new Date();
  await db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, runId))
      .for("update");
    if (!run || run.phase !== "awaiting_approval") return;
    await tx
      .update(workflowRuns)
      .set({ phase: "expired", finishedAt: now, updatedAt: now })
      .where(eq(workflowRuns.runId, runId));
  });
  await appendEvent(runId, "expired", `挂起超时：${reason}`);
}

/** 读取时惰性清算：把超过 7 天仍挂起的 run 批量标记过期（纯数据库判定，无定时器） */
async function sweepExpiredRuns(): Promise<void> {
  const db = getDb();
  const overdue = await db
    .select({ runId: workflowRuns.runId })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.phase, "awaiting_approval"),
        lt(workflowRuns.waitExpiresAt, new Date()),
      ),
    )
    .limit(20);
  for (const row of overdue) {
    await expireRun(row.runId, "超过 7 天无人审批，按制度自动挂起过期并转人工台账");
  }
}

/* ------------------------------------------------------------------ */
/* 视图：给 /workflows 页面的派生展示数据（状态灯 / 跨重启证明）          */
/* ------------------------------------------------------------------ */

export type WorkflowPhase =
  | "queued"
  | "invalid"
  | "awaiting_approval"
  | "completed"
  | "rejected"
  | "expired";

export interface WorkflowRunView {
  runId: string;
  ticketNo: string;
  department: string;
  customerName: string;
  customerNameMasked: string;
  amountClaimed: number;
  isFin001: boolean;
  engine: "postgres" | "inngest";
  phase: WorkflowPhase;
  arithmeticOk: boolean;
  arithmeticDetail: WorkflowArithmeticDetail;
  auditCredential: string;
  approver: string;
  suspendedAt: string | null;
  waitExpiresAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  /** 三步状态灯：ok（绿）| waiting（琥珀）| failed（红）| pending（灰） */
  lights: Array<{ key: string; label: string; status: "ok" | "waiting" | "failed" | "pending"; hint: string }>;
  /** 确定性证据：本次恢复是否跨越了一次服务器重启 */
  crossedRestart: boolean;
  events: Array<{ id: number; eventType: string; detail: string; createdAt: string }>;
}

/** 客户姓名脱敏（AGENTS.md 代码红线 3：张* 口径） */
function maskName(name: string): string {
  if (name.length <= 1) return `${name}*`;
  return `${name.slice(0, 1)}${"*".repeat(Math.min(name.length - 1, 2))}`;
}

function toView(run: WorkflowRunRow, events: WorkflowEventRow[]): WorkflowRunView {
  const phase = run.phase as WorkflowPhase;
  const suspendedMs = run.suspendedAt ? run.suspendedAt.getTime() : null;
  // 进程启动晚于挂起时刻 ⇒ 这一次恢复确实跨越了一次服务器重启（确定性证据，非表演）
  const crossedRestart = suspendedMs !== null && PROCESS_START_MS > suspendedMs + 1000;

  const lights: WorkflowRunView["lights"] = [
    {
      key: "step1",
      label: "步骤 1 · 入库与算术校验",
      status:
        phase === "queued"
          ? "pending"
          : run.arithmeticOk
            ? "ok"
            : "failed",
      hint:
        phase === "queued"
          ? "等待编排引擎领取"
          : run.arithmeticOk
            ? `校验通过：合计 ${run.arithmeticDetail.computedTotal} 元 = 申报 ${run.arithmeticDetail.claimedTotal} 元`
            : `校验拦截：合计 ${run.arithmeticDetail.computedTotal} 元 ≠ 申报 ${run.arithmeticDetail.claimedTotal} 元`,
    },
    {
      key: "step2",
      label: "步骤 2 · 挂起等待林总审批",
      status:
        phase === "awaiting_approval"
          ? "waiting"
          : phase === "completed"
            ? "ok"
            : phase === "rejected" || phase === "expired" || phase === "invalid"
              ? "failed"
              : "pending",
      hint:
        phase === "awaiting_approval"
          ? `挂起中（不占内存，最长 7 天）${crossedRestart ? "· 已跨越一次服务器重启仍存活" : ""}`
          : phase === "completed"
            ? "已收到具名批准"
            : phase === "rejected"
              ? "已被具名审批人退回"
              : phase === "expired"
                ? "挂起超 7 天未审批，自动过期转人工台账"
                : phase === "invalid"
                  ? "步骤 1 拦截，未进入挂起"
                  : "等待前置步骤",
    },
    {
      key: "step3",
      label: "步骤 3 · 审计凭据 + 通知下游",
      status: phase === "completed" ? "ok" : phase === "invalid" || phase === "rejected" || phase === "expired" ? "failed" : "pending",
      hint:
        phase === "completed"
          ? `凭据 ${run.auditCredential} 已写入审计日志（只增不改）`
          : phase === "invalid" || phase === "rejected" || phase === "expired"
            ? "流程终止，未生成凭据"
            : "等待批准事件",
    },
  ];

  return {
    runId: run.runId,
    ticketNo: run.ticketNo,
    department: run.department,
    customerName: run.customerName,
    customerNameMasked: maskName(run.customerName),
    amountClaimed: run.amountClaimed,
    isFin001: run.isFin001,
    engine: run.engine === "inngest" ? "inngest" : "postgres",
    phase,
    arithmeticOk: run.arithmeticOk,
    arithmeticDetail: run.arithmeticDetail,
    auditCredential: run.auditCredential,
    approver: run.approver,
    suspendedAt: run.suspendedAt ? run.suspendedAt.toISOString() : null,
    waitExpiresAt: run.waitExpiresAt ? run.waitExpiresAt.toISOString() : null,
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    createdAt: run.createdAt.toISOString(),
    lights,
    crossedRestart,
    events: events.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      detail: e.detail,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

/** 列表页数据：最近 N 条运行（含事件流水），读取时顺带惰性清算过期挂起 */
export async function listRunViews(limit = 12): Promise<WorkflowRunView[]> {
  await ensureSchema();
  await sweepExpiredRuns();
  const db = getDb();
  const runs = await db
    .select()
    .from(workflowRuns)
    .orderBy(desc(workflowRuns.createdAt))
    .limit(limit);
  if (runs.length === 0) return [];
  const events = await db
    .select()
    .from(workflowEvents)
    .where(
      inArray(
        workflowEvents.runId,
        runs.map((r) => r.runId),
      ),
    )
    .orderBy(workflowEvents.id);
  return runs.map((run) =>
    toView(
      run,
      events.filter((e) => e.runId === run.runId),
    ),
  );
}

/** 单条运行视图（批准/退回后立刻回读，供响应体使用） */
export async function getRunView(runId: string): Promise<WorkflowRunView | null> {
  await ensureSchema();
  const db = getDb();
  const [run] = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.runId, runId));
  if (!run) return null;
  const events = await db
    .select()
    .from(workflowEvents)
    .where(eq(workflowEvents.runId, runId))
    .orderBy(workflowEvents.id);
  return toView(run, events);
}

/* ------------------------------------------------------------------ */
/* MCP Tasks：异步长任务（进度 = 时间的确定性函数，重启照常续算）        */
/* ------------------------------------------------------------------ */

export interface McpTaskProgress {
  taskId: string;
  taskType: string;
  label: string;
  status: "running" | "completed";
  progress: number;
  currentStep: string;
  elapsedMs: number;
  totalMs: number;
  /** 进度到 100% 才揭晓的确定性结果 */
  result: Record<string, unknown> | null;
  createdAt: string;
}

/** 由 MCP 任务行推导实时进度（无定时器：progress = elapsed / totalMs） */
export function toTaskProgress(task: McpTaskRow, nowMs: number): McpTaskProgress {
  const elapsedMs = Math.max(0, nowMs - task.startedAt.getTime());
  const progress = Math.min(100, Math.floor((elapsedMs / task.totalMs) * 100));
  const completed = progress >= 100;
  // 按阶段权重推导当前所处阶段
  let acc = 0;
  let currentStep = task.steps[0]?.label ?? "处理中";
  for (const step of task.steps) {
    acc += step.weight;
    if (progress < acc) {
      currentStep = step.label;
      break;
    }
    currentStep = step.label;
  }
  return {
    taskId: task.taskId,
    taskType: task.taskType,
    label: task.label,
    status: completed ? "completed" : "running",
    progress,
    currentStep: completed ? "已完成" : currentStep,
    elapsedMs,
    totalMs: task.totalMs,
    result: completed ? (task.result ?? null) : null,
    createdAt: task.createdAt.toISOString(),
  };
}

/** 创建一个 MCP 长任务（确定性结果开工前即定稿，落库后重启不丢） */
export async function createMcpTask(): Promise<McpTaskProgress> {
  await ensureSchema();
  const db = getDb();
  const taskId = `MCP-${todayCompact()}-${makeSuffix(4)}`;
  const [row] = await db
    .insert(mcpTasks)
    .values({
      taskId,
      taskType: "overdue_invoice_audit",
      label: "批量核对 128 张超期发票并生成核对报告",
      totalMs: 20_000,
      steps: [
        { label: "拉取老 ERP 只读快照", weight: 20 },
        { label: "逐张解析字段并入库副本表", weight: 35 },
        { label: "算术交叉核对（金额 / 税率 / 超期天数）", weight: 30 },
        { label: "汇总核对报告并归档", weight: 15 },
      ],
      result: {
        audited: 128,
        arithmeticOk: 121,
        mismatched: 7,
        fin001Flagged: 2,
        reportNote: "7 张金额不匹配单据已留痕待人工复核；2 张超 ¥50,000 已标记 FIN-001",
      },
    })
    .returning();
  return toTaskProgress(row, Date.now());
}

/** 轮询单个任务进度（重启后按同一公式照常续算） */
export async function getMcpTaskProgress(
  taskId: string,
): Promise<McpTaskProgress | null> {
  await ensureSchema();
  const db = getDb();
  const [row] = await db.select().from(mcpTasks).where(eq(mcpTasks.taskId, taskId));
  return row ? toTaskProgress(row, Date.now()) : null;
}

/** 最近任务列表（页面初次渲染 / 轮询兜底用） */
export async function listMcpTaskProgress(limit = 6): Promise<McpTaskProgress[]> {
  await ensureSchema();
  const db = getDb();
  const rows = await db
    .select()
    .from(mcpTasks)
    .orderBy(desc(mcpTasks.createdAt))
    .limit(limit);
  const nowMs = Date.now();
  return rows.map((row) => toTaskProgress(row, nowMs));
}
