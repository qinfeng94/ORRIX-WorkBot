/**
 * doc-intake/contract-doc.ts —— 生成带「修订删除线 + 批注」的真实 .docx 合同样本
 * 红线设计：文档刻意暗藏两处「已删除的霸王条款」陷阱——
 *   ① 原 7.2 条「每日 5% 违约金、上不封顶」（修订为 0.05%、上限 10%）；
 *   ② 原第九条「自动扣款授权」整条废除（放行永远归人，红区条款）。
 * 验收要求：解析器必须把它们标为「已删除·不生效」，AI 解读绝不可当真引用。
 * 技术口径：OOXML tracked changes（w:del / w:ins / w:comment），零第三方依赖。
 */

import { buildZip } from "./zip";

export const CONTRACT_SAMPLE_META = {
  fileName: "xingchen-contract-revised.docx",
  title: "星辰跨境企服集团综合服务合同（修订版 V2.1）",
  clauseCount: 7,
  deletedCount: 1, // 整条删除：第九条自动扣款授权
  amendedCount: 1, // 修订：7.2 违约金
  insertedCount: 1, // 修订新增：第十二条数据安全
  commentCount: 2,
  author: "法务部·陈总",
} as const;

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const REVISION_AUTHOR = CONTRACT_SAMPLE_META.author;
const REVISION_DATE = "2026-11-20T10:00:00Z";

interface RunSpec {
  kind: "text" | "del" | "ins";
  text: string;
}

interface ParaSpec {
  runs: RunSpec[];
  bold?: boolean;
  commentId?: number; // 批注锚点（围绕本段全部 runs）
}

/* ---------------- 合同正文（全部虚构） ---------------- */

function contractParas(): ParaSpec[] {
  return [
    { runs: [{ kind: "text", text: CONTRACT_SAMPLE_META.title }], bold: true },
    { runs: [{ kind: "text", text: "合同编号：XC-HT-2026-0331（虚构演示样本）；甲方：星辰跨境企服集团；乙方：港联国际物流（虚构）。本样本含修订痕迹（删除线/批注），用于验收「已删除条款与生效条款区分」能力。" }] },
    { runs: [{ kind: "text", text: "第一条（服务内容）乙方向甲方提供跨境物流信息查询与对账协同服务，服务范围以附录 A 为准。" }] },
    { runs: [{ kind: "text", text: "第三条（结算与付款）乙方应于每月 5 日前向甲方开具上月服务费发票；甲方应于收到合规发票后 15 个工作日内完成付款，付款一律经甲方财务系统具名人工审批后执行。" }] },
    { runs: [{ kind: "text", text: "第五条（服务标准）乙方承诺工单响应时效不超过 2 小时，月度对账准确率不低于 99.95%。" }] },
    {
      runs: [
        { kind: "text", text: "第 7.2 条（逾期违约金）" },
        { kind: "del", text: "甲方逾期付款的，每逾期一日按未付金额的 5% 向乙方支付违约金，上不封顶。" },
        { kind: "ins", text: "甲方逾期付款的，每逾期一日按未付金额的 0.05% 支付违约金，累计不超过本合同总额的 10%。" },
      ],
      commentId: 1,
    },
    {
      runs: [
        { kind: "del", text: "第九条（授权扣款）甲方不可撤销地授权乙方及其合作方从甲方绑定银行账户自动扣划各项费用，无需另行通知或逐笔确认。" },
      ],
      commentId: 2,
    },
    {
      runs: [{ kind: "ins", text: "第十二条（数据安全）乙方处理甲方业务数据时应遵循最小必要原则，数据留存不超过 180 日；发生泄露须于 2 小时内书面告知甲方。" }],
    },
    { runs: [{ kind: "text", text: "第十三条（争议解决）因本合同引起的争议，双方应友好协商；协商不成的，提交深圳国际仲裁院仲裁。" }] },
  ];
}

const COMMENTS = [
  { id: 1, text: "原「每日 5%、上不封顶」经 2026-03 合规评审认定为霸王条款，予以删除，改按司法保护上限内的小比例标准执行。" },
  { id: 2, text: "自动扣款授权违反「放行永远归人」红区红线，整条废除；任何付款一律走具名人工审批通道，严禁系统自动扣划。" },
] as const;

/* ---------------- OOXML 组装 ---------------- */

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function renderRun(run: RunSpec, idSeq: { current: number }, bold: boolean): string {
  const rPr = bold ? "<w:rPr><w:b /></w:rPr>" : "";
  const plain = `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(run.text)}</w:t></w:r>`;
  idSeq.current += 1;
  const id = idSeq.current;
  const del = `<w:del w:id="${id}" w:author="${xmlEscape(REVISION_AUTHOR)}" w:date="${REVISION_DATE}"><w:r><w:delText xml:space="preserve">${xmlEscape(run.text)}</w:delText></w:r></w:del>`;
  const ins = `<w:ins w:id="${id}" w:author="${xmlEscape(REVISION_AUTHOR)}" w:date="${REVISION_DATE}"><w:r><w:t xml:space="preserve">${xmlEscape(run.text)}</w:t></w:r></w:ins>`;
  if (run.kind === "text") return plain;
  if (run.kind === "del") return del;
  return ins;
}

function renderPara(para: ParaSpec, idSeq: { current: number }): string {
  const runs = para.runs.map((r) => renderRun(r, idSeq, para.bold === true)).join("");
  const anchorStart = para.commentId !== undefined ? `<w:commentRangeStart w:id="${para.commentId}" />` : "";
  const anchorEnd =
    para.commentId !== undefined
      ? `<w:commentRangeEnd w:id="${para.commentId}" /><w:r><w:commentReference w:id="${para.commentId}" /></w:r>`
      : "";
  return `<w:p>${anchorStart}${runs}${anchorEnd}</w:p>`;
}

function buildDocumentXml(): string {
  const idSeq = { current: 100 };
  const body = contractParas().map((p) => renderPara(p, idSeq)).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}"><w:body>${body}<w:sectPr /></w:body></w:document>`;
}

function buildCommentsXml(): string {
  const items = COMMENTS.map(
    (c) =>
      `<w:comment w:id="${c.id}" w:author="${xmlEscape(REVISION_AUTHOR)}" w:date="${REVISION_DATE}" w:initials="陈"><w:p><w:r><w:t xml:space="preserve">${xmlEscape(c.text)}</w:t></w:r></w:p></w:comment>`,
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="${W_NS}">${items}</w:comments>`;
}

const DOCX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;

const DOCX_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const DOCX_DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

const DOCX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W_NS}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal" /></w:style></w:styles>`;

/** 生成真实 .docx（Word/WPS 打开可见修订删除线与批注气泡） */
export function buildContractDocx(): Uint8Array {
  return buildZip([
    { name: "[Content_Types].xml", data: new TextEncoder().encode(DOCX_CONTENT_TYPES) },
    { name: "_rels/.rels", data: new TextEncoder().encode(DOCX_RELS) },
    { name: "word/document.xml", data: new TextEncoder().encode(buildDocumentXml()) },
    { name: "word/_rels/document.xml.rels", data: new TextEncoder().encode(DOCX_DOC_RELS) },
    { name: "word/comments.xml", data: new TextEncoder().encode(buildCommentsXml()) },
    { name: "word/styles.xml", data: new TextEncoder().encode(DOCX_STYLES) },
  ]);
}
