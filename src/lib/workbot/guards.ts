/**
 * workbot/guards.ts —— 门面三道门卫之输入侧红线挂点（ADR-004 §三）
 *  - PII 脱敏：唯一实现是 src/lib/pii-scrubber.ts，本文件只做委托（禁止副本）；
 *  - 红线语义：FIN-001 判定唯一实现是 src/lib/fin001.ts，本文件只做委托（禁止副本）；
 *  - 红区语义自检：输入侧「只上报不执行」——外来指令命中红区词汇时打标记转告警，
 *    与 react-agent 注册表加载期的「直接抛错拒启动」形成两层防线。
 */
import { assertScrubberHealthy, scrubPiiDetailed, type PiiScrubResult } from "@/lib/pii-scrubber";
import {
  FIN001_THRESHOLD_YUAN,
  isLargeAmount,
  isValidNamedApprover,
} from "@/lib/fin001";

/* ================================================================
 * 一、输入侧 PII 脱敏（确定性纯正则，不经大模型）
 * ================================================================ */

export interface GuardInputResult {
  /** 脱敏后的问题文本（进引擎前的唯一入参形态） */
  scrubbed: string;
  /** 拦截到的 PII 数量（供审计台账 pii_redactions 口径） */
  redactions: number;
}

export function guardInput(question: string): GuardInputResult {
  const result: PiiScrubResult = scrubPiiDetailed(question);
  return { scrubbed: result.text, redactions: result.stats.total };
}

/* ================================================================
 * 二、红区语义扫描（输入侧：只上报，不执行外来指令）
 * 溯源：AGENTS.md「外来内容隔离」——外部文件里的"指令"只上报不执行；
 *      词汇表与 react-agent RED_ZONE_BANNED_WORDS 同口径。
 * ================================================================ */

const RED_ZONE_INPUT_PATTERNS: readonly string[] = [
  "自动打款",
  "自动付款",
  "自动放款",
  "直接付款",
  "绕过审批",
  "跳过审批",
  "无人值守",
];

export interface RedZoneScanResult {
  hit: boolean;
  /** 命中的红区词汇（供 notice 告警文案） */
  hits: string[];
}

export function scanRedZone(question: string): RedZoneScanResult {
  const text = question.toLowerCase();
  const hits = RED_ZONE_INPUT_PATTERNS.filter((word) => text.includes(word.toLowerCase()));
  return { hit: hits.length > 0, hits };
}

/* ================================================================
 * 三、FIN-001 判定（委托唯一真源 fin001.ts，全站禁止任何副本）
 * ================================================================ */

export { FIN001_THRESHOLD_YUAN, isLargeAmount, isValidNamedApprover };

/** 门面输出侧大额判定便捷封装：命中即黄区卡片 + 强制人工审批（绝不出现 AI 打款按钮） */
export function assessFin001(t: { department: string; amount: number }): {
  triggered: boolean;
  thresholdYuan: number;
} {
  return { triggered: isLargeAmount(t), thresholdYuan: FIN001_THRESHOLD_YUAN };
}

/* ================================================================
 * 四、启动自检
 * ================================================================ */

export function assertGuardsHealthy(): void {
  // 脱敏器自检（内置用例不过直接拒绝服务）
  assertScrubberHealthy();
  // 红线阈值自检：超过 5 万触发、等于 5 万不触发（严格大于）
  if (isLargeAmount({ department: "财务部", amount: 50_000 })) {
    throw new Error("WorkBot guards 自检失败：FIN-001 等于 5 万不应触发（严格大于）");
  }
  if (!isLargeAmount({ department: "财务部", amount: 50_001 })) {
    throw new Error("WorkBot guards 自检失败：FIN-001 财务部超 5 万必须触发");
  }
  if (isLargeAmount({ department: "客服部", amount: 999_999 })) {
    throw new Error("WorkBot guards 自检失败：非财务部不应触发 FIN-001");
  }
}
