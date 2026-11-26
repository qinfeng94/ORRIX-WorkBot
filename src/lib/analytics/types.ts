/**
 * Day 39 analytics 流的 SSE 载荷类型（页面 ↔ 引擎共享口径）
 * 事件信封本身仍是 workbot/types.ts 的 7 类统一事件（ADR-004），
 * 这里只是 step.payload 的结构化内容约定——不自造新事件类型。
 */

import type { LayerAudit } from "./secure-sql";
import type { AnalyticsPlanMode, RoiBill } from "./planner";

export interface AnalyticsIntentPayload {
  question: string;
  matched: boolean;
  templateId: string | null;
  title: string | null;
  mode: AnalyticsPlanMode;
  matchedKeywords: string[];
  monthLabel: string;
  capabilities: string[];
}

export interface AnalyticsSqlAuditPayload {
  label: string;
  sql: string;
  /** 展示用参数列表（Date 已转短格式） */
  paramsDisplay: string[];
  audits: LayerAudit[];
  blockedLayer: number | null;
  blockedDetail: string;
}

export interface AnalyticsRunPayload {
  label: string;
  finalSql: string;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  durationMs: number;
  mechanism: string;
}

export interface AnalyticsChartPayload {
  title: string;
  unit: string;
  bars: { label: string; value: number; highlight?: boolean }[];
}

export type AnalyticsRoiPayload = RoiBill;

/** 护栏自检单样本（/api/analytics-agent/selfcheck） */
export interface SelfcheckSample {
  name: string;
  sql: string;
  expect: string;
  ok: boolean;
  blockedLayer: number | null;
  audits: LayerAudit[];
  finalSql: string;
  verdictText: string;
}

export interface SelfcheckResult {
  samples: SelfcheckSample[];
  mechanism: string;
  roleActive: boolean;
}

export type { LayerAudit, AnalyticsPlanMode, RoiBill };
