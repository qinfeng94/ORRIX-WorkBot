/**
 * doc-intake/intake-parsers.ts —— 接入台三合一解析器（全部白盒正则，零第三方依赖）
 * ① parseContractDocx：解析 OOXML tracked changes —— 核心考点：
 *    w:del（删除线）→「已删除·不生效」；w:ins（修订插入）→ 现行生效；
 *    w:comment 批注挂回条款；严禁把删掉的霸王条款当真。
 * ② parseCsvRecon / parseXlsxRecon：对账大表还原为结构化行；坏行只计数、不编造（算术防编造）。
 * ③ detectArchiveKind：识别上传包是 docx 还是 xlsx。
 */

import type { ContractParseResult, ParsedClause, ReconRow } from "./types";
import { decodeZipText, readZip } from "./zip";

function unescapeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/* ---------------- ① 合同 docx 解析 ---------------- */

interface ParaScan {
  plainText: string; // 原文正文 + w:ins 插入内容（现行口径）
  deletedText: string; // w:del 删除线内容
  hasInsertion: boolean;
  commentIds: number[];
}

/** 逐段落按出现顺序区分：普通文本 / 删除线文本 / 修订插入文本 */
function scanParagraph(paraXml: string): ParaScan {
  const markers: Array<{ pos: number; kind: "plain" | "del"; text: string }> = [];
  for (const m of paraXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) {
    markers.push({ pos: m.index ?? 0, kind: "plain", text: unescapeXml(m[1]) });
  }
  for (const m of paraXml.matchAll(/<w:delText(?:\s[^>]*)?>([\s\S]*?)<\/w:delText>/g)) {
    markers.push({ pos: m.index ?? 0, kind: "del", text: unescapeXml(m[1]) });
  }
  markers.sort((a, b) => a.pos - b.pos);

  const scan: ParaScan = { plainText: "", deletedText: "", hasInsertion: false, commentIds: [] };
  scan.hasInsertion = /<w:ins\s/.test(paraXml);
  for (const m of markers) {
    if (m.kind === "del") scan.deletedText += m.text;
    else scan.plainText += m.text;
  }
  for (const m of paraXml.matchAll(/<w:commentReference w:id="(\d+)"\s*\/>/g)) {
    scan.commentIds.push(Number(m[1]));
  }
  return scan;
}

function loadComments(data: Uint8Array): Map<number, string> {
  const map = new Map<number, string>();
  const zip = readZip(data);
  const commentsPart = zip.get("word/comments.xml");
  if (!commentsPart) return map;
  const xml = decodeZipText(commentsPart);
  for (const m of xml.matchAll(/<w:comment\s[^>]*w:id="(\d+)"[^>]*>([\s\S]*?)<\/w:comment>/g)) {
    const text = [...m[2].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((t) => unescapeXml(t[1])).join("");
    map.set(Number(m[1]), text.trim());
  }
  return map;
}

const CLAUSE_ID_RE = /第\s*(\d+(?:\.\d+)?|[一二三四五六七八九十]+)\s*条\s*[（(]([^）)]*)[）)]?/;

/** 解析合同 docx：条款号 + 状态（生效/已删除/已修订）+ 批注 */
export function parseContractDocx(data: Uint8Array): ContractParseResult {
  const zip = readZip(data);
  const documentPart = zip.get("word/document.xml");
  if (!documentPart) throw new Error("docx 解析失败：缺少 word/document.xml（不是合法 Word 文档）");
  const xml = decodeZipText(documentPart);
  const comments = loadComments(data);

  const clauses: ParsedClause[] = [];
  let title = "";
  let current: ParsedClause | null = null;

  const paragraphs = [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map((m) => m[1]);
  for (const paraXml of paragraphs) {
    const scan = scanParagraph(paraXml);
    const probe = scan.plainText.length > 0 ? scan.plainText : scan.deletedText;
    const idMatch = probe.match(CLAUSE_ID_RE);

    if (!idMatch) {
      // 条款前的文档标题/说明段
      if (!current && clauses.length === 0) title = title ? `${title} ${scan.plainText}`.trim() : scan.plainText;
      continue;
    }

    if (current) clauses.push(current);
    const status: ParsedClause["status"] =
      scan.deletedText && !scan.plainText ? "deleted" : scan.deletedText && scan.plainText ? "amended" : "effective";
    current = {
      id: idMatch[1],
      title: idMatch[2] ?? "",
      status,
      effectiveText: scan.plainText.trim(),
      deletedText: scan.deletedText.trim(),
      comment: scan.commentIds.map((cid) => comments.get(cid) ?? "").filter((t) => t !== "").join(" "),
      inserted: scan.hasInsertion && scan.deletedText === "" && scan.plainText.trim().startsWith(`第${idMatch[1]}条`),
    };
  }
  if (current) clauses.push(current);

  return {
    title: title.trim() || "未命名合同",
    clauses,
    deletedCount: clauses.filter((c) => c.status === "deleted").length,
    amendedCount: clauses.filter((c) => c.status === "amended").length,
    effectiveCount: clauses.filter((c) => c.status === "effective").length,
    commentCount: [...comments.values()].length,
  };
}

/* ---------------- ② 对账大表：CSV / XLSX 解析 ---------------- */

const REQUIRED_FIELDS = ["单据号", "客户编号", "部门", "金额(元)"] as const;

function toReconRow(record: Record<string, string>, rowNo: number): ReconRow | null {
  const amountRaw = record["金额(元)"] ?? "";
  const amount = Number(amountRaw.replace(/,/g, ""));
  const docNo = (record["单据号"] ?? "").trim();
  const customer = (record["客户编号"] ?? "").trim();
  const department = (record["部门"] ?? "").trim();
  if (!docNo || !customer || !department || !Number.isFinite(amount) || amountRaw.trim() === "") return null;
  return {
    rowNo,
    date: (record["日期"] ?? "").trim(),
    department,
    customerNo: customer,
    docNo,
    summary: (record["摘要"] ?? "").trim(),
    currency: "人民币",
    amountCny: Math.round(amount * 100) / 100,
    status: (record["状态"] ?? "").trim() || "未标注",
  };
}

/** CSV 解析：按表头中文名映射列；坏行计数跳过，绝不编造 */
export function parseCsvRecon(text: string): { rows: ReconRow[]; corruptRows: number } {
  const clean = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  const lines = clean.split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2) throw new Error("CSV 解析失败：至少需要表头 + 1 行数据");
  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  for (const field of REQUIRED_FIELDS) {
    if (!headers.includes(field)) throw new Error(`CSV 解析失败：缺少必备列「${field}」`);
  }
  const rows: ReconRow[] = [];
  let corruptRows = 0;
  lines.slice(1).forEach((line) => {
    const cells = splitCsvLine(line);
    const record: Record<string, string> = {};
    headers.forEach((h, i) => {
      record[h] = cells[i] ?? "";
    });
    const row = toReconRow(record, rows.length + 1);
    if (row) rows.push(row);
    else corruptRows += 1;
  });
  return { rows, corruptRows };
}

/** 单行 CSV 切分（支持引号包裹的逗号/转义引号） */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else inQuotes = false;
      } else current += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out;
}

/** XLSX 解析：读取 sheet1 + sharedStrings（兼容真实 Excel 产物） */
export function parseXlsxRecon(data: Uint8Array): { rows: ReconRow[]; corruptRows: number } {
  const zip = readZip(data);
  const sheetPart = zip.get("xl/worksheets/sheet1.xml");
  if (!sheetPart) throw new Error("XLSX 解析失败：缺少 xl/worksheets/sheet1.xml（不是合法 Excel 文档）");

  const shared: string[] = [];
  const sharedPart = zip.get("xl/sharedStrings.xml");
  if (sharedPart) {
    const xml = decodeZipText(sharedPart);
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const text = [...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1])).join("");
      shared.push(text);
    }
  }

  const xml = decodeZipText(sheetPart);
  const table: Record<string, string>[] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const record: Record<string, string> = {};
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const ref = (cellMatch[1].match(/r="([A-Z]+)\d+"/) ?? [])[1] ?? "";
      const type = (cellMatch[1].match(/t="(\w+)"/) ?? [])[1] ?? "";
      let value = "";
      const inner = cellMatch[2];
      if (type === "s") {
        const idx = Number((inner.match(/<v>([\s\S]*?)<\/v>/) ?? [])[1] ?? "-1");
        value = shared[idx] ?? "";
      } else if (type === "inlineStr") {
        value = [...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1])).join("");
      } else {
        value = unescapeXml((inner.match(/<v>([\s\S]*?)<\/v>/) ?? [])[1] ?? "");
      }
      if (ref !== "") record[ref] = value;
    }
    table.push(record);
  }

  if (table.length < 2) throw new Error("XLSX 解析失败：工作表为空");
  const letters = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
  const headerRow = table[0];
  const headers = letters.map((l) => (headerRow[l] ?? "").trim());
  for (const field of REQUIRED_FIELDS) {
    if (!headers.includes(field)) throw new Error(`XLSX 解析失败：缺少必备列「${field}」`);
  }

  const rows: ReconRow[] = [];
  let corruptRows = 0;
  table.slice(1).forEach((record) => {
    const mapped: Record<string, string> = {};
    letters.forEach((l, i) => {
      mapped[headers[i]] = record[l] ?? "";
    });
    const row = toReconRow(mapped, rows.length + 1);
    if (row) rows.push(row);
    else corruptRows += 1;
  });
  return { rows, corruptRows };
}

/* ---------------- ③ 上传包类型识别 ---------------- */

export function detectArchiveKind(data: Uint8Array): "docx" | "xlsx" | "unknown" {
  let zip: Map<string, Uint8Array>;
  try {
    zip = readZip(data);
  } catch {
    return "unknown";
  }
  if (zip.has("word/document.xml")) return "docx";
  if (zip.has("xl/worksheets/sheet1.xml")) return "xlsx";
  return "unknown";
}
