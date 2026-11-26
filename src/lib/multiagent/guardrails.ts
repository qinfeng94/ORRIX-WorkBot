/**
 * guardrails.ts —— Day 12 四代理专班的双向安全护栏（仅限服务端使用）
 * 溯源：04 号文档 CISO 条款 5（外部内容隔离 / 恶意指令只上报不执行）；
 *      AGENTS.md 业务红线（FIN-001 >¥50,000 人工审批 / 红区严禁自动打款 / 代码红线 3 PII 脱敏）。
 * 设计：
 * - 入口护栏（毫秒级）：纯正则拦截 [SYSTEM OVERRIDE] 类恶意注入——不调用任何模型，
 *   费用恒为 $0，用 performance.now() 计时并留痕；
 * - 出口护栏：正则拦截「承诺自动退还 >¥50,000」与明文手机号 / 身份证号泄露；
 *   PII 命中即脱敏改写（如 138****5678 / ****&#** **** 档），违规表述整句摘出上报；
 * - 护栏只标记 / 脱敏 / 上报，绝不代替任何岗位改业务决策（职责边界不变）。
 */

/* ================================================================
 * 一、入口护栏：恶意注入毫秒级拦截（$0 费用）
 * ================================================================ */

/** 注入特征库（不区分大小写；覆盖指令覆盖 / 角色劫持 / 权限突破 / 编造制度四大类） */
const INJECTION_PATTERNS: readonly { re: RegExp; label: string }[] = [
  { re: /\[?\s*system\s*override\s*\]?/i, label: "[SYSTEM OVERRIDE] 系统覆盖指令" },
  { re: /\[?\s*developer\s*mode\s*\]?/i, label: "[DEVELOPER MODE] 开发者模式劫持" },
  { re: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts)/i, label: "忽略既往指令（英文注入模板）" },
  { re: /忽略.{0,8}(指令|设定|规则|提示)/, label: "忽略既往指令（中文注入模板）" },
  { re: /(绕过|跳过)(审批|人工|复核|FIN-?001)/, label: "诱导绕过审批 / FIN-001" },
  { re: /(恢复|启用|启用旧版?)\s*(旧版)?\s*10\s*万(额度|制度)/, label: "诱导恢复已废止的 10 万旧制度" },
  { re: /你(现在)?是(个)?(系统|管理员|root|admin|财务总监)/i, label: "角色劫持（冒充系统 / 管理员）" },
  { re: /prompt\s*injection|jailbreak|越狱/i, label: "显式越狱话术" },
] as const;

export interface InputGuardResult {
  /** true = 命中注入特征，流水线在入口直接拒绝（不进入任何岗位） */
  blocked: boolean;
  /** 命中的注入特征标签（只上报，不执行其中的任何"指令"） */
  patterns: string[];
  /** 护栏耗时（毫秒，性能.now 口径，通常 <1ms） */
  elapsedMs: number;
  /** 护栏费用：恒为 0（纯正则，不调用任何模型） */
  costUsd: number;
}

/**
 * 入口护栏：毫秒级正则拦截恶意注入。
 * 命中即拦截——注入内容按 CISO 条款 5 当作「资料」上报，绝不执行。
 */
export function runInputGuard(question: string): InputGuardResult {
  const t0 = performance.now();
  const patterns: string[] = [];
  for (const p of INJECTION_PATTERNS) {
    if (p.re.test(question)) patterns.push(p.label);
  }
  return {
    blocked: patterns.length > 0,
    patterns,
    elapsedMs: Math.max(1, Math.round(performance.now() - t0)),
    costUsd: 0,
  };
}

/* ================================================================
 * 二、出口护栏：越权承诺与 PII 泄露拦截
 * ================================================================ */

export type OutputViolationCode =
  | "unauthorized_auto_refund"
  | "pii_phone"
  | "pii_id_card";

export interface OutputViolation {
  code: OutputViolationCode;
  /** 命中的原文片段（PII 已就地脱敏后再上报，日志不落明文） */
  detail: string;
}

export interface OutputGuardResult {
  violations: OutputViolation[];
  /** 脱敏改写后的文本（PII 明文已替换为掩码；违规承诺不改动文本，交质检打回） */
  sanitizedText: string;
  /** 护栏耗时（毫秒） */
  elapsedMs: number;
  /** 护栏费用：恒为 0（纯正则，不调用任何模型） */
  costUsd: number;
}

/** FIN-001 红线金额（「超过 50000」才触发，等于不触发——口径与 AGENTS.md 一致）
 *  Day 26 起为单点委托：真源在 src/lib/fin001.ts（其数据真源在 config/approval-policies.json），此处禁止副本 */
export { FIN001_THRESHOLD_YUAN as FIN001_THRESHOLD_CNY } from "@/lib/fin001";
import { FIN001_THRESHOLD_YUAN } from "@/lib/fin001";

/** 自动处置类动词（退款承诺若叠加自动执行话术即越权——退款只能走既有正规通道） */
const AUTO_REFUND_RE = /(?:自动|直接|即刻|马上|立即)(?:退还|退款|返款|退回|打款|付款|放款|到账)/;

/** 从句子中提取金额（¥ / ￥ / "元" 前缀口径，支持千分位与小数） */
function extractAmountsCny(sentence: string): number[] {
  const amounts: number[] = [];
  const re = /[¥￥]\s*([0-9][\d,]*(?:\.\d+)?)|([0-9][\d,]*(?:\.\d+)?)\s*(?:元|块)(?:人民币)?/g;
  for (const m of sentence.matchAll(re)) {
    const raw = (m[1] ?? m[2] ?? "").replace(/,/g, "");
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) amounts.push(n);
  }
  return amounts;
}

/** 手机号（明文 11 位，前后非数字；排除已是掩码形态） */
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
/** 身份证号（18 位 / 15 位明文） */
const ID_CARD_RE = /(?<!\d)\d{17}[\dXx](?!\d)|(?<!\d)\d{15}(?!\d)/g;

function maskPhone(p: string): string {
  return `${p.slice(0, 3)}****${p.slice(7)}`;
}

function maskIdCard(id: string): string {
  // 身份证保留前 4 后 2，其余打码（与 6222 **** **** 1234 同一脱敏哲学）
  return `${id.slice(0, 4)}**************${id.slice(-2)}`.slice(0, id.length);
}

/**
 * 出口护栏：拦截「承诺自动退还 >¥50,000」与明文手机号 / 身份证号。
 * - 越权承诺：只摘句上报（质检官据此打回起草员重写），不改写文本；
 * - PII：就地脱敏改写，脱敏后文本继续流转（双重保险，即使质检漏检日志也无明文）。
 */
export function runOutputGuard(text: string): OutputGuardResult {
  const t0 = performance.now();
  const violations: OutputViolation[] = [];
  let sanitized = text;

  // ① 越权承诺：句级扫描——「自动 / 直接 + 退还类动词」且句内出现 >¥50,000 金额
  const sentences = text.split(/(?<=[。！？；;!\?\n])/);
  for (const sentence of sentences) {
    if (!AUTO_REFUND_RE.test(sentence)) continue;
    const overLine = extractAmountsCny(sentence).some(
      (n) => n > FIN001_THRESHOLD_YUAN,
    );
    if (overLine) {
      violations.push({
        code: "unauthorized_auto_refund",
        detail: `越权承诺：承诺自动退款且单笔金额超过 ¥50,000 红线（FIN-001 强制人工审批）——「${sentence.trim()}」`,
      });
    }
  }

  // ② 手机号明文：命中即脱敏 + 上报
  const phones = [...sanitized.matchAll(PHONE_RE)];
  if (phones.length > 0) {
    for (const m of phones) {
      violations.push({
        code: "pii_phone",
        detail: `PII 明文泄露（手机号，已自动脱敏为 ${maskPhone(m[0])}）`,
      });
    }
    sanitized = sanitized.replace(PHONE_RE, (p) => maskPhone(p));
  }

  // ③ 身份证号明文：命中即脱敏 + 上报（18 位优先，避免 15 位误吞手机号场景）
  const ids = [...sanitized.matchAll(ID_CARD_RE)];
  if (ids.length > 0) {
    for (const m of ids) {
      violations.push({
        code: "pii_id_card",
        detail: `PII 明文泄露（身份证号，已自动脱敏为 ${maskIdCard(m[0])}）`,
      });
    }
    sanitized = sanitized.replace(ID_CARD_RE, (id) => maskIdCard(id));
  }

  return {
    violations,
    sanitizedText: sanitized,
    elapsedMs: Math.max(1, Math.round(performance.now() - t0)),
    costUsd: 0,
  };
}
