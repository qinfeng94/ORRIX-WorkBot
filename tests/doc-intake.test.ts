/**
 * doc-intake.test.ts —— Day 31 超大表格分治与修订版 Word 接入台核心逻辑单元测试（Node 内置 test runner）
 * 运行：pnpm test
 * 覆盖：① 8,500 行生成器确定性（固定种子 / 3 笔 FIN-001 / 2 组重复扣款）；
 *      ② 零依赖 zip 读写往返（docx / xlsx 均真实可解）；
 *      ③ 修订版合同解析：删除线条款 ≠ 生效（7.2 修订 / 第九条整条删除 / 批注挂回）；
 *      ④ CSV / XLSX 解析往返与坏行计数（宁缺毋滥、绝不编造）；
 *      ⑤ 确定性扫描：恰好 5 条异常（FIN-001 真源口径「超过才触发」/ 重复扣款配对）；
 *      ⑥ Token 对比：分治节省 >95%；送审上下文含 untrusted 隔离与「已删除·禁止引用」标记；
 *      ⑦ 离线解读文案红线词检查（严禁 AI 打款表述、删除条款明确不得引用）。
 * 边界：被测对象全部为确定性纯函数，测试不联网、不跑真实 LLM。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildContractDocx, CONTRACT_SAMPLE_META } from "../src/lib/doc-intake/contract-doc.ts";
import { buildOfflineInterpretation } from "../src/lib/doc-intake/engine.ts";
import {
  buildReconXlsx,
  generateReconRows,
  RECON_SAMPLE_META,
  reconRowsToCsv,
} from "../src/lib/doc-intake/generator.ts";
import {
  detectArchiveKind,
  parseContractDocx,
  parseCsvRecon,
  parseXlsxRecon,
} from "../src/lib/doc-intake/intake-parsers.ts";
import {
  buildDistilledContext,
  buildTokenCompare,
  estimateTokensCn,
  scanReconTable,
} from "../src/lib/doc-intake/table-engine.ts";
import type { ReconRow } from "../src/lib/doc-intake/types.ts";
import { buildZip, decodeZipText, readZip } from "../src/lib/doc-intake/zip.ts";

const rows = generateReconRows();
const contract = parseContractDocx(buildContractDocx());
const scan = scanReconTable(rows);

/** 构造最小对账行（FIN-001 边界测试专用） */
function minimalRow(overrides: Partial<ReconRow> = {}): ReconRow {
  return {
    rowNo: 1,
    date: "2026-11-01",
    department: "财务部",
    customerNo: "CUST-0001",
    docNo: "INV-TEST-0001",
    summary: "测试流水（虚构）",
    currency: "人民币",
    amountCny: 100,
    status: "已入账",
    ...overrides,
  };
}

/* ================================================================
 * ① 生成器确定性：8,500 行 / 3 笔超 5 万 / 2 组重复扣款
 * ================================================================ */
describe("① 生成器（8500 行仿真对账大表）", () => {
  it("两次生成逐字节一致（固定种子 20261126）", () => {
    assert.deepEqual(generateReconRows(), rows);
    assert.equal(rows.length, RECON_SAMPLE_META.rowCount);
    assert.deepEqual(
      rows.map((r) => r.rowNo),
      Array.from({ length: RECON_SAMPLE_META.rowCount }, (_, i) => i + 1),
    );
  });

  it("暗藏恰好 3 笔财务部单笔超 ¥50,000（行号 1241 / 4462 / 7714）", () => {
    const fin001 = rows.filter((r) => r.amountCny > 50000);
    assert.equal(fin001.length, RECON_SAMPLE_META.fin001Planted);
    assert.deepEqual(
      fin001.map((r) => r.rowNo).sort((a, b) => a - b),
      [1241, 4462, 7714],
    );
    assert.ok(fin001.every((r) => r.department === "财务部"));
    assert.deepEqual(fin001.map((r) => r.amountCny).sort((a, b) => a - b), [51780, 62400, 88000]);
  });

  it("暗藏恰好 2 组重复扣款（同单据号/客户/金额，仅序号不同）", () => {
    for (const docNo of ["INV-2026-DUP01", "INV-2026-DUP02"]) {
      const pair = rows.filter((r) => r.docNo === docNo);
      assert.equal(pair.length, 2, `${docNo} 应恰好出现 2 次`);
      const [first, second] = pair;
      assert.ok(first && second);
      const base = { ...first, rowNo: 0 };
      assert.deepEqual({ ...second, rowNo: 0 }, base, `${docNo} 两行除序号外应完全一致`);
    }
    const dup01 = rows.filter((r) => r.docNo === "INV-2026-DUP01");
    assert.deepEqual(dup01.map((r) => r.rowNo).sort((a, b) => a - b), [2103, 3127]);
    const dup02 = rows.filter((r) => r.docNo === "INV-2026-DUP02");
    assert.deepEqual(dup02.map((r) => r.rowNo).sort((a, b) => a - b), [5502, 6488]);
  });
});

/* ================================================================
 * ② 零依赖 zip 读写往返
 * ================================================================ */
describe("② zip 读写往返（docx / xlsx 的地基）", () => {
  it("buildZip → readZip 内容无损（含中文文件名与目录条目）", () => {
    const payload = new TextEncoder().encode("星辰 WorkBot zip 往返测试：中文内容 ok");
    const zipBytes = buildZip([
      { name: "dir/测试.txt", data: payload },
      { name: "b.json", data: new TextEncoder().encode('{"ok":true}') },
    ]);
    const parsed = readZip(zipBytes);
    const payloadBack = parsed.get("dir/测试.txt");
    assert.ok(payloadBack);
    assert.deepEqual(payloadBack, payload);
    const bJson = parsed.get("b.json");
    assert.ok(bJson);
    assert.equal(decodeZipText(bJson), '{"ok":true}');
  });

  it("生成的 xlsx / docx 都是合法 zip 容器（关键部件齐全）", () => {
    const xlsxParts = readZip(buildReconXlsx(rows));
    assert.ok(xlsxParts.has("xl/worksheets/sheet1.xml"));
    assert.ok(xlsxParts.has("xl/workbook.xml"));
    const docxParts = readZip(buildContractDocx());
    assert.ok(docxParts.has("word/document.xml"));
    assert.ok(docxParts.has("word/comments.xml"));
  });
});

/* ================================================================
 * ③ 修订版合同解析：删除线 ≠ 生效（核心考点）
 * ================================================================ */
describe("③ 修订版合同解析（已删除条款 vs 现行生效条款）", () => {
  it("元计数与样本设计一致：1 删除 / 1 修订 / 2 批注", () => {
    assert.equal(contract.deletedCount, CONTRACT_SAMPLE_META.deletedCount);
    assert.equal(contract.amendedCount, CONTRACT_SAMPLE_META.amendedCount);
    assert.equal(contract.commentCount, CONTRACT_SAMPLE_META.commentCount);
    assert.ok(contract.title.includes("星辰跨境企服集团"));
  });

  it("7.2 条被标记为「已修订」：5% 上不封顶进删除线，0.05% 进生效文本", () => {
    const c72 = contract.clauses.find((c) => c.id === "7.2");
    assert.ok(c72, "应解析出 7.2 条");
    assert.equal(c72.status, "amended");
    assert.ok(c72.deletedText.includes("5%") && c72.deletedText.includes("上不封顶"));
    assert.ok(c72.effectiveText.includes("0.05%") && c72.effectiveText.includes("10%"));
    assert.ok(!c72.effectiveText.includes("上不封顶"), "生效文本不得混入已删内容");
    assert.ok(c72.comment.includes("霸王条款"), "批注应挂回条款");
  });

  it("第九条（自动扣款授权）整条删除：无任何生效文本——严禁当真", () => {
    const c9 = contract.clauses.find((c) => c.id === "九");
    assert.ok(c9, "应解析出第九条（中文数字条款号保留原文）");
    assert.equal(c9.status, "deleted");
    assert.equal(c9.effectiveText, "", "已删整条的生效文本必须为空");
    assert.ok(c9.deletedText.includes("自动扣划"), "删除线文本即原霸王条款正文");
    assert.ok(c9.comment.includes("废除") || c9.comment.includes("红区"));
  });

  it("修订新增的第十二状态为「现行生效·新增」；生效条款共 4 条", () => {
    const c12 = contract.clauses.find((c) => c.id === "十二");
    assert.ok(c12, "应解析出第十二条（中文数字条款号保留原文）");
    assert.equal(c12.status, "effective");
    assert.equal(c12.inserted, true);
    assert.equal(
      contract.clauses.filter((c) => c.status === "effective").length,
      CONTRACT_SAMPLE_META.clauseCount - CONTRACT_SAMPLE_META.deletedCount - CONTRACT_SAMPLE_META.amendedCount,
    );
  });
});

/* ================================================================
 * ④ CSV / XLSX 解析往返 + 坏行计数
 * ================================================================ */
describe("④ 对账大表解析往返（CSV / XLSX）", () => {
  it("CSV：BOM + 8,500 行无损还原，预埋异常行原样保留", () => {
    const csv = reconRowsToCsv(rows);
    assert.ok(csv.startsWith("\uFEFF"), "CSV 必须带 BOM（Excel 打开中文不乱码）");
    const parsed = parseCsvRecon(csv);
    assert.equal(parsed.rows.length, RECON_SAMPLE_META.rowCount);
    assert.equal(parsed.corruptRows, 0);
    const row1241 = parsed.rows.find((r) => r.docNo === rows[1240]?.docNo);
    assert.ok(row1241);
    assert.equal(row1241.amountCny, 62400);
    assert.equal(row1241.department, "财务部");
  });

  it("XLSX：数值单元格金额无损还原，重复扣款配对完整", () => {
    const parsed = parseXlsxRecon(buildReconXlsx(rows));
    assert.equal(parsed.rows.length, RECON_SAMPLE_META.rowCount);
    assert.equal(parsed.corruptRows, 0);
    const dup02 = parsed.rows.filter((r) => r.docNo === "INV-2026-DUP02");
    assert.equal(dup02.length, 2);
    assert.deepEqual(dup02.map((r) => r.rowNo).sort((a, b) => a - b), [5502, 6488]);
    const row7714 = parsed.rows.find((r) => r.docNo === rows[7713]?.docNo);
    assert.ok(row7714);
    assert.equal(row7714.amountCny, 88000);
  });

  it("坏行只计数、不编造；缺必备列直接抛错", () => {
    const dirtyCsv = [
      "单据号,客户编号,部门,金额(元)",
      "INV-001,CUST-1,财务部,100",
      "INV-002,CUST-2,客服部,abc",
      ",CUST-3,运营部,50",
      "INV-004,CUST-4,市场部,66.5",
    ].join("\n");
    const dirty = parseCsvRecon(dirtyCsv);
    assert.equal(dirty.rows.length, 2);
    assert.equal(dirty.corruptRows, 2);
    assert.throws(() => parseCsvRecon("单据号,客户编号,部门\nINV-1,CUST-1,财务部"), /缺少必备列/);
  });

  it("detectArchiveKind 正确分流 docx / xlsx / unknown", () => {
    assert.equal(detectArchiveKind(buildContractDocx()), "docx");
    assert.equal(detectArchiveKind(buildReconXlsx(rows)), "xlsx");
    assert.equal(detectArchiveKind(new TextEncoder().encode("不是 zip 的普通文本")), "unknown");
  });
});

/* ================================================================
 * ⑤ 确定性扫描：恰好 5 条异常 + FIN-001 真源口径
 * ================================================================ */
describe("⑤ scanReconTable（确定性分治引擎）", () => {
  it("内置样本恰好筛出 5 条异常：3 FIN-001（金额降序在前）+ 2 重复扣款", () => {
    assert.equal(scan.anomalies.length, 5);
    const fin001 = scan.anomalies.filter((a) => a.kind === "fin001_over_limit");
    const dups = scan.anomalies.filter((a) => a.kind === "duplicate_deduction");
    assert.equal(fin001.length, 3);
    assert.equal(dups.length, 2);
    assert.deepEqual(fin001.map((a) => a.amountCny), [88000, 62400, 51780]);
    assert.ok(fin001.every((a) => a.fin001Required));
    assert.ok(dups.every((a) => !a.fin001Required));
    // 同类异常内按金额降序：DUP02 合计 13,080 > DUP01 合计 7,720
    assert.deepEqual(
      dups.map((a) => a.rowNos.slice().sort((x, y) => x - y)),
      [
        [5502, 6488],
        [2103, 3127],
      ],
    );
  });

  it("聚合报告：行数 / 重复组数 / 坏行数口径正确", () => {
    assert.equal(scan.report.rowCount, RECON_SAMPLE_META.rowCount);
    assert.equal(scan.report.duplicateGroups, RECON_SAMPLE_META.duplicatePlanted);
    assert.equal(scan.report.corruptRows, 0);
    assert.ok(scan.report.totalAmountCny > 0);
    assert.ok(scan.report.byDepartment.length > 0 && scan.report.byMonth.length > 0);
  });

  it("FIN-001 真源口径：「等于」5 万不触发、「超过」才触发；非财务部不触发", () => {
    assert.equal(scanReconTable([minimalRow({ amountCny: 50000 })]).anomalies.length, 0);
    assert.equal(scanReconTable([minimalRow({ amountCny: 50000.01 })]).anomalies.length, 1);
    assert.equal(scanReconTable([minimalRow({ department: "技术部", amountCny: 88000 })]).anomalies.length, 0);
  });
});

/* ================================================================
 * ⑥ Token 对比（>95%）与送审上下文隔离
 * ================================================================ */
describe("⑥ 分治 Token 对比与送审上下文", () => {
  const naiveText = reconRowsToCsv(rows) + JSON.stringify(contract.clauses);
  const distilled = buildDistilledContext({
    summary: scan.report,
    anomalies: scan.anomalies,
    clauses: contract.clauses,
    contractTitle: contract.title,
    question: "本次对账有哪些异常与合同风险？",
    sourceLabel: "内置样本（虚构）",
  });
  const compare = buildTokenCompare(naiveText, distilled, rows.length, scan.anomalies.length, 3);

  it("estimateTokensCn 与 llm-client 口径一致（1.5 字符/token）", () => {
    assert.equal(estimateTokensCn("123456"), 4);
  });

  it("内置样本分治节省 >95%（8,500 行绝不直塞大模型）", () => {
    assert.equal(compare.naiveRecords, RECON_SAMPLE_META.rowCount);
    assert.equal(compare.distilledRecords, scan.anomalies.length);
    assert.equal(compare.naive.inputTokens, Math.ceil(naiveText.length / 1.5));
    assert.ok(
      compare.savingsPct > 95,
      `分治节省应 >95%，实测 ${String(compare.savingsPct)}%`,
    );
    assert.ok(compare.distilled.inputTokens < compare.naive.inputTokens / 20);
  });

  it("送审上下文含 untrusted 隔离标签与「已删除·禁止引用」标记", () => {
    assert.ok(distilled.includes("<untrusted_document_content>"));
    assert.ok(distilled.includes("已删除·禁止引用"));
    assert.ok(distilled.includes("严禁出现任何 AI 自动打款"));
    const noTable = buildDistilledContext({
      summary: null,
      anomalies: [],
      clauses: [],
      contractTitle: contract.title,
      question: "q",
      sourceLabel: "仅合同",
    });
    assert.ok(noTable.includes("（本次未接入对账大表）"));
  });
});

/* ================================================================
 * ⑦ 离线解读文案：红线词检查
 * ================================================================ */
describe("⑦ 离线高仿真解读（红线词检查）", () => {
  const compare = buildTokenCompare(
    reconRowsToCsv(rows),
    buildDistilledContext({
      summary: scan.report,
      anomalies: scan.anomalies,
      clauses: contract.clauses,
      contractTitle: contract.title,
      question: "有哪些风险？",
      sourceLabel: "内置样本（虚构）",
    }),
    rows.length,
    scan.anomalies.length,
    3,
  );
  const answer = buildOfflineInterpretation({
    question: "有哪些风险？",
    summary: scan.report,
    anomalies: scan.anomalies,
    contract,
    compare,
    sourceLabel: "内置样本（虚构）",
  });

  it("明确宣告已删除条款不得引用，自动扣款类内容拒绝执行并上报", () => {
    assert.ok(answer.includes("整条废除"));
    assert.ok(answer.includes("不得引用"));
    assert.ok(answer.includes("拒绝执行并上报"));
    assert.ok(answer.includes("删除线 ≠ 生效") || answer.includes("删除线"));
  });

  it("FIN-001：强调具名人工审批，绝不出现 AI 自动打款完成时表述", () => {
    assert.ok(answer.includes("具名"));
    assert.ok(answer.includes("¥88,000.00"));
    for (const banned of ["已自动打款", "已自动付款", "已自动放款", "无需人工审批", "免审批", "跳过审批"]) {
      assert.ok(!answer.includes(banned), `离线解读不得出现「${banned}」`);
    }
  });

  it("架构收益段引用真实对比数字", () => {
    assert.ok(answer.includes("节省"));
    assert.ok(answer.includes("8,500"));
  });
});
