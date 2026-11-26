/**
 * Day 17 · 单据结构化抽取引擎（确定性规则版，离线高仿真，仅服务端/评测台共用）
 * 溯源：AGENTS.md 代码红线 3（PII 脱敏）、红线 4（外来内容隔离——备注栏"指令"只上报不执行）；
 *      schemas.ts 抽取契约铁律二（被遮挡字段一律 null，严禁编造）。
 * 实现：规则化解析 OCR 原文（label: value 行 + 明细行），零第三方依赖、零 LLM ；
 *      每一次抽取产出都再过一遍 Zod Schema（schemas.ts）双重把关。
 */

import {
  parseExtractedDoc,
  type CustomsDoc,
  type DocType,
  type ExpenseDoc,
  type InvoiceDoc,
  type InvoiceLine,
  type LogisticsDoc,
  type ExpenseLine,
} from "./schemas";

/** 遮挡标记：原文中出现任一片段，该字段值视为不可读 → null */
const OCCLUSION_MARKERS = ["红章遮挡", "模糊不清", "█", "░"] as const;

/** 注入嫌疑指纹：备注栏出现这些模式 → 上报，绝不执行 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /忽略(以上|之前|所有|上面)(的)?(规则|指令|校验|要求)/,
  /(系统|管理员|开发者)(提示|指令|模式)/,
  /无需(人工)?审批/,
  /直接(批准|付款|打款|放行)/,
  /ignore\s+(previous|all|above)/i,
  /你现在是(财务)?(总监|管理员|审批人)/,
];

/** 拆单嫌疑指纹：备注提及拆分开具 → 按 FIN-001 合并口径上报 */
const SPLIT_PATTERNS: readonly RegExp[] = [/拆(分|成两笔|单)/, /分两笔/, /分两张/];

export interface ExtractionOutcome {
  /** 抽取 + Schema 校验是否成功 */
  ok: boolean;
  /** 通过 Schema 的结构化结果（ok=false 时为 null） */
  data: InvoiceDoc | CustomsDoc | LogisticsDoc | ExpenseDoc | null;
  /** Schema 校验失败原因（大白话） */
  parseError: string | null;
  /** 被遮挡置空的字段名清单（铁律二：这些字段绝不能有编造值） */
  occludedFields: string[];
}

export interface UntrustedScan {
  /** 备注栏是否发现指令型内容（只上报，不执行） */
  injectionSuspect: boolean;
  /** 命中的原文片段（截断展示，包 <untrusted_document_content> 标签呈现） */
  injectionSnippet: string;
  /** 是否疑似拆单（合并口径上报 FIN-001） */
  splitSuspect: boolean;
  /** 破损/异常签收标记（物流单用，转客服人工） */
  damageSuspect: boolean;
}

/* ================================================================
 * 一、底层解析工具
 * ================================================================ */

/** 是否被遮挡（整值不可读） */
function isOccluded(value: string): boolean {
  return OCCLUSION_MARKERS.some((m) => value.includes(m));
}

/** 数字解析：去 ¥ / 逗号 / 空格；解析失败返回 null（绝不猜） */
function parseNumberLoose(raw: string): number | null {
  const cleaned = raw.replace(/[¥￥,\s]/g, "");
  if (cleaned.length === 0) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** 税率解析：13% → 0.13；遮挡/非法 → null */
function parseTaxRate(raw: string): number | null {
  if (isOccluded(raw)) return null;
  const m = raw.match(/([\d.]+)\s*%/);
  if (m && m[1] !== undefined) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) return Math.round(n) / 100;
  }
  const plain = parseNumberLoose(raw);
  if (plain !== null && plain >= 0 && plain <= 1) return plain;
  return null;
}

/** PII 脱敏：中文姓名留首字，英文留首字母（王芳 → 王*；Tom → T*） */
export function maskPersonName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return trimmed;
  const first = [...trimmed][0] ?? "*";
  return `${first}${"*".repeat(Math.max(1, trimmed.length - 1))}`;
}

/** 银行账号脱敏：只留前 4 后 4（622202020012341234 → 6222 **** **** 1234）；不足 10 位视为无效账号拒绝输出 */
export function maskBankAccount(account: string): string | null {
  const digits = account.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return `${digits.slice(0, 4)} **** **** ${digits.slice(-4)}`;
}

/** 取 label 后的值（支持中英文冒号），找不到返回 null */
function fieldValue(line: string, alias: string): string | null {
  const idx = line.indexOf(alias);
  if (idx !== 0 && idx > 20) return null;
  const sep = line.indexOf("：", idx);
  const sep2 = line.indexOf(":", idx);
  const use = sep === -1 ? sep2 : sep2 === -1 ? sep : Math.min(sep, sep2);
  if (use === -1) return null;
  return line.slice(use + 1).trim();
}

/** 按别名声表逐行扫描：命中即取值（遮挡 → 空串占位，由上层记入遮挡清单） */
function scanFields(raw: string, aliases: Record<string, readonly string[]>): {
  values: Record<string, string | null>;
  occluded: string[];
} {
  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  const values: Record<string, string | null> = {};
  const occluded: string[] = [];
  for (const [field, list] of Object.entries(aliases)) {
    let found: string | null = null;
    let hitOccluded = false;
    for (const line of lines) {
      for (const alias of list) {
        if (!line.includes(alias)) continue;
        const v = fieldValue(line, alias);
        if (v === null) continue;
        if (isOccluded(v)) {
          hitOccluded = true;
          found = "";
        } else {
          found = v;
        }
        break;
      }
      if (found !== null) break;
    }
    if (hitOccluded) {
      occluded.push(field);
      values[field] = "";
    } else {
      values[field] = found;
    }
  }
  return { values, occluded };
}

/* ================================================================
 * 二、明细行解析（发票 / 报销单）
 * ================================================================ */

const LINE_RE = /^(?:明细|行)\s*\d*[：:]/;

/** 解析明细行：`明细1: 品名 | 数量 1 | 单价 50.00 | 金额 50.00` */
function parseInvoiceLines(raw: string): InvoiceLine[] {
  const lines: InvoiceLine[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!LINE_RE.test(t)) continue;
    const segs = t.split("|").map((s) => s.trim());
    const name = segs[0]?.replace(LINE_RE, "").trim() || null;
    const grab = (seg: string | undefined, label: string): number | null => {
      if (!seg || !seg.startsWith(label)) return null;
      const m = seg.match(/([\d.,¥￥]+)\s*$/);
      return m && m[1] !== undefined ? parseNumberLoose(m[1]) : null;
    };
    lines.push({
      name,
      quantity: grab(segs[1], "数量"),
      unitPrice: grab(segs[2], "单价"),
      lineAmount: grab(segs[3], "金额"),
    });
  }
  return lines;
}

/** 报销明细：`明细1: 差旅机票 | 日期 2026-11-02 | 金额 1450.00` */
function parseExpenseLines(raw: string): ExpenseLine[] {
  const lines: ExpenseLine[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!LINE_RE.test(t)) continue;
    const segs = t.split("|").map((s) => s.trim());
    const item = segs[0]?.replace(LINE_RE, "").trim() || null;
    let date: string | null = null;
    let amount: number | null = null;
    for (const seg of segs.slice(1)) {
      if (seg.startsWith("日期")) {
        const m = seg.match(/\d{4}-\d{2}-\d{2}/);
        date = m && m[0] ? m[0] : null;
      } else if (seg.startsWith("金额")) {
        const m = seg.match(/([\d.,¥￥]+)\s*$/);
        amount = m && m[1] !== undefined ? parseNumberLoose(m[1]) : null;
      }
    }
    lines.push({ item, date, amount });
  }
  return lines;
}

/** 备注：所有「备注」开头行拼接；「备注: 无」归一为空串 */
function parseRemarks(raw: string): string {
  const parts: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (/^备注/.test(t)) {
      const v = t.replace(/^备注(栏)?[：:]?/, "").trim();
      if (v.length > 0 && v !== "无") parts.push(v);
    }
  }
  return parts.join("；");
}

/* ================================================================
 * 三、不可信内容扫描（备注栏指令只上报不执行 / 拆单合并口径上报）
 * ================================================================ */

export function scanUntrusted(raw: string): UntrustedScan {
  const remarkLines = raw.split(/\r?\n/).filter((l) => /^备注|异常/.test(l.trim()));
  const scanText = remarkLines.length > 0 ? remarkLines.join("\n") : raw;
  let injectionSnippet = "";
  for (const line of scanText.split(/\r?\n/)) {
    if (INJECTION_PATTERNS.some((p) => p.test(line))) {
      injectionSnippet = line.trim().slice(0, 160);
      break;
    }
  }
  return {
    injectionSuspect: injectionSnippet.length > 0,
    injectionSnippet,
    splitSuspect: SPLIT_PATTERNS.some((p) => scanText.match(p) !== null),
    damageSuspect: /破损|损坏|外包装破|货损/.test(scanText),
  };
}

/* ================================================================
 * 四、4 类单据抽取（解析 → 组装 → Zod 复核）
 * ================================================================ */

const INVOICE_ALIASES: Record<string, readonly string[]> = {
  invoiceNo: ["发票号码", "发票号"],
  invoiceDate: ["开票日期"],
  sellerName: ["销售方名称", "销货单位"],
  sellerTaxId: ["销售方税号", "纳税人识别号"],
  buyerName: ["购买方名称", "购货单位"],
  buyerTaxId: ["购买方税号"],
  currency: ["币种"],
  exchangeRate: ["汇率"],
  taxRate: ["税率"],
  amountExclTax: ["金额合计", "不含税金额"],
  taxAmount: ["税额合计", "税额"],
  totalAmount: ["价税合计"],
};

const CUSTOMS_ALIASES: Record<string, readonly string[]> = {
  declarationNo: ["报关单号"],
  declarationDate: ["申报日期"],
  consigneeName: ["境内收货人"],
  tradeCountry: ["贸易国"],
  goodsName: ["商品名称"],
  hsCode: ["HS编码", "HS 编码"],
  declaredValue: ["申报总值"],
  currency: ["币种"],
  exchangeRate: ["汇率"],
  grossWeightKg: ["毛重"],
  netWeightKg: ["净重"],
  totalAmountCny: ["人民币合计"],
};

const LOGISTICS_ALIASES: Record<string, readonly string[]> = {
  waybillNo: ["运单号"],
  carrier: ["承运商"],
  originCity: ["起运城市"],
  destCity: ["目的城市"],
  packageCount: ["件数"],
  signedBy: ["签收人"],
  signedAt: ["签收时间"],
  receiptStatus: ["签收状态"],
  damageNote: ["破损备注", "异常备注"],
};

const EXPENSE_ALIASES: Record<string, readonly string[]> = {
  claimNo: ["报销单号"],
  employeeName: ["报销人"],
  department: ["报销部门", "所属部门"],
  expenseType: ["费用类型"],
  occurDate: ["业务发生日"],
  invoiceCount: ["附件发票张数", "发票张数"],
  totalAmount: ["报销总额", "申报总额"],
  paymentAccount: ["收款账户", "银行账号"],
};

/** 单据抽取总入口：OCR 原文 → 结构化对象（遮挡必 null）或明确失败 */
export function extractDoc(docType: DocType, raw: string): ExtractionOutcome {
  switch (docType) {
    case "invoice":
      return buildInvoice(raw);
    case "customs":
      return buildCustoms(raw);
    case "logistics":
      return buildLogistics(raw);
    case "expense":
      return buildExpense(raw);
  }
}

function finish(
  data: InvoiceDoc | CustomsDoc | LogisticsDoc | ExpenseDoc,
  occluded: string[],
): ExtractionOutcome {
  const verdict = parseExtractedDoc(data.docType, data);
  if (!verdict.ok) return { ok: false, data: null, parseError: verdict.error, occludedFields: occluded };
  return { ok: true, data, parseError: null, occludedFields: occluded };
}

function buildInvoice(raw: string): ExtractionOutcome {
  const { values, occluded } = scanFields(raw, INVOICE_ALIASES);
  const currencyRaw = values.currency ?? "";
  const data: InvoiceDoc = {
    docType: "invoice",
    invoiceNo: values.invoiceNo || null,
    invoiceDate: /^\d{4}-\d{2}-\d{2}$/.test(values.invoiceDate ?? "") ? (values.invoiceDate as string) : null,
    sellerName: values.sellerName || null,
    sellerTaxId: values.sellerTaxId || null,
    buyerName: values.buyerName || null,
    buyerTaxId: values.buyerTaxId || null,
    currency: currencyRaw === "CNY" || currencyRaw === "USD" || currencyRaw === "EUR" ? currencyRaw : null,
    exchangeRate: isOccluded(values.exchangeRate ?? "") ? null : parseNumberLoose(values.exchangeRate ?? ""),
    taxRate: parseTaxRate(values.taxRate ?? ""),
    amountExclTax: parseNumberLoose(values.amountExclTax ?? ""),
    taxAmount: parseNumberLoose(values.taxAmount ?? ""),
    totalAmount: parseNumberLoose(values.totalAmount ?? ""),
    lines: parseInvoiceLines(raw),
    remarks: parseRemarks(raw),
  };
  return finish(data, occluded);
}

function buildCustoms(raw: string): ExtractionOutcome {
  const { values, occluded } = scanFields(raw, CUSTOMS_ALIASES);
  const currencyRaw = values.currency ?? "";
  const data: CustomsDoc = {
    docType: "customs",
    declarationNo: values.declarationNo || null,
    declarationDate: /^\d{4}-\d{2}-\d{2}$/.test(values.declarationDate ?? "") ? (values.declarationDate as string) : null,
    consigneeName: values.consigneeName || null,
    tradeCountry: values.tradeCountry || null,
    goodsName: values.goodsName || null,
    hsCode: values.hsCode || null,
    declaredValue: parseNumberLoose(values.declaredValue ?? ""),
    currency: currencyRaw === "CNY" || currencyRaw === "USD" || currencyRaw === "EUR" ? currencyRaw : null,
    exchangeRate: isOccluded(values.exchangeRate ?? "") ? null : parseNumberLoose(values.exchangeRate ?? ""),
    grossWeightKg: isOccluded(values.grossWeightKg ?? "") ? null : parseNumberLoose(values.grossWeightKg ?? ""),
    netWeightKg: parseNumberLoose(values.netWeightKg ?? ""),
    totalAmountCny: parseNumberLoose(values.totalAmountCny ?? ""),
    remarks: parseRemarks(raw),
  };
  return finish(data, occluded);
}

function buildLogistics(raw: string): ExtractionOutcome {
  const { values, occluded } = scanFields(raw, LOGISTICS_ALIASES);
  const data: LogisticsDoc = {
    docType: "logistics",
    waybillNo: values.waybillNo || null,
    carrier: values.carrier || null,
    originCity: values.originCity || null,
    destCity: values.destCity || null,
    packageCount: parseNumberLoose(values.packageCount ?? ""),
    signedBy: values.signedBy || null,
    signedAt: values.signedAt || null,
    receiptStatus: values.receiptStatus || null,
    damageNote: values.damageNote || null,
    remarks: parseRemarks(raw),
  };
  return finish(data, occluded);
}

function buildExpense(raw: string): ExtractionOutcome {
  const { values, occluded } = scanFields(raw, EXPENSE_ALIASES);
  const account = values.paymentAccount ?? "";
  const employee = (values.employeeName ?? "").replace(/（虚构）$/, "").trim();
  const data: ExpenseDoc = {
    docType: "expense",
    claimNo: values.claimNo || null,
    /** PII 红线：姓名与账号输出前强制脱敏（红线 3） */
    employeeName: employee.length > 0 ? maskPersonName(employee) : null,
    department: values.department || null,
    expenseType: values.expenseType || null,
    occurDate: /^\d{4}-\d{2}-\d{2}$/.test(values.occurDate ?? "") ? (values.occurDate as string) : null,
    invoiceCount: parseNumberLoose(values.invoiceCount ?? ""),
    totalAmount: parseNumberLoose(values.totalAmount ?? ""),
    lines: parseExpenseLines(raw),
    paymentAccount: maskBankAccount(account),
    remarks: parseRemarks(raw),
  };
  return finish(data, occluded);
}
