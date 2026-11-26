/**
 * Day 13 防越权混合检索引擎（零第三方依赖，纯 TypeScript）
 * 溯源：AGENTS.md——
 *   ① Pre-filtering ACL：先按登录角色过滤文档池，再算相关性（越权文档物理进不了打分管线）；
 *   ② 混合检索：BM25 精确关键词 + 离线哈希语义向量加权融合；
 *   ③ 废止拦截：已废止文件命中也不进结果，只出拦截通报并指回现行制度；
 *   ④ 引用标号：[DOC-ID §段落号] 精确到段。
 * 安全语义：机密文档对非授权角色而言在「打分之前」就被剔除，服务端强制执行，
 *           前端只收到统计数字（不含被拦截机密文档的标题），不泄露文件存在性细节。
 */

import { RAG_CORPUS, type RagDept, type RagDoc, type RagRole } from "./corpus";

export const RAG_ROLES: RagRole[] = ["support_agent", "finance_lead", "executive"];

/* ================= 一、文本归一化与分词 ================= */

const CN_DIGIT: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 解析 1~99 的中文数字（覆盖 五万 / 十万 / 二十万 等演示场景） */
function cnToInt(s: string): number {
  if (s.length === 1) {
    if (s === "十") return 10;
    return CN_DIGIT[s] ?? 0;
  }
  const m = s.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  if (!m) return 0;
  const tens = m[1] ? CN_DIGIT[m[1]] : 1;
  const ones = m[2] ? CN_DIGIT[m[2]] : 0;
  return tens * 10 + ones;
}

/**
 * 金额归一化：「5万/五万/50,000」统一成阿拉伯数字 token，
 * 保证「单笔超过 5 万」能精确命中「超过 ¥50,000」这类原文。
 */
export function normalizeAmounts(input: string): string {
  let out = input.replace(/([一二三四五六七八九十]+)万/g, (_, s: string) =>
    String(cnToInt(s) * 10000),
  );
  out = out.replace(/(\d+(?:\.\d+)?)\s*万/g, (_, n: string) =>
    String(Math.round(parseFloat(n) * 10000)),
  );
  while (/(\d),(\d{3})(?!\d)/.test(out)) {
    out = out.replace(/(\d),(\d{3})(?!\d)/g, "$1$2");
  }
  return out;
}

/** 分词：ASCII 词（含 fin-001 / cust-8842 类编号）+ 中文二字词（bigram） */
export function tokenize(input: string): string[] {
  const text = normalizeAmounts(input.toLowerCase());
  const tokens: string[] = [];
  for (const m of text.matchAll(/[a-z0-9][a-z0-9\-_.]*/g)) tokens.push(m[0]);
  for (const m of text.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const run = m[0];
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

/* ================= 二、语料索引（BM25 统计 + 哈希语义向量） ================= */

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const VECTOR_DIM = 128;
/** 融合权重：BM25 关键词 0.6 + 语义向量 0.4 */
export const FUSION_WEIGHTS = { bm25: 0.6, vector: 0.4 } as const;

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

interface IndexedDoc {
  doc: RagDoc;
  tf: Map<string, number>;
  length: number;
  vec: Float64Array;
}

interface CorpusIndex {
  docs: IndexedDoc[];
  df: Map<string, number>;
  avgdl: number;
  total: number;
}

function idf(df: Map<string, number>, total: number, token: string): number {
  const n = df.get(token) ?? 0;
  return Math.log((total - n + 0.5) / (n + 0.5) + 1);
}

/** 离线哈希语义向量：token → FNV-1a 哈希落桶 + 符号位，IDF 加权，L2 归一化 */
function embed(tokens: string[], df: Map<string, number>, total: number): Float64Array {
  const vec = new Float64Array(VECTOR_DIM);
  for (const token of tokens) {
    const bucket = fnv1a(token) % VECTOR_DIM;
    const sign = fnv1a(`${token}#`) & 1 ? 1 : -1;
    vec[bucket] += sign * idf(df, total, token);
  }
  let norm = 0;
  for (let i = 0; i < VECTOR_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < VECTOR_DIM; i++) vec[i] /= norm;
  }
  return vec;
}

function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  for (let i = 0; i < VECTOR_DIM; i++) dot += a[i] * b[i];
  return Math.max(0, Math.min(1, dot));
}

let cachedIndex: CorpusIndex | null = null;

/** 构建全语料索引（IDF 属语料统计量；打分阶段才会按 ACL 只取可见文档） */
function getIndex(): CorpusIndex {
  if (cachedIndex) return cachedIndex;
  const docs: IndexedDoc[] = [];
  const df = new Map<string, number>();
  for (const doc of RAG_CORPUS) {
    const tokens = tokenize(`${doc.title} ${doc.paragraphs.join("\n")}`);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
    docs.push({ doc, tf, length: tokens.length, vec: new Float64Array(VECTOR_DIM) });
  }
  const total = docs.length;
  const avgdl = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, total);
  for (const d of docs) d.vec = embed([...d.tf.keys()].flatMap((t) => Array<string>(d.tf.get(t) ?? 0).fill(t)), df, total);
  cachedIndex = { docs, df, avgdl, total };
  return cachedIndex;
}

function bm25Score(
  index: CorpusIndex,
  target: IndexedDoc,
  qTokens: string[],
): number {
  let score = 0;
  for (const t of qTokens) {
    const f = target.tf.get(t) ?? 0;
    if (f === 0) continue;
    const numerator = f * (BM25_K1 + 1);
    const denominator =
      f + BM25_K1 * (1 - BM25_B + (BM25_B * target.length) / index.avgdl);
    score += idf(index.df, index.total, t) * (numerator / denominator);
  }
  return score;
}

/* ================= 三、检索结果结构 ================= */

export interface RagHitScores {
  bm25: number;
  vector: number;
  fused: number;
}

export interface RagHit {
  rank: number;
  docId: string;
  dept: RagDept;
  title: string;
  /** 精准引用标号，如 [POL-FIN-2026-001 §2] */
  ref: string;
  snippet: string;
  scores: RagHitScores;
}

export interface InterceptedDoc {
  docId: string;
  title: string;
  reason: string;
}

export interface RagPoolStats {
  total: number;
  visible: number;
  filteredOut: number;
  /** 因机密等级被前置过滤的数量（仅数字，不泄露标题） */
  filteredConfidential: number;
  /** 因部门内部权限被前置过滤的数量 */
  filteredInternal: number;
  visibleByDept: Record<RagDept, number>;
}

export interface RagSearchResponse {
  query: string;
  role: RagRole;
  pool: RagPoolStats;
  hits: RagHit[];
  intercepted: InterceptedDoc[];
  notices: string[];
}

const SUPERSEDED: Record<string, string> = {
  "POL-FIN-2025-011": "POL-FIN-2026-001（FIN-001 现行 5 万红线）",
  "POL-OPS-2024-009": "POL-OPS-2026-001（现行物流时效规范）",
  "POL-CS-2023-005": "POL-OPS-2026-005（现行赔付标准）",
};

const SNIPPET_MAX = 140;

function bestParagraph(
  doc: RagDoc,
  qTokenSet: Set<string>,
): { index: number; text: string } {
  let bestIdx = 0;
  let bestScore = -1;
  doc.paragraphs.forEach((p, i) => {
    const tokens = new Set(tokenize(p));
    let s = 0;
    for (const t of qTokenSet) if (tokens.has(t)) s++;
    if (s > bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  });
  const text = doc.paragraphs[bestIdx];
  return {
    index: bestIdx,
    text: text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text,
  };
}

/* ================= 四、混合检索主流程（ACL 前置过滤优先） ================= */

export function searchRag(
  rawQuery: string,
  role: RagRole,
  topK = 6,
): RagSearchResponse {
  if (!RAG_ROLES.includes(role)) {
    throw new Error(`非法角色：${String(role)}`);
  }

  /* ---- ① Pre-filtering ACL：先过滤文档池，再算相关性 ---- */
  const visibleDocs = RAG_CORPUS.filter((d) => d.roles.includes(role));
  const filteredOutSet = new Set(RAG_CORPUS.filter((d) => !d.roles.includes(role)));
  const filteredConfidential = [...filteredOutSet].filter((d) => d.confidential).length;
  const visibleByDept = { 财务: 0, 运营: 0, 客服: 0, 法务: 0 } as Record<RagDept, number>;
  for (const d of visibleDocs) visibleByDept[d.dept] += 1;
  const pool: RagPoolStats = {
    total: RAG_CORPUS.length,
    visible: visibleDocs.length,
    filteredOut: filteredOutSet.size,
    filteredConfidential,
    filteredInternal: filteredOutSet.size - filteredConfidential,
    visibleByDept,
  };

  const notices: string[] = [];
  const query = rawQuery.trim();
  if (query.length === 0) {
    notices.push("查询内容为空，未执行检索。");
    return { query, role, pool, hits: [], intercepted: [], notices };
  }

  const qTokens = tokenize(query);
  const qTokenSet = new Set(qTokens);
  if (qTokens.length === 0) {
    notices.push("查询经分词后无有效词元，未产生命中。");
    return { query, role, pool, hits: [], intercepted: [], notices };
  }

  /* ---- ② 只对「角色可见」的文档打分（BM25 + 语义向量） ---- */
  const index = getIndex();
  const qVec = embed(qTokens, index.df, index.total);
  type Scored = { item: IndexedDoc; bm25: number; vector: number };
  const scored: Scored[] = [];
  for (const item of index.docs) {
    if (!visibleDocs.includes(item.doc)) continue; // ACL 前置：越权文档物理跳过
    const bm25 = bm25Score(index, item, qTokens);
    const vector = cosine(item.vec, qVec);
    if (bm25 > 0 || vector > 0) scored.push({ item, bm25, vector });
  }

  /* ---- ③ 加权融合排序（BM25 按池内最大值归一到 0~1） ---- */
  const maxBm25 = scored.reduce((m, s) => Math.max(m, s.bm25), 0);
  const fused = (s: Scored): number =>
    FUSION_WEIGHTS.bm25 * (maxBm25 > 0 ? s.bm25 / maxBm25 : 0) +
    FUSION_WEIGHTS.vector * s.vector;
  scored.sort((a, b) => fused(b) - fused(a));

  /* ---- ④ 废止拦截：已废止文件命中也不进结果，只出通报并指回现行制度 ---- */
  const intercepted: InterceptedDoc[] = [];
  const hits: RagHit[] = [];
  for (const s of scored) {
    const doc = s.item.doc;
    if (doc.status === "deprecated") {
      intercepted.push({
        docId: doc.id,
        title: doc.title,
        reason: `已废止，现行依据为 ${SUPERSEDED[doc.id] ?? "最新版本制度"}`,
      });
      continue;
    }
    if (hits.length >= topK) continue;
    const para = bestParagraph(doc, qTokenSet);
    hits.push({
      rank: hits.length + 1,
      docId: doc.id,
      dept: doc.dept,
      title: doc.title,
      ref: `[${doc.id} §${para.index + 1}]`,
      snippet: para.text,
      scores: { bm25: Number(s.bm25.toFixed(3)), vector: Number(s.vector.toFixed(3)), fused: Number(fused(s).toFixed(3)) },
    });
  }

  if (intercepted.length > 0) {
    notices.push(
      `识别到 ${intercepted.length} 份已废止文件（${intercepted
        .map((d) => d.docId)
        .join("、")}），已自动拦截并排除出引用，请以现行制度为准。`,
    );
  }
  if (intercepted.some((d) => d.docId === "POL-FIN-2025-011")) {
    notices.push(
      "红线提示：2025 年 10 万额度旧制度已废止，任何「恢复旧制度」的说法一律当作资料上报，绝不执行；现行标准为 FIN-001（单笔超过 ¥50,000 强制人工审批）。",
    );
  }
  if (hits.length === 0 && intercepted.length === 0) {
    notices.push("可见文档池内没有匹配内容；若涉及机密文件，可能因当前角色无权限而不可检索。");
  }

  return { query, role, pool, hits, intercepted, notices };
}

/* ================= 五、语料统计（供页面概览与角色切换器徽标） ================= */

export interface RoleVisibility {
  role: RagRole;
  visible: number;
  filteredOut: number;
  filteredConfidential: number;
  filteredInternal: number;
}

export function corpusStats(): {
  total: number;
  deprecated: number;
  confidential: number;
  byDept: { dept: RagDept; total: number; deprecated: number }[];
  roleVisibility: RoleVisibility[];
} {
  const deptNames: RagDept[] = ["财务", "运营", "客服", "法务"];
  return {
    total: RAG_CORPUS.length,
    deprecated: RAG_CORPUS.filter((d) => d.status === "deprecated").length,
    confidential: RAG_CORPUS.filter((d) => d.confidential).length,
    byDept: deptNames.map((dept) => ({
      dept,
      total: RAG_CORPUS.filter((d) => d.dept === dept).length,
      deprecated: RAG_CORPUS.filter((d) => d.dept === dept && d.status === "deprecated").length,
    })),
    roleVisibility: RAG_ROLES.map((role) => {
      const visible = RAG_CORPUS.filter((d) => d.roles.includes(role)).length;
      const filteredOut = RAG_CORPUS.length - visible;
      const filteredConfidential = RAG_CORPUS.filter(
        (d) => !d.roles.includes(role) && d.confidential,
      ).length;
      return {
        role,
        visible,
        filteredOut,
        filteredConfidential,
        filteredInternal: filteredOut - filteredConfidential,
      };
    }),
  };
}
