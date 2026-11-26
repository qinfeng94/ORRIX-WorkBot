/**
 * doc-intake/types.ts —— Day 31 超大表格分治与修订版 Word 接入台 · 领域类型
 * 溯源：AGENTS.md FIN-001（单笔超 ¥50,000 强制人工审批）、代码红线 4（外来内容隔离）；
 *      ADR-004（引擎经 workbot 门面出站）；ADR-005（确定性引擎先行，LLM 只做精准解读）。
 * 核心纪律：8,500 行全量数据只进确定性代码引擎，绝不整表送审大模型。
 */

import type { WorkbotSseEvent } from "@/lib/workbot/types";

/** 对账大表单行（全部为虚构演示数据，不含任何真实客户 PII） */
export interface ReconRow {
  rowNo: number; // 序号（1 起）
  date: string; // yyyy-MM-dd
  department: string; // 星辰内部业务部门
  customerNo: string; // CUST-xxxx（虚构客户编号）
  docNo: string; // 单据号 INV-2026-xxxxx
  summary: string; // 摘要
  currency: "人民币";
  amountCny: number; // 人民币金额（元）
  status: string; // 已入账 / 待核对 / 已退款
}

/** 异常类型：FIN-001 超红线 / 重复扣款 */
export type AnomalyKind = "fin001_over_limit" | "duplicate_deduction";

export interface AnomalyItem {
  id: string;
  kind: AnomalyKind;
  title: string;
  detail: string;
  amountCny: number;
  rowNos: number[]; // 涉及行号
  fin001Required: boolean; // 是否触发 FIN-001 强制人工审批
}

/** 分组聚合统计（部门 / 月份） */
export interface GroupStat {
  key: string;
  count: number;
  amountCny: number;
}

export interface TableScanReport {
  rowCount: number;
  totalAmountCny: number;
  corruptRows: number; // 不可解析行数（宁缺毋滥，绝不编造补齐）
  byDepartment: GroupStat[];
  byMonth: GroupStat[];
  duplicateGroups: number;
}

/** 合同条款状态：生效 / 已删除（不生效）/ 已修订 */
export type ClauseStatus = "effective" | "deleted" | "amended";

export interface ParsedClause {
  id: string; // 条款号（如 7.2 / 9 / 12）
  title: string; // 条款名
  status: ClauseStatus;
  effectiveText: string; // 现行生效文本（原文正文 + 修订插入内容）
  deletedText: string; // 已删除文本（修订删除线内容；生效条款为空串）
  comment: string; // 修订批注（无批注为空串）
  inserted: boolean; // 是否为修订新增条款
}

export interface ContractParseResult {
  title: string;
  clauses: ParsedClause[];
  deletedCount: number;
  amendedCount: number;
  effectiveCount: number;
  commentCount: number;
}

export interface TokenCompareItem {
  label: string;
  inputTokens: number;
  estCostUsd: number;
}

/** 传统直塞 vs 分治架构 的 Token 对比（口径与 lib/llm/llm-client 一致：1.5 字符/token） */
export interface TokenCompare {
  naive: TokenCompareItem;
  distilled: TokenCompareItem;
  savingsPct: number;
  naiveRecords: number;
  distilledRecords: number;
}

/** 引擎出站 step 事件载荷（统一信封内 step.payload 的受控形状） */
export type DocIntakeStepPayload =
  | { stage: "scan_progress"; scanned: number; total: number; anomaliesSoFar: number; elapsedMs: number }
  | { stage: "scan_done"; report: TableScanReport; elapsedMs: number }
  | { stage: "aggregation"; byDepartment: GroupStat[]; byMonth: GroupStat[] }
  | { stage: "anomalies"; anomalies: AnomalyItem[] }
  | { stage: "clauses"; contract: ContractParseResult; sourceLabel: string }
  | { stage: "distilled_context"; text: string; chars: number }
  | { stage: "token_compare"; compare: TokenCompare };

/** 页面消费的 SSE 事件即统一信封事件（type-only import，客户端零运行时依赖） */
export type DocIntakeSseEvent = WorkbotSseEvent;

/** 分析请求体（路由 → 门面 refs 透传） */
export interface DocIntakeAnalyzeBody {
  question?: string;
  source: "builtin" | "upload";
  csvText?: string; // 上传的对账大表（CSV 文本）
  archiveBase64?: string; // 上传的 zip 系文档（docx 合同 / xlsx 大表）
  fileName?: string;
}
