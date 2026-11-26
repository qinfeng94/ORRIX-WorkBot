/**
 * doc-intake/generator.ts —— 一键生成器：8,500 行星辰集团仿真对账大表（CSV / XLSX）
 * 红线：全部数据为虚构演示内容；暗藏 3 笔单笔超 ¥50,000（财务部）与 2 组重复扣款，
 *      用于验收「确定性引擎先扫、只送精准摘要给 AI」的分治链路与 FIN-001 门禁展示。
 * 确定性：mulberry32 固定种子，两次生成结果逐字节一致（可测试快照）。
 */

import type { ReconRow } from "./types";
import { buildZip } from "./zip";

/** 固定演示种子（与题目要求一致：3 笔超 5 万异常 + 2 组重复扣款） */
export const RECON_SAMPLE_META = {
  rowCount: 8500,
  fin001Planted: 3, // 单笔超 ¥50,000（财务部）→ FIN-001 强制人工审批
  duplicatePlanted: 2, // 重复扣款组数
  dateRange: "2026-09-01 ~ 2026-11-25",
  departments: ["财务部", "客服部", "市场部", "运营部", "技术部", "人事部"] as const,
} as const;

/** 预埋异常行号（其余行号用于随机正常流水） */
const FIN001_ROWS = [1241, 4462, 7714];
const DUPLICATE_PAIRS: ReadonlyArray<{ anchor: number; echo: number; docNo: string; customer: string; amount: number; summary: string; dept: string }> = [
  { anchor: 2103, echo: 3127, docNo: "INV-2026-DUP01", customer: "CUST-5102", amount: 3860, summary: "SaaS 续费扣款（疑似重复扣款）", dept: "运营部" },
  { anchor: 5502, echo: 6488, docNo: "INV-2026-DUP02", customer: "CUST-8842", amount: 6540, summary: "API 网关月费扣款（疑似重复扣款）", dept: "技术部" },
];

/** mulberry32 确定性伪随机（工程界常用 32 位种子算法） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SUMMARIES = [
  "月度服务费结算",
  "SaaS 订阅续费付款",
  "增值服务费",
  "对账调整",
  "软件许可费",
  "渠道服务费",
  "客户退款",
  "平台使用费",
] as const;

const STATUSES = ["已入账", "已入账", "已入账", "待核对", "已退款"] as const;

function formatDate(base: Date, offsetDays: number): string {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 生成 8,500 行对账流水（确定性与金额口径均已通过单元测试锁定） */
export function generateReconRows(): ReconRow[] {
  const rand = mulberry32(20261126);
  const base = new Date(2026, 8, 1); // 2026-09-01
  const rows: ReconRow[] = [];

  for (let i = 1; i <= RECON_SAMPLE_META.rowCount; i += 1) {
    const deptIdx = Math.floor(rand() * RECON_SAMPLE_META.departments.length);
    const department = RECON_SAMPLE_META.departments[deptIdx];
    const amount = Math.round((200 + rand() * 29800) * 100) / 100;
    rows.push({
      rowNo: i,
      date: formatDate(base, Math.floor(rand() * 85)),
      department,
      customerNo: `CUST-${1000 + Math.floor(rand() * 9000)}`,
      docNo: `INV-2026-${String(i).padStart(5, "0")}`,
      summary: SUMMARIES[Math.floor(rand() * SUMMARIES.length)],
      currency: "人民币",
      amountCny: amount,
      status: STATUSES[Math.floor(rand() * STATUSES.length)],
    });
  }

  // 预埋 3 笔单笔超 ¥50,000（财务部）——「超过」才触发 FIN-001，「等于」不触发
  const fin001Specs = [
    { amount: 62400, customer: "CUST-6620", summary: "大额平台服务费付款", status: "待核对" },
    { amount: 51780, customer: "CUST-7731", summary: "大额客户退款", status: "待核对" },
    { amount: 88000, customer: "CUST-9150", summary: "大额渠道结算款", status: "待核对" },
  ] as const;
  fin001Specs.forEach((spec, idx) => {
    const rowNo = FIN001_ROWS[idx];
    const target = rows[rowNo - 1];
    if (target) {
      target.department = "财务部";
      target.customerNo = spec.customer;
      target.summary = spec.summary;
      target.amountCny = spec.amount;
      target.status = spec.status;
    }
  });

  // 预埋 2 组重复扣款：同一单据号 + 同一客户 + 同一金额出现两次（整行除序号外一致）
  for (const pair of DUPLICATE_PAIRS) {
    const build = (rowNo: number): ReconRow => ({
      rowNo,
      date: formatDate(base, 40 + (pair.anchor % 30)), // 日期以锚定行为准：同一笔扣款被记两次
      department: pair.dept,
      customerNo: pair.customer,
      docNo: pair.docNo,
      summary: pair.summary,
      currency: "人民币",
      amountCny: pair.amount,
      status: "待核对",
    });
    rows[pair.anchor - 1] = build(pair.anchor);
    rows[pair.echo - 1] = build(pair.echo);
  }

  return rows;
}

/* ---------------- CSV 导出 ---------------- */

const CSV_HEADERS = ["序号", "日期", "部门", "客户编号", "单据号", "摘要", "币种", "金额(元)", "状态"] as const;

function csvEscape(value: string): string {
  return value.includes(",") || value.includes('"') || value.includes("\n") ? `"${value.replaceAll('"', '""')}"` : value;
}

/** 导出 CSV（带 BOM，Excel 直接打开中文不乱码） */
export function reconRowsToCsv(rows: readonly ReconRow[]): string {
  const lines: string[] = [CSV_HEADERS.join(",")];
  for (const r of rows) {
    lines.push(
      [String(r.rowNo), r.date, r.department, r.customerNo, r.docNo, csvEscape(r.summary), r.currency, r.amountCny.toFixed(2), r.status].join(","),
    );
  }
  return `\uFEFF${lines.join("\r\n")}`;
}

/* ---------------- XLSX 导出（最小合法工作簿） ---------------- */

const XL_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const XL_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const XL_WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="对账明细" sheetId="1" r:id="rId1"/></sheets></workbook>`;

const XL_WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

const XL_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf/></cellXfs></styleSheet>`;

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** 生成 xlsx（金额与序号列写数值单元格，其余写 inlineStr，Word/Excel/WPS 均可打开） */
export function buildReconXlsx(rows: readonly ReconRow[]): Uint8Array {
  const colLetters = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
  const cell = (col: string, rowNo: number, kind: "str" | "num", value: string): string =>
    kind === "num"
      ? `<c r="${col}${rowNo}" t="n"><v>${value}</v></c>`
      : `<c r="${col}${rowNo}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;

  const body: string[] = [];
  body.push(`<row r="1">${CSV_HEADERS.map((h, i) => cell(colLetters[i], 1, "str", h)).join("")}</row>`);
  rows.forEach((r, idx) => {
    const n = idx + 2;
    body.push(
      `<row r="${n}">${[
        cell("A", n, "num", String(r.rowNo)),
        cell("B", n, "str", r.date),
        cell("C", n, "str", r.department),
        cell("D", n, "str", r.customerNo),
        cell("E", n, "str", r.docNo),
        cell("F", n, "str", r.summary),
        cell("G", n, "str", r.currency),
        cell("H", n, "num", r.amountCny.toFixed(2)),
        cell("I", n, "str", r.status),
      ].join("")}</row>`,
    );
  });

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body.join("")}</sheetData></worksheet>`;

  return buildZip([
    { name: "[Content_Types].xml", data: new TextEncoder().encode(XL_CONTENT_TYPES) },
    { name: "_rels/.rels", data: new TextEncoder().encode(XL_RELS) },
    { name: "xl/workbook.xml", data: new TextEncoder().encode(XL_WORKBOOK) },
    { name: "xl/_rels/workbook.xml.rels", data: new TextEncoder().encode(XL_WORKBOOK_RELS) },
    { name: "xl/styles.xml", data: new TextEncoder().encode(XL_STYLES) },
    { name: "xl/worksheets/sheet1.xml", data: new TextEncoder().encode(sheet) },
  ]);
}
