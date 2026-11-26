/**
 * Day 14 浏览器实验室 · 共享类型
 * 溯源：AGENTS.md 代码红线 1（严禁 any，类型显式声明）。
 * 服务端（/api/browser-lab SSE）与前端（/browser-lab）共用本文件，禁止副本。
 */

/** 一条老 ERP 供应商发票（仿真数据与抓取结果共用的结构化形态） */
export interface LegacyErpInvoice {
  /** 发票号，如 INV-2026-1101 */
  invoiceNo: string;
  /** 供应商名称（虚构演示数据） */
  supplier: string;
  /** 金额（元，整数口径） */
  amount: number;
  /** 到期日（YYYY-MM-DD） */
  dueDate: string;
  /** 超期天数（未超期为 0） */
  daysOverdue: number;
  /** 状态：超期 | 未到期 | 已付清 */
  status: "超期" | "未到期" | "已付清";
  /** 来源页码（抓取结果才填写，1~3） */
  sourcePage: number;
}

/** 抓取任务 · 每一步的浏览器快照（用于前端回放「截图」卡片） */
export interface BrowserSnapshot {
  /** 快照类型：table（发票列表页）| form（手工录入表单页）| terminal（执行结果摘要） */
  kind: "table" | "form" | "terminal";
  /** 快照标题（浏览器窗口标题栏文字） */
  title: string;
  /** 地址栏显示的 URL 路径 */
  url: string;
  /** table 快照：捕获到的表头 */
  headers?: string[];
  /** table 快照：捕获到的行（与 headers 一一对应） */
  rows?: string[][];
  /** form 快照：字段名 → 已填入值 */
  fields?: { label: string; value: string }[];
  /** terminal / form 快照：附注文字（如「共识别 8 行 × 6 列」） */
  caption?: string;
}

/** SSE 事件（/api/browser-lab 流式推送，前端按类型分发渲染） */
export type BrowserLabEvent =
  | { type: "step_start"; step: string; detail: string }
  | { type: "log"; level: "info" | "warn" | "success" | "redline"; text: string }
  | { type: "snapshot"; snapshot: BrowserSnapshot }
  | { type: "scraped_page"; page: number; found: number; overdue: number }
  | {
      type: "result";
      summary: string;
      invoices: LegacyErpInvoice[];
      persistedCount: number;
    }
  | { type: "paused"; sessionId: string; taskId: string; draft: PrefillDraft }
  | { type: "submitted"; receipt: SubmitReceipt }
  | { type: "done"; totalMs: number }
  | { type: "error"; message: string };

/** 预填任务 · 草稿（AI 只起草，提交永远归人 —— 红区镜像要求） */
export interface PrefillDraft {
  /** 供应商名称 */
  supplier: string;
  /** 发票号 */
  invoiceNo: string;
  /** 金额（元） */
  amount: number;
  /** 到期日 */
  dueDate: string;
  /** 超期天数 */
  daysOverdue: number;
  /** 付款备注 */
  remark: string;
  /** 是否触发 FIN-001（单笔超 ¥50,000 强制人工审批） */
  isFin001: boolean;
}

/** 提交回执（老 ERP 仿真沙盒返回，非生产库） */
export interface SubmitReceipt {
  /** 沙盒回执编号，如 SBX-20261126-XXXX */
  receiptNo: string;
  /** 提交目标（永远标注仿真沙盒） */
  target: string;
  /** 沙盒内当前累计录入笔数 */
  sandboxTotal: number;
  /** 审计留痕编号（approval_audit_logs 记录 ID） */
  auditLogId: number;
}
