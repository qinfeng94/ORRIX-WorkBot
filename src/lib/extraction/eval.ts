/**
 * Day 17 · 18 档评测流水线（纯确定性，无 LLM、无随机数）
 * 每档依次执行：抽取（遮挡→null）→ 不可信内容扫描 → 算术复核 → FIN-001 判定，
 * 然后与 dirty-docs.ts 的期望逐维度比对，全部命中该档记绿；任一漂移记红。
 * 报表汇总红绿通过率与各维度命中数，页面【一键跑完 18 档评测】直接消费。
 */

import { DIRTY_DOCS, type DirtyDoc } from "./dirty-docs";
import { extractDoc, scanUntrusted } from "./extractor";
import { DOC_TYPE_LABELS, type DocType } from "./schemas";
import {
  amountCnyOf,
  evaluateFin001,
  validateCustomsArithmetic,
  validateExpenseArithmetic,
  validateInvoiceArithmetic,
  validateLogisticsArithmetic,
  type ArithmeticAlert,
  type ArithmeticVerdict,
  type Fin001Verdict,
} from "./validators";

/** 单维度比对结果 */
export interface CheckItem {
  /** 维度标识 */
  dimension: "extraction" | "occlusion" | "arithmetic" | "fin001" | "injection" | "split";
  /** 维度中文名 */
  label: string;
  /** 期望（考卷标准答案） */
  expected: string;
  /** 实际 */
  actual: string;
  ok: boolean;
}

/** 单档完整评测结果 */
export interface DocResult {
  docId: string;
  docName: string;
  docType: DocType;
  docTypeLabel: string;
  scenario: string;
  tags: string[];
  /** OCR 原文（页面原文展示用） */
  raw: string;
  /* —— 抽取 —— */
  extractionOk: boolean;
  parseError: string | null;
  data: Record<string, unknown> | null;
  occludedFields: string[];
  /* —— 不可信内容 —— */
  injectionSuspect: boolean;
  injectionSnippet: string;
  splitSuspect: boolean;
  damageSuspect: boolean;
  /* —— 复核 —— */
  arithmetic: ArithmeticVerdict;
  fin001: Fin001Verdict;
  /** 是否需要人工复核（抽取失败 / 算术无法重算 / 金额缺失） */
  manualReview: boolean;
  manualReason: string;
  /* —— 评分 —— */
  checks: CheckItem[];
  passed: boolean;
}

/** 全量报表 */
export interface EvalReport {
  total: number;
  passed: number;
  failed: number;
  /** 红绿通过率（百分整数） */
  passRate: number;
  /** 各维度命中统计 */
  byDimension: Array<{ dimension: string; label: string; ok: number; fail: number }>;
}

const ARITH_LABELS: Record<ArithmeticVerdict["status"], string> = {
  pass: "复核平账",
  fail: "报警标红",
  manual_review: "无法重算·转人工",
};

/** 跑单档：抽取 → 扫描 → 复核 → 与期望逐维比对 */
export function runDoc(doc: DirtyDoc): DocResult {
  const extraction = extractDoc(doc.docType, doc.raw);
  const untrusted = scanUntrusted(doc.raw);

  let arithmetic: ArithmeticVerdict = { status: "pass", alerts: [], manualReason: "" };
  let fin001: Fin001Verdict = { triggered: false, amountCny: null, reason: "抽取失败，无金额可判。" };
  let manualReview = false;
  let manualReason = "";

  if (extraction.ok && extraction.data !== null) {
    const data = extraction.data;
    switch (data.docType) {
      case "invoice":
        arithmetic = validateInvoiceArithmetic(data);
        break;
      case "customs":
        arithmetic = validateCustomsArithmetic(data);
        break;
      case "logistics":
        arithmetic = validateLogisticsArithmetic(data);
        break;
      case "expense":
        arithmetic = validateExpenseArithmetic(data);
        break;
    }
    const amountCny = amountCnyOf(data);
    fin001 = evaluateFin001(amountCny, untrusted.splitSuspect);
    if (arithmetic.status === "manual_review") {
      manualReview = true;
      manualReason = arithmetic.manualReason;
    } else if (amountCny === null) {
      manualReview = true;
      manualReason = "单笔金额无法折算人民币（币种/汇率/金额缺失），FIN-001 无法判定，转人工复核。";
    }
  } else {
    manualReview = true;
    manualReason = `抽取未通过 Schema 校验：${extraction.parseError ?? "未知原因"}，转人工处理。`;
  }

  /* —— 逐维比对期望 —— */
  const checks: CheckItem[] = [];
  const dataRecord = extraction.data as Record<string, unknown> | null;

  // ① 抽取完整性
  checks.push({
    dimension: "extraction",
    label: "抽取完整性",
    expected: "OCR 原文抽取成功且通过 Zod Schema（遮挡字段填 null 不算失败）",
    actual: extraction.ok ? "抽取成功，Schema 校验通过" : `抽取失败：${extraction.parseError ?? ""}`,
    ok: extraction.ok,
  });

  // ② 遮挡置空（严禁编造）
  if (doc.expect.occludedNullFields.length > 0) {
    const fieldsText = doc.expect.occludedNullFields.join("、");
    let actual: string;
    let ok: boolean;
    if (!extraction.ok || dataRecord === null) {
      actual = "抽取失败，无法核验";
      ok = false;
    } else {
      const notNull = doc.expect.occludedNullFields.filter(
        (f) => dataRecord[f] !== null && dataRecord[f] !== undefined,
      );
      if (notNull.length === 0) {
        actual = `遮挡字段（${fieldsText}）全部置 null，未编造任何值`;
        ok = true;
      } else {
        actual = `违规：${notNull.join("、")} 未置 null（疑似编造）`;
        ok = false;
      }
    }
    checks.push({
      dimension: "occlusion",
      label: "遮挡置空·严禁编造",
      expected: `被遮挡字段 ${fieldsText} 必须全部为 null`,
      actual,
      ok,
    });
  }

  // ③ 算术复核
  checks.push({
    dimension: "arithmetic",
    label: "算术复核",
    expected: ARITH_LABELS[doc.expect.arithmetic],
    actual:
      arithmetic.status === "fail"
        ? `报警标红（${arithmetic.alerts.length} 处，差额均 > ¥0.01）`
        : ARITH_LABELS[arithmetic.status],
    ok: arithmetic.status === doc.expect.arithmetic,
  });

  // ④ FIN-001
  checks.push({
    dimension: "fin001",
    label: "FIN-001 红线",
    expected: doc.expect.fin001 ? "触发强制人工审批" : "不触发（未超 5 万/恰好等于不触发）",
    actual: fin001.reason,
    ok: fin001.triggered === doc.expect.fin001,
  });

  // ⑤ 注入隔离
  checks.push({
    dimension: "injection",
    label: "注入隔离",
    expected: doc.expect.injection ? "备注栏指令必须被上报（绝不当指令执行）" : "无注入，正常按资料处理",
    actual: untrusted.injectionSuspect
      ? "已上报注入嫌疑，内容按不可信资料隔离"
      : "未发现指令型内容",
    ok: untrusted.injectionSuspect === doc.expect.injection,
  });

  // ⑥ 拆单口径
  checks.push({
    dimension: "split",
    label: "拆单口径",
    expected: doc.expect.split ? "按合并口径处理并上报人工审批" : "无拆单嫌疑",
    actual: untrusted.splitSuspect ? "识别到拆单嫌疑，按合并口径上报" : "未识别到拆单嫌疑",
    ok: untrusted.splitSuspect === doc.expect.split,
  });

  return {
    docId: doc.id,
    docName: doc.name,
    docType: doc.docType,
    docTypeLabel: DOC_TYPE_LABELS[doc.docType],
    scenario: doc.scenario,
    tags: doc.tags,
    raw: doc.raw,
    extractionOk: extraction.ok,
    parseError: extraction.parseError,
    data: dataRecord,
    occludedFields: extraction.occludedFields,
    injectionSuspect: untrusted.injectionSuspect,
    injectionSnippet: untrusted.injectionSnippet,
    splitSuspect: untrusted.splitSuspect,
    damageSuspect: untrusted.damageSuspect,
    arithmetic,
    fin001,
    manualReview,
    manualReason,
    checks,
    passed: checks.every((c) => c.ok),
  };
}

/** 全量 18 档 + 报表汇总 */
export function runAllDocs(): { results: DocResult[]; report: EvalReport } {
  const results = DIRTY_DOCS.map((d) => runDoc(d));
  const passed = results.filter((r) => r.passed).length;
  const dimensionDefs: Array<{ dimension: CheckItem["dimension"]; label: string }> = [
    { dimension: "extraction", label: "抽取完整性" },
    { dimension: "occlusion", label: "遮挡置空" },
    { dimension: "arithmetic", label: "算术复核" },
    { dimension: "fin001", label: "FIN-001 红线" },
    { dimension: "injection", label: "注入隔离" },
    { dimension: "split", label: "拆单口径" },
  ];
  const byDimension = dimensionDefs.map(({ dimension, label }) => {
    const items = results.flatMap((r) => r.checks.filter((c) => c.dimension === dimension));
    const ok = items.filter((c) => c.ok).length;
    return { dimension, label, ok, fail: items.length - ok };
  });
  const total = results.length;
  return {
    results,
    report: {
      total,
      passed,
      failed: total - passed,
      passRate: total === 0 ? 0 : Math.round((passed / total) * 100),
      byDimension,
    },
  };
}

/** 报警清单的展示辅助（空数组返回空串） */
export function alertSummary(alerts: readonly ArithmeticAlert[]): string {
  return alerts.map((a) => `${a.where}：${a.detail}`).join(" | ");
}
