/**
 * extraction.test.ts —— Day 17 单据抽取台核心逻辑单元测试（Node 内置 test runner，零第三方依赖）
 * 运行：pnpm test
 * 覆盖：① Zod Schema 校验与抽取契约（遮挡→null 严禁编造 / PII 脱敏 / 4 类单据分发）；
 *      ② 纯代码算术重算（差额 > ¥0.01 标红 / 恰好 0.01 不报 / 遮挡转人工）；
 *      ③ FIN-001 红线（超 5 万触发 / 恰好等于不触发 / 外币折算 / 拆单合并口径）；
 *      ④ 18 档评测全量回归（行为与期望逐维比对）。
 * 边界：被测对象全部为确定性纯函数，测试不联网、不读库、不跑 LLM。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DOC_TYPES,
  parseExtractedDoc,
  type InvoiceDoc,
} from "../src/lib/extraction/schemas.ts";
import {
  extractDoc,
  maskBankAccount,
  maskPersonName,
  scanUntrusted,
} from "../src/lib/extraction/extractor.ts";
import {
  ARITHMETIC_TOLERANCE_YUAN,
  evaluateFin001,
  invoiceAmountCny,
  validateCustomsArithmetic,
  validateExpenseArithmetic,
  validateInvoiceArithmetic,
  validateLogisticsArithmetic,
} from "../src/lib/extraction/validators.ts";
import { DIRTY_DOCS, findDirtyDoc } from "../src/lib/extraction/dirty-docs.ts";
import { runAllDocs, runDoc } from "../src/lib/extraction/eval.ts";

/** 构造一份算术完全平账的干净发票（可逐字段覆盖制造脏数据） */
function cleanInvoice(overrides: Partial<InvoiceDoc> = {}): InvoiceDoc {
  return {
    docType: "invoice",
    invoiceNo: "INV-TEST-0001",
    invoiceDate: "2026-11-26",
    sellerName: "测试供应商（虚构）",
    sellerTaxId: "91330105TESTAXID01",
    buyerName: "星辰跨境企服集团（虚构）",
    buyerTaxId: "91330106MA2BWORK00",
    currency: "CNY",
    exchangeRate: null,
    taxRate: 0.13,
    amountExclTax: 10000,
    taxAmount: 1300,
    totalAmount: 11300,
    lines: [{ name: "测试服务费", quantity: 1, unitPrice: 10000, lineAmount: 10000 }],
    remarks: "",
    ...overrides,
  };
}

/* ================================================================
 * ① Zod 校验与抽取契约
 * ================================================================ */

describe("① Zod Schema 校验与抽取契约", () => {
  it("4 类单据类型定义完整，标签齐全", () => {
    assert.deepEqual(DOC_TYPES, ["invoice", "customs", "logistics", "expense"]);
  });

  it("parseExtractedDoc：干净发票通过 Schema", () => {
    const verdict = parseExtractedDoc("invoice", cleanInvoice());
    assert.equal(verdict.ok, true);
    assert.equal(verdict.error, null);
  });

  it("parseExtractedDoc：缺 docType / docType 错值 / 税率越界 / 日期格式错 全部拒绝", () => {
    const missingDocType = { ...cleanInvoice() } as Record<string, unknown>;
    delete missingDocType.docType;
    assert.equal(parseExtractedDoc("invoice", missingDocType).ok, false);

    assert.equal(
      parseExtractedDoc("invoice", { ...cleanInvoice(), docType: "customs" }).ok,
      false,
      "docType literal 不匹配必须拒绝",
    );
    assert.equal(
      parseExtractedDoc("invoice", { ...cleanInvoice(), taxRate: 1.5 }).ok,
      false,
      "税率 > 1 必须拒绝",
    );
    assert.equal(
      parseExtractedDoc("invoice", { ...cleanInvoice(), invoiceDate: "2026/11/26" }).ok,
      false,
      "日期格式必须 YYYY-MM-DD",
    );
    assert.equal(
      parseExtractedDoc("invoice", { ...cleanInvoice(), lines: [] }).ok,
      true,
      "Schema 层只管结构，空明细是否合理交给算术/业务复核",
    );
    const missingLines = { ...cleanInvoice() } as Record<string, unknown>;
    delete missingLines.lines;
    assert.equal(parseExtractedDoc("invoice", missingLines).ok, false, "缺 lines 键必须拒绝");
  });

  it("parseExtractedDoc：4 类 Schema 互不串门（发票对象塞给报销单校验必须失败）", () => {
    assert.equal(parseExtractedDoc("expense", cleanInvoice()).ok, false);
  });

  it("extractDoc：干净发票全字段抽取且通过 Schema", () => {
    const raw = `【增值税发票 · OCR 原文】
发票号码: INV-2026-9999
开票日期: 2026-11-26
销售方名称: 测试供应商（虚构）
销售方税号: 91330105TESTAXID01
购买方名称: 星辰跨境企服集团（虚构）
购买方税号: 91330106MA2BWORK00
币种: CNY
税率: 13%
明细1: 测试服务费 | 数量 2 | 单价 500.00 | 金额 1000.00
金额合计: 1000.00
税额合计: 130.00
价税合计: 1130.00
备注: 无`;
    const out = extractDoc("invoice", raw);
    assert.equal(out.ok, true);
    if (!out.ok || out.data === null) return assert.fail("应当抽取成功");
    const data = out.data as InvoiceDoc;
    assert.equal(data.invoiceNo, "INV-2026-9999");
    assert.equal(data.taxRate, 0.13);
    assert.equal(data.totalAmount, 1130);
    assert.equal(data.lines.length, 1);
    assert.equal(data.lines[0]?.quantity, 2);
    assert.equal(out.occludedFields.length, 0);
  });

  it("抽取契约铁律一：红章遮挡/模糊不清字段一律 null 并记入遮挡清单，绝不编造", () => {
    // EX-05 销售方税号被红章遮挡
    const ex05 = extractDoc("invoice", findDirtyDoc("EX-05")?.raw ?? "");
    assert.equal(ex05.ok, true);
    assert.deepEqual(ex05.occludedFields, ["sellerTaxId"]);
    if (ex05.data !== null) {
      assert.equal((ex05.data as InvoiceDoc).sellerTaxId, null, "被遮挡税号必须为 null");
    }
    // EX-06 购买方名称 + 税率同时被糊掉
    const ex06 = extractDoc("invoice", findDirtyDoc("EX-06")?.raw ?? "");
    assert.deepEqual(ex06.occludedFields, ["buyerName", "taxRate"]);
    if (ex06.data !== null) {
      const d = ex06.data as InvoiceDoc;
      assert.equal(d.buyerName, null);
      assert.equal(d.taxRate, null);
    }
    // EX-13 报关单 HS 编码 + 毛重
    const ex13 = extractDoc("customs", findDirtyDoc("EX-13")?.raw ?? "");
    assert.deepEqual(ex13.occludedFields, ["hsCode", "grossWeightKg"]);
  });

  it("抽取容错：金额带 ¥ 与千分位逗号照常解析，非法数字一律 null 不猜", () => {
    const raw = `发票号码: INV-2026-8888
开票日期: 2026-11-26
销售方名称: 测试供应商（虚构）
销售方税号: 91330105TESTAXID01
购买方名称: 星辰跨境企服集团（虚构）
购买方税号: 91330106MA2BWORK00
币种: CNY
税率: 6%
明细1: 咨询费 | 数量 1 | 单价 2,500.00 | 金额 2500.00
金额合计: ¥2,500.00
税额合计: 150.00
价税合计: 2650.00
备注: 无`;
    const out = extractDoc("invoice", raw);
    assert.equal(out.ok, true);
    if (out.data !== null) {
      const d = out.data as InvoiceDoc;
      assert.equal(d.amountExclTax, 2500);
      assert.equal(d.lines[0]?.unitPrice, 2500);
    }
    // 非法数字：不抛错也不编造，落 null
    const bad = extractDoc("invoice", raw.replace("¥2,500.00", "见附件"));
    assert.equal(bad.ok, true, "金额非法时其余字段照常抽取");
    if (bad.data !== null) {
      assert.equal((bad.data as InvoiceDoc).amountExclTax, null);
    }
  });

  it("PII 红线：姓名与账号输出前强制脱敏（红线 3）", () => {
    const ex17 = extractDoc("expense", findDirtyDoc("EX-17")?.raw ?? "");
    assert.equal(ex17.ok, true);
    if (ex17.data !== null) {
      const d = ex17.data as { employeeName: string | null; paymentAccount: string | null };
      assert.equal(d.employeeName, "王*", "王芳（虚构）→ 王*");
      assert.equal(d.paymentAccount, "6222 **** **** 1234");
    }
    // 边界：英文姓名 / 过短账号
    assert.equal(maskPersonName("Tom"), "T**", "3 字符姓名留首字母 + 2 星");
    assert.equal(maskPersonName(""), "");
    assert.equal(maskBankAccount("62220000"), null, "不足 10 位拒脱敏输出 null（前 4 后 4 必须不重叠）");
    assert.equal(maskBankAccount("622200001234"), "6222 **** **** 1234");
    assert.equal(maskBankAccount("622202020012341234"), "6222 **** **** 1234");
  });

  it("scanUntrusted：备注藏指令 → 上报；正常备注与拆单指纹互不误伤", () => {
    const ex07 = findDirtyDoc("EX-07");
    if (!ex07) return assert.fail("EX-07 缺失");
    const scan = scanUntrusted(ex07.raw);
    assert.equal(scan.injectionSuspect, true);
    assert.ok(scan.injectionSnippet.includes("直接批准付款"));

    const clean = scanUntrusted(findDirtyDoc("EX-01")?.raw ?? "");
    assert.equal(clean.injectionSuspect, false);
    assert.equal(clean.splitSuspect, false);

    const ex10 = scanUntrusted(findDirtyDoc("EX-10")?.raw ?? "");
    assert.equal(ex10.splitSuspect, true, "「分两笔各 25440 元开具」必须命中拆单指纹");
    assert.equal(ex10.injectionSuspect, false, "拆单嫌疑不是注入，不混判");
  });
});

/* ================================================================
 * ② 纯代码算术重算
 * ================================================================ */

describe("② 纯代码算术重算（差额 > ¥0.01 立即标红）", () => {
  it("干净发票：明细、税额、价税合计全部复核平账", () => {
    const v = validateInvoiceArithmetic(cleanInvoice());
    assert.equal(v.status, "pass");
    assert.equal(v.alerts.length, 0);
  });

  it("明细行合计造假：行合计 ¥12,000 与票面 ¥11,880 差 ¥120 → fail 且报警位置精确", () => {
    const v = validateInvoiceArithmetic(
      cleanInvoice({
        lines: [{ name: "咨询费", quantity: 1, unitPrice: 11500, lineAmount: 11500 }, { name: "上门费", quantity: 1, unitPrice: 500, lineAmount: 500 }],
        amountExclTax: 11880,
        taxAmount: 1544.4,
        totalAmount: 13424.4,
      }),
    );
    assert.equal(v.status, "fail");
    assert.equal(v.alerts.length, 1);
    assert.ok(v.alerts[0]?.where.includes("不含税金额"));
    assert.equal(v.alerts[0]?.diff, 120);
  });

  it("税额造假：6% × 6000 应为 360 票面写 300.30 → fail", () => {
    const v = validateInvoiceArithmetic(
      cleanInvoice({
        taxRate: 0.06,
        amountExclTax: 6000,
        taxAmount: 300.3,
        totalAmount: 6300.3,
        lines: [{ name: "翻译费", quantity: 1, unitPrice: 6000, lineAmount: 6000 }],
      }),
    );
    assert.equal(v.status, "fail");
    assert.ok(v.alerts[0]?.where.includes("税额"));
    assert.equal(v.alerts[0]?.diff, 59.7);
  });

  it("容差边界：差额恰好 ¥0.01 不报警，¥0.02 立即标红", () => {
    const smallLine = [{ name: "测试", quantity: 1, unitPrice: 100, lineAmount: 100 }];
    const atTolerance = validateInvoiceArithmetic(
      cleanInvoice({ taxRate: 0.06, amountExclTax: 100, taxAmount: 6.01, totalAmount: 106.01, lines: smallLine }),
    );
    assert.equal(atTolerance.status, "pass", `容差 ${ARITHMETIC_TOLERANCE_YUAN} 元内不算造假`);

    const overTolerance = validateInvoiceArithmetic(
      cleanInvoice({ taxRate: 0.06, amountExclTax: 100, taxAmount: 6.02, totalAmount: 106.02, lines: smallLine }),
    );
    assert.equal(overTolerance.status, "fail");
    assert.equal(overTolerance.alerts[0]?.diff, 0.02);
  });

  it("遮挡转人工：税率被遮挡 → manual_review 且不误报 fail", () => {
    const v = validateInvoiceArithmetic(
      cleanInvoice({
        taxRate: null,
        taxAmount: 408,
        totalAmount: 7208,
        amountExclTax: 6800,
        lines: [{ name: "测试", quantity: 1, unitPrice: 6800, lineAmount: 6800 }],
      }),
    );
    assert.equal(v.status, "manual_review");
    assert.equal(v.alerts.length, 0);
    assert.ok(v.manualReason.includes("税率"));
  });

  it("遮挡转人工：明细单价被遮挡 → manual_review（宁可转人工不瞎算）", () => {
    const v = validateInvoiceArithmetic(
      cleanInvoice({ lines: [{ name: "测试", quantity: 1, unitPrice: null, lineAmount: 100 }] }),
    );
    assert.equal(v.status, "manual_review");
  });

  it("报销单：明细合计与总额差 ¥200 → fail（夹带私单）；平账 → pass", () => {
    const base = { docType: "expense" as const, claimNo: "BX-TEST", employeeName: "陈*", department: "运营部", expenseType: "业务招待费", occurDate: "2026-11-15", invoiceCount: 3, paymentAccount: null, remarks: "" };
    const lines = [
      { item: "招待餐费", date: "2026-11-12", amount: 860 },
      { item: "打车", date: "2026-11-13", amount: 420 },
      { item: "茶歇", date: "2026-11-15", amount: 1700 },
    ];
    const ok = validateExpenseArithmetic({ ...base, totalAmount: 2980, lines });
    assert.equal(ok.status, "pass");
    const bad = validateExpenseArithmetic({ ...base, totalAmount: 3180, lines });
    assert.equal(bad.status, "fail");
    assert.equal(bad.alerts[0]?.diff, 200);
  });

  it("报关单汇率折算：平账 pass / 虚增 ¥860 fail / 汇率被遮挡转人工", () => {
    const base = { docType: "customs" as const, declarationNo: "D1", declarationDate: "2026-11-15", consigneeName: "星辰（虚构）", tradeCountry: "美国", goodsName: "收纳盒", hsCode: "3926.90", declaredValue: 6800, currency: "USD" as const, grossWeightKg: 520, netWeightKg: 480 };
    assert.equal(validateCustomsArithmetic({ ...base, exchangeRate: 7.2, totalAmountCny: 48960, remarks: "" }).status, "pass");
    const bad = validateCustomsArithmetic({ ...base, declaredValue: 5200, exchangeRate: 7.2, totalAmountCny: 38300, remarks: "" });
    assert.equal(bad.status, "fail");
    assert.equal(bad.alerts[0]?.diff, 860);
    assert.equal(
      validateCustomsArithmetic({ ...base, declaredValue: 5200, exchangeRate: null, totalAmountCny: 38300, remarks: "" }).status,
      "manual_review",
    );
  });

  it("物流签收单无金额字段：明确声明不适用而非谎报复核通过", () => {
    const v = validateLogisticsArithmetic({
      docType: "logistics",
      waybillNo: "EWB:1",
      carrier: "测试承运商",
      originCity: "上海",
      destCity: "杭州",
      packageCount: 1,
      signedBy: "李建国",
      signedAt: "2026-11-25 14:32",
      receiptStatus: "正常签收",
      damageNote: null,
      remarks: "",
    });
    assert.equal(v.status, "pass");
    assert.equal(v.alerts.length, 0);
  });
});

/* ================================================================
 * ③ FIN-001 红线
 * ================================================================ */

describe("③ FIN-001 红线（超过 5 万触发，等于不触发）", () => {
  it("¥50,000.01 → 触发；恰好 ¥50,000 → 不触发；¥49,999.99 → 不触发", () => {
    assert.equal(evaluateFin001(50000.01, false).triggered, true);
    const atLine = evaluateFin001(50000, false);
    assert.equal(atLine.triggered, false, "「等于」不触发（FIN-001 边界）");
    assert.ok(atLine.reason.includes("等于"));
    assert.equal(evaluateFin001(49999.99, false).triggered, false);
  });

  it("金额缺失（被遮挡）→ 不误判，明确转人工口径", () => {
    const v = evaluateFin001(null, false);
    assert.equal(v.triggered, false);
    assert.ok(v.reason.includes("转人工"));
  });

  it("外币折算：USD 7000 × 7.3 = ¥51,100 → 触发；汇率被遮挡 → 折算 null 转人工", () => {
    const fx = cleanInvoice({ currency: "USD", exchangeRate: 7.3, totalAmount: 7000, taxRate: 0, taxAmount: 0 });
    assert.equal(invoiceAmountCny(fx), 51100);
    assert.equal(evaluateFin001(invoiceAmountCny(fx), false).triggered, true);

    const noRate = cleanInvoice({ currency: "USD", exchangeRate: null, totalAmount: 7000, taxRate: 0, taxAmount: 0 });
    assert.equal(invoiceAmountCny(noRate), null, "汇率缺失绝不自行查牌价");
    assert.equal(evaluateFin001(invoiceAmountCny(noRate), false).triggered, false);
  });

  it("CNY 照抄票面，不做任何换算", () => {
    assert.equal(invoiceAmountCny(cleanInvoice({ totalAmount: 9944 })), 9944);
  });

  it("拆单合并口径：单笔 ¥25,440 未过线，但拆单嫌疑 → 按合并口径触发并上报", () => {
    const v = evaluateFin001(25440, true);
    assert.equal(v.triggered, true);
    assert.ok(v.reason.includes("合并口径"));
    assert.ok(v.reason.includes("25440"));
  });

  it("拆单嫌疑 + 金额缺失：仍触发合并口径上报（红线优先）", () => {
    const v = evaluateFin001(null, true);
    assert.equal(v.triggered, true, "疑似拆单时即使金额不明也不放过");
    assert.ok(v.reason.includes("拆单"));
  });
});

/* ================================================================
 * ④ 18 档评测全量回归
 * ================================================================ */

describe("④ 18 档评测全量回归（行为 vs 期望）", () => {
  it("评测集恰好 18 档、覆盖 4 类单据，编号 EX-01 ~ EX-18 连续", () => {
    assert.equal(DIRTY_DOCS.length, 18);
    const types = new Set(DIRTY_DOCS.map((d) => d.docType));
    assert.equal(types.size, 4);
    DIRTY_DOCS.forEach((d, i) => assert.equal(d.id, `EX-${String(i + 1).padStart(2, "0")}`));
  });

  it("runAllDocs：18/18 全绿，passRate 100%，六大维度零漂移", () => {
    const { report } = runAllDocs();
    assert.equal(report.total, 18);
    assert.equal(report.failed, 0);
    assert.equal(report.passRate, 100);
    for (const dim of report.byDimension) {
      assert.equal(dim.fail, 0, `维度 ${dim.label} 出现漂移`);
    }
    assert.equal(report.byDimension.find((d) => d.dimension === "occlusion")?.ok, 4, "遮挡置空维度命中 4 档");
  });

  it("抽查红线档：EX-07 注入上报 + FIN-001；EX-08 外币折算触发；EX-09 恰好 5 万不触发；EX-10 拆单合并口径", () => {
    const ex07 = runDoc(findDirtyDoc("EX-07") as NonNullable<ReturnType<typeof findDirtyDoc>>);
    assert.equal(ex07.injectionSuspect, true);
    assert.equal(ex07.fin001.triggered, true);
    assert.equal(ex07.fin001.amountCny, 55120);
    assert.equal(ex07.passed, true);

    const ex08 = runDoc(findDirtyDoc("EX-08") as NonNullable<ReturnType<typeof findDirtyDoc>>);
    assert.equal(ex08.fin001.amountCny, 51100);
    assert.equal(ex08.fin001.triggered, true);

    const ex09 = runDoc(findDirtyDoc("EX-09") as NonNullable<ReturnType<typeof findDirtyDoc>>);
    assert.equal(ex09.fin001.amountCny, 50000);
    assert.equal(ex09.fin001.triggered, false);

    const ex10 = runDoc(findDirtyDoc("EX-10") as NonNullable<ReturnType<typeof findDirtyDoc>>);
    assert.equal(ex10.splitSuspect, true);
    assert.equal(ex10.fin001.triggered, true);
  });

  it("抽查转人工档：EX-06 税率遮挡 → manual_review 且不算造假失败", () => {
    const ex06 = runDoc(findDirtyDoc("EX-06") as NonNullable<ReturnType<typeof findDirtyDoc>>);
    assert.equal(ex06.arithmetic.status, "manual_review");
    assert.equal(ex06.manualReview, true);
    assert.ok(ex06.manualReason.includes("税率"));
    assert.equal(ex06.passed, true);
  });
});
