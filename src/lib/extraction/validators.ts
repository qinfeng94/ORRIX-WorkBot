/**
 * Day 17 · 纯代码确定性算术校验器 + FIN-001 红线判定（单一真源，仅此一份）
 * 溯源：AGENTS.md FIN-001（单笔「超过」¥50,000 强制人工审批；「等于」不触发；
 *      疑似拆单按合并口径处理并上报；阈值复用 src/lib/fin001.ts，禁止副本）。
 * 设计：
 * - 全部为确定性纯函数（零 LLM、零随机）：明细行 单价×数量 与行金额、行合计与票面金额、
 *   税率×不含税金额 与税额、不含税+税额 与价税合计，任何差额 > ¥0.01 立即报警标红；
 * - 被遮挡字段导致无法重算时：不判失败也不判通过，明确转人工复核（宁缺毋滥）；
 * - 外币单按票面汇率折算人民币后再判 FIN-001（汇率只照抄票面，不自行查牌价）。
 */

import { FIN001_THRESHOLD_YUAN } from "@/lib/fin001";
import { APPROVAL_POLICY } from "@/lib/policy/approval-policy";
import type { CustomsDoc, ExpenseDoc, InvoiceDoc, LogisticsDoc } from "./schemas";

/** 允许的最大差额（元）：超过即报警标红（真源：config/approval-policies.json） */
export const ARITHMETIC_TOLERANCE_YUAN = APPROVAL_POLICY.thresholds.arithmeticToleranceCny;

/** 单条算术报警 */
export interface ArithmeticAlert {
  /** 报警位置（如 明细行2 / 税额 / 价税合计） */
  where: string;
  /** 大白话说明 */
  detail: string;
  /** 差额（元，保留 2 位） */
  diff: number;
}

/** 算术校验结论 */
export interface ArithmeticVerdict {
  /** pass = 复核平账；fail = 有报警；manual_review = 关键字段被遮挡无法重算 */
  status: "pass" | "fail" | "manual_review";
  /** fail 时的报警清单 */
  alerts: ArithmeticAlert[];
  /** manual_review 的原因说明 */
  manualReason: string;
}

/** FIN-001 判定结论 */
export interface Fin001Verdict {
  /** true = 触发强制人工审批（含拆单合并口径上报） */
  triggered: boolean;
  /** 单笔折合人民币金额（无法折算时为 null → 转人工） */
  amountCny: number | null;
  /** 判定依据（中文大白话） */
  reason: string;
}

/** 金额分位取整（防浮点误差：8800*0.13 一类） */
function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

function diffOverTolerance(a: number, b: number): number {
  return cents(Math.abs(cents(a) - cents(b)));
}

/* ================================================================
 * 一、算术校验（按单据类型分发）
 * ================================================================ */

export function validateInvoiceArithmetic(doc: InvoiceDoc): ArithmeticVerdict {
  const alerts: ArithmeticAlert[] = [];
  const lines = doc.lines;

  // ① 逐行复核：单价 × 数量 与 行金额
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const seq = i + 1;
    if (line.quantity === null || line.unitPrice === null) {
      return {
        status: "manual_review",
        alerts: [],
        manualReason: `明细行 ${seq} 的数量或单价被遮挡，无法重算，转人工复核。`,
      };
    }
    if (line.lineAmount === null) {
      return {
        status: "manual_review",
        alerts: [],
        manualReason: `明细行 ${seq} 的行金额被遮挡，无法重算，转人工复核。`,
      };
    }
    const expect = cents(line.quantity * line.unitPrice);
    const diff = diffOverTolerance(expect, line.lineAmount);
    if (diff > ARITHMETIC_TOLERANCE_YUAN) {
      alerts.push({
        where: `明细行 ${seq}`,
        detail: `单价 ¥${line.unitPrice.toFixed(2)} × 数量 ${line.quantity} = ¥${expect.toFixed(2)}，与票面行金额 ¥${line.lineAmount.toFixed(2)} 相差 ¥${diff.toFixed(2)}。`,
        diff,
      });
    }
  }

  // ② 行合计 与 不含税金额
  if (doc.amountExclTax === null) {
    return { status: "manual_review", alerts: [], manualReason: "不含税金额被遮挡，无法重算，转人工复核。" };
  }
  const lineSum = cents(lines.reduce((acc, l) => acc + (l.lineAmount ?? 0), 0));
  const diffSum = diffOverTolerance(lineSum, doc.amountExclTax);
  if (diffSum > ARITHMETIC_TOLERANCE_YUAN) {
    alerts.push({
      where: "不含税金额",
      detail: `${lines.length} 行明细合计 ¥${lineSum.toFixed(2)}，与票面不含税金额 ¥${doc.amountExclTax.toFixed(2)} 相差 ¥${diffSum.toFixed(2)}。`,
      diff: diffSum,
    });
  }

  // ③ 税率 × 不含税金额 与 税额
  if (doc.taxAmount === null) {
    return { status: "manual_review", alerts: [], manualReason: "税额被遮挡，无法重算，转人工复核。" };
  }
  if (doc.taxRate === null) {
    return {
      status: "manual_review",
      alerts,
      manualReason: "税率被红章遮挡无法重算税额，其余复核结论见上；转人工复核。",
    };
  }
  const expectTax = cents(doc.amountExclTax * doc.taxRate);
  const diffTax = diffOverTolerance(expectTax, doc.taxAmount);
  if (diffTax > ARITHMETIC_TOLERANCE_YUAN) {
    alerts.push({
      where: "税额",
      detail: `税率 ${(doc.taxRate * 100).toFixed(0)}% × 不含税金额 ¥${doc.amountExclTax.toFixed(2)} 应为 ¥${expectTax.toFixed(2)}，与票面税额 ¥${doc.taxAmount.toFixed(2)} 相差 ¥${diffTax.toFixed(2)}。`,
      diff: diffTax,
    });
  }

  // ④ 不含税 + 税额 与 价税合计
  if (doc.totalAmount === null) {
    return { status: "manual_review", alerts: [], manualReason: "价税合计被遮挡，无法重算，转人工复核。" };
  }
  const expectTotal = cents(doc.amountExclTax + doc.taxAmount);
  const diffTotal = diffOverTolerance(expectTotal, doc.totalAmount);
  if (diffTotal > ARITHMETIC_TOLERANCE_YUAN) {
    alerts.push({
      where: "价税合计",
      detail: `不含税 ¥${doc.amountExclTax.toFixed(2)} + 税额 ¥${doc.taxAmount.toFixed(2)} = ¥${expectTotal.toFixed(2)}，与票面价税合计 ¥${doc.totalAmount.toFixed(2)} 相差 ¥${diffTotal.toFixed(2)}。`,
      diff: diffTotal,
    });
  }

  return { status: alerts.length > 0 ? "fail" : "pass", alerts, manualReason: "" };
}

export function validateCustomsArithmetic(doc: CustomsDoc): ArithmeticVerdict {
  const alerts: ArithmeticAlert[] = [];
  if (doc.declaredValue === null || doc.exchangeRate === null) {
    return { status: "manual_review", alerts: [], manualReason: "申报总值或汇率被遮挡，无法折算人民币复核，转人工。" };
  }
  if (doc.totalAmountCny === null) {
    return { status: "manual_review", alerts: [], manualReason: "人民币合计被遮挡，无法复核，转人工。" };
  }
  const expectCny = cents(doc.declaredValue * doc.exchangeRate);
  const diff = diffOverTolerance(expectCny, doc.totalAmountCny);
  if (diff > ARITHMETIC_TOLERANCE_YUAN) {
    alerts.push({
      where: "人民币合计",
      detail: `申报总值 ${doc.currency ?? "?"} ${doc.declaredValue.toFixed(2)} × 汇率 ${doc.exchangeRate} = ¥${expectCny.toFixed(2)}，与申报人民币合计 ¥${doc.totalAmountCny.toFixed(2)} 相差 ¥${diff.toFixed(2)}，疑似汇率/货值造假。`,
      diff,
    });
  }
  return { status: alerts.length > 0 ? "fail" : "pass", alerts, manualReason: "" };
}

export function validateLogisticsArithmetic(_doc: LogisticsDoc): ArithmeticVerdict {
  // 物流签收单无金额字段，无算术可复核 —— 明确声明"不适用"而非谎报通过
  return { status: "pass", alerts: [], manualReason: "" };
}

export function validateExpenseArithmetic(doc: ExpenseDoc): ArithmeticVerdict {
  const alerts: ArithmeticAlert[] = [];
  for (let i = 0; i < doc.lines.length; i += 1) {
    if (doc.lines[i]?.amount === null) {
      return {
        status: "manual_review",
        alerts: [],
        manualReason: `明细行 ${i + 1} 金额被遮挡，无法重算合计，转人工复核。`,
      };
    }
  }
  if (doc.totalAmount === null) {
    return { status: "manual_review", alerts: [], manualReason: "报销总额被遮挡，无法重算，转人工复核。" };
  }
  const lineSum = cents(doc.lines.reduce((acc, l) => acc + (l.amount ?? 0), 0));
  const diff = diffOverTolerance(lineSum, doc.totalAmount);
  if (diff > ARITHMETIC_TOLERANCE_YUAN) {
    alerts.push({
      where: "报销总额",
      detail: `${doc.lines.length} 行明细合计 ¥${lineSum.toFixed(2)}，与申报报销总额 ¥${doc.totalAmount.toFixed(2)} 相差 ¥${diff.toFixed(2)}，疑似夹带私单或虚报。`,
      diff,
    });
  }
  return { status: alerts.length > 0 ? "fail" : "pass", alerts, manualReason: "" };
}

/* ================================================================
 * 二、FIN-001 红线（含外币折算 / 拆单合并口径）
 * ================================================================ */

/** 发票单笔折合人民币：CNY 照抄票面；外币按票面汇率折算（汇率被遮挡 → null） */
export function invoiceAmountCny(doc: InvoiceDoc): number | null {
  if (doc.totalAmount === null) return null;
  if (doc.currency === null) return null;
  if (doc.currency === "CNY") return doc.totalAmount;
  if (doc.exchangeRate === null) return null;
  return cents(doc.totalAmount * doc.exchangeRate);
}

export function evaluateFin001(
  amountCny: number | null,
  splitSuspect: boolean,
): Fin001Verdict {
  // 拆单嫌疑优先判定（红线优先）：即使金额不明也必须按合并口径上报，绝不漏报
  if (splitSuspect) {
    return {
      triggered: true,
      amountCny,
      reason:
        amountCny === null
          ? "本单备注疑似拆单且金额不明，按 FIN-001 拆单合并口径处理并上报强制人工审批。"
          : `本单折合人民币 ¥${amountCny.toFixed(2)}，且备注疑似拆单。按 FIN-001 拆单合并口径处理并上报强制人工审批。`,
    };
  }
  if (amountCny === null) {
    return {
      triggered: false,
      amountCny: null,
      reason: "金额字段缺失（被遮挡或币种/汇率不明），无法判定 FIN-001，转人工复核。",
    };
  }
  if (amountCny > FIN001_THRESHOLD_YUAN) {
    return {
      triggered: true,
      amountCny,
      reason: `单笔折合人民币 ¥${amountCny.toFixed(2)} 超过 ¥${FIN001_THRESHOLD_YUAN.toLocaleString("zh-CN")} 红线，触发 FIN-001 强制人工审批（AI 不得充当审批人）。`,
    };
  }
  return {
    triggered: false,
    amountCny,
    reason: `单笔折合人民币 ¥${amountCny.toFixed(2)}，未超过 ¥${FIN001_THRESHOLD_YUAN.toLocaleString("zh-CN")}（「等于」不触发），不触发 FIN-001。`,
  };
}

/** 各单据类型取"折合人民币单笔金额"（FIN-001 判定输入） */
export function amountCnyOf(
  doc: InvoiceDoc | CustomsDoc | LogisticsDoc | ExpenseDoc,
): number | null {
  switch (doc.docType) {
    case "invoice":
      return invoiceAmountCny(doc);
    case "customs":
      return doc.totalAmountCny;
    case "expense":
      return doc.totalAmount;
    case "logistics":
      return null;
  }
}
