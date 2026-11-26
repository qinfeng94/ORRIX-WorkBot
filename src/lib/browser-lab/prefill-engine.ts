/**
 * Day 14 · 预填引擎：自动填写老 ERP 手工录入表单，但在【提交保存】前强制暂停等人工确认
 * 溯源：
 * - 黄区纪律（04 号权限边界单）：AI 只起草，放行永远归人 —— 引擎在按下「提交保存」前
 *   物理中断（函数在此 return，后续步骤必须由人工确认接口再次显式调用）；
 * - 红线（Day 2）：提交目标永远是 /sandbox-legacy-erp 的仿真沙盒接口（进程内存储），
 *   不存在连接老 ERP 生产库的代码路径；
 * - FIN-001：草稿金额超 ¥50,000 时带强制人工审批徽章（本流程本身就有人工确认环节）。
 */

import { FIN001_THRESHOLD_YUAN, isValidNamedApprover } from "@/lib/fin001";
import type { BrowserLabEvent, BrowserSnapshot, PrefillDraft } from "./types";
import { pace, SANDBOX_ERP_PATH, scrapeAllPages, type EmitFn } from "./scrape-engine";

/** 暂停会话：人工确认前挂在内存里的草稿上下文 */
interface PrefillSession {
  taskId: string;
  draft: PrefillDraft;
  status: "awaiting_human";
  createdAt: number;
}

declare global {
  var __workbotPrefillSessions: Map<string, PrefillSession> | undefined;
}

function getSessionStore(): Map<string, PrefillSession> {
  if (!globalThis.__workbotPrefillSessions) globalThis.__workbotPrefillSessions = new Map();
  return globalThis.__workbotPrefillSessions;
}

/** 会话有效期 15 分钟，过期作废（防止草稿无限期滞留内存） */
const SESSION_TTL_MS = 15 * 60 * 1000;

function makeTaskId(): string {
  const stamp = new Date()
    .toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })
    .replace(/\D/g, "")
    .slice(0, 14);
  const rand = Math.floor(Math.random() * 900 + 100);
  return `BL-${stamp}-${rand}`;
}

function pruneExpiredSessions(): void {
  const store = getSessionStore();
  const now = Date.now();
  for (const [key, session] of store) {
    if (now - session.createdAt > SESSION_TTL_MS) store.delete(key);
  }
}

/* ---------- 快照构造 ---------- */

function formSnapshot(fields: { label: string; value: string }[], caption: string, stage: string): BrowserSnapshot {
  return {
    kind: "form",
    title: `付款单手工录入 [${stage}]`,
    url: `${SANDBOX_ERP_PATH}#entry-form`,
    fields,
    caption,
  };
}

/* ---------- 阶段一：预填并在提交前暂停 ---------- */

export interface PausedSession {
  sessionId: string;
  taskId: string;
  draft: PrefillDraft;
}

/**
 * 预填流程：先只读抓取 3 页选出超期最久的单据 → 逐字段预填 → **在【提交保存】前停下**。
 * 函数返回即代表引擎已物理停止，后续任何写入都必须走 confirmAndSubmit（人工触发）。
 */
export async function runPrefill(baseUrl: string, emit: EmitFn): Promise<PausedSession> {
  emit({ type: "log", level: "redline", text: "红线自查：预填目标为仿真沙盒页；引擎内置强制断点——不拿到人工确认，永远执行不到「提交保存」" });

  // 1) 只读抓取，选出超期最久（并列时金额最大）的付款单作为补录对象
  const { overdueInvoices } = await scrapeAllPages(baseUrl, emit);
  if (overdueInvoices.length === 0) {
    emit({ type: "error", message: "没有抓到任何超期单据，预填任务取消（宁缺毋滥，不硬凑）" });
    throw new Error("NO_OVERDUE_INVOICE");
  }
  const target = overdueInvoices[0];
  emit({
    type: "log",
    level: "info",
    text: `选定补录对象：${target.invoiceNo} · ${target.supplier} · ¥${target.amount.toLocaleString("zh-CN")} · 已超期 ${target.daysOverdue} 天`,
  });
  await pace();

  // 2) 组装草稿（AI 只起草）
  const draft: PrefillDraft = {
    supplier: target.supplier,
    invoiceNo: target.invoiceNo,
    amount: target.amount,
    dueDate: target.dueDate,
    daysOverdue: target.daysOverdue,
    remark: `超期 ${target.daysOverdue} 天，浏览器实验室预填草稿（等待人工确认）`,
    isFin001: target.amount > FIN001_THRESHOLD_YUAN,
  };

  // 3) 打开表单页（空表单快照）
  emit({ type: "step_start", step: "打开手工录入表单", detail: `定位 ${SANDBOX_ERP_PATH}#entry-form 的 F8 录入模式` });
  await pace();
  emit({
    type: "snapshot",
    snapshot: formSnapshot(
      [
        { label: "供应商名称", value: "（空）" },
        { label: "发票号", value: "（空）" },
        { label: "金额（元）", value: "（空）" },
        { label: "到期日", value: "（空）" },
        { label: "付款备注", value: "（空）" },
      ],
      "表单为空，等待自动预填",
      "打开表单",
    ),
  });

  // 4) 逐字段预填（每填 2 个字段出一张快照，模拟真实键入过程）
  const filled: { label: string; value: string }[] = [];
  const pushFill = (label: string, value: string, stage: string, caption: string) => {
    filled.push({ label, value });
    emit({ type: "snapshot", snapshot: formSnapshot(filled.map((f) => ({ ...f })), caption, stage) });
  };

  emit({ type: "step_start", step: "自动填写字段", detail: `共 5 个字段：供应商 / 发票号 / 金额 / 到期日 / 备注${draft.isFin001 ? "（金额超 5 万，FIN-001 徽章亮起）" : ""}` });
  await pace();
  pushFill("供应商名称", draft.supplier, "填写中 1/5", `输入供应商：${draft.supplier}`);
  await pace();
  pushFill("发票号", draft.invoiceNo, "填写中 2/5", `输入发票号：${draft.invoiceNo}`);
  await pace();
  pushFill("金额（元）", draft.amount.toLocaleString("zh-CN"), "填写中 3/5", `输入金额：¥${draft.amount.toLocaleString("zh-CN")}${draft.isFin001 ? " ⚠ 超 ¥50,000，触发 FIN-001 强制人工审批" : ""}`);
  await pace();
  pushFill("到期日", draft.dueDate, "填写中 4/5", `输入到期日：${draft.dueDate}（已超期 ${draft.daysOverdue} 天）`);
  await pace();
  pushFill("付款备注", draft.remark, "填写完成 5/5", "全部字段预填完毕 —— 引擎在此**强制暂停**");

  // 5) 物理断点：创建等待会话后立即返回，绝不继续执行提交步骤
  const sessionId = `PBS-${Date.now().toString(36)}-${Math.floor(Math.random() * 9000 + 1000)}`;
  const taskId = makeTaskId();
  pruneExpiredSessions();
  getSessionStore().set(sessionId, { taskId, draft, status: "awaiting_human", createdAt: Date.now() });

  emit({
    type: "paused",
    sessionId,
    taskId,
    draft,
  });
  emit({
    type: "log",
    level: "warn",
    text: "⛔ 已在【提交保存】按钮前暂停（黄区断点）：需要具名人工确认放行后，才会执行最后一步提交。",
  });

  return { sessionId, taskId, draft };
}

/* ---------- 阶段二：人工确认后的提交（唯一的写入路径） ---------- */

export interface ConfirmOutcome {
  receiptNo: string;
  sandboxTotal: number;
  auditLogId: number;
  draft: PrefillDraft;
  taskId: string;
}

/**
 * 人工确认放行 → 按下【提交保存】（写仿真沙盒）→ 审计留痕（approval_audit_logs 只增不改）。
 * 任何一步失败都会抛错，由路由层返回 4xx/5xx。
 */
export async function confirmAndSubmit(
  sessionId: string,
  approver: string,
  baseUrl: string,
  emit: EmitFn,
): Promise<ConfirmOutcome> {
  pruneExpiredSessions();
  const session = getSessionStore().get(sessionId);
  if (!session) {
    emit({ type: "error", message: "暂停会话不存在或已过期（15 分钟有效期），请重新预填。" });
    throw new Error("SESSION_NOT_FOUND");
  }

  // 具名审批人校验（CISO 条款 3：AI / 匿名 / 部门 / 值班一律无效）
  if (!isValidNamedApprover(approver)) {
    emit({ type: "error", message: "审批人必须是具名在职员工（禁止 AI、匿名、部门、值班等模糊身份）。" });
    throw new Error("INVALID_APPROVER");
  }

  const { draft, taskId } = session;

  emit({ type: "step_start", step: "人工确认放行", detail: `具名审批人：${approver} · 任务 ${taskId}` });
  emit({
    type: "log",
    level: "success",
    text: `✅ ${approver} 已确认放行${draft.isFin001 ? "（FIN-001 大额单据由具名审批人签字）" : ""}，继续执行最后一步。`,
  });
  await pace();

  // 按下【提交保存】—— 写入目标只有仿真沙盒接口
  emit({
    type: "step_start",
    step: "按下【提交保存】",
    detail: `POST ${SANDBOX_ERP_PATH} 表单 → 仿真沙盒存储（进程内存；老 ERP 生产库零触碰）`,
  });
  const submitRes = await fetch(`${baseUrl}/api/sandbox-legacy-erp/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      supplier: draft.supplier,
      invoiceNo: draft.invoiceNo,
      amount: draft.amount,
      dueDate: draft.dueDate,
      remark: draft.remark,
      source: "浏览器自动化·人工放行",
    }),
    cache: "no-store",
  });
  const submitData: unknown = await submitRes.json();
  const submit = submitData as { ok?: boolean; receiptNo?: string; sandboxTotal?: number; error?: string };
  if (!submitRes.ok || !submit.ok || !submit.receiptNo) {
    const message = submit.error ?? `沙盒提交失败（HTTP ${submitRes.status}）`;
    emit({ type: "error", message: `提交失败：${message}（沙盒无变更，可安全重试）` });
    throw new Error("SUBMIT_FAILED");
  }

  // 用掉会话：一次放行只能提交一次（防重复提交）
  getSessionStore().delete(sessionId);

  emit({
    type: "log",
    level: "success",
    text: `沙盒写入成功：回执号 ${submit.receiptNo} · 沙盒累计 ${submit.sandboxTotal ?? "?"} 笔（进程内存，重启即清空，生产库零触碰）`,
  });

  // 审计留痕：approval_audit_logs 只增不改（切断不丢）
  emit({ type: "step_start", step: "审计留痕", detail: "写入 approval_audit_logs（只增不改，带具名审批人与时间戳）" });
  const { ensureSchema, getDb } = await import("@/db");
  const { approvalAuditLogs } = await import("@/db/schema");
  await ensureSchema();
  const db = getDb();
  const [auditRow] = await db
    .insert(approvalAuditLogs)
    .values({
      ticketNo: taskId,
      approver,
      action: `浏览器自动化预填表单人工放行（${draft.invoiceNo} · ¥${draft.amount.toLocaleString("zh-CN")} · 沙盒回执 ${submit.receiptNo}）`,
      isFin001: draft.isFin001,
    })
    .returning();
  emit({ type: "log", level: "success", text: `审计留痕完成：audit_log #${auditRow.id} · ${taskId}` });

  const receipt = {
    receiptNo: submit.receiptNo,
    target: "老 ERP 仿真沙盒（进程内存，非生产库）",
    sandboxTotal: submit.sandboxTotal ?? 0,
    auditLogId: auditRow.id,
  };
  emit({ type: "submitted", receipt });

  return {
    receiptNo: receipt.receiptNo,
    sandboxTotal: receipt.sandboxTotal,
    auditLogId: receipt.auditLogId,
    draft,
    taskId,
  };
}
