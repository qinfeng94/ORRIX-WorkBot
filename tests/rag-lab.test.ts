/**
 * rag-lab.test.ts —— Day 13 防越权混合检索单元测试（Node 22 内置 test runner，零第三方依赖）
 * 覆盖：语料规模、ACL 前置过滤（普通客服物理看不到机密文档）、废止拦截（2025 十万旧规）、
 *       金额归一化、空查询边界、非法角色拒绝。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CONFIDENTIAL_COUNT, CORPUS_TOTAL, DEPRECATED_COUNT, RAG_CORPUS } from "../src/lib/raglab/corpus";
import { normalizeAmounts, searchRag, tokenize } from "../src/lib/raglab/retrieval";

describe("Day13 语料库规模与构成", () => {
  it("语料恰好 52 份，含 3 份已废止与 5 份机密文件", () => {
    assert.equal(CORPUS_TOTAL, 52);
    assert.equal(RAG_CORPUS.length, 52);
    assert.equal(DEPRECATED_COUNT, 3);
    assert.equal(CONFIDENTIAL_COUNT, 5);
  });

  it("四大部门齐全，现行 FIN-001 新规与 2025 已废止十万旧规同时存在", () => {
    const depts = new Set(RAG_CORPUS.map((d) => d.dept));
    assert.deepEqual([...depts].sort(), ["财务", "运营", "客服", "法务"].sort());
    assert.ok(RAG_CORPUS.some((d) => d.id === "POL-FIN-2026-001" && d.status === "current"));
    assert.ok(RAG_CORPUS.some((d) => d.id === "POL-FIN-2025-011" && d.status === "deprecated"));
  });

  it("机密文件仅允许 executive 角色可见", () => {
    for (const d of RAG_CORPUS.filter((x) => x.confidential)) {
      assert.deepEqual(d.roles, ["executive"]);
    }
  });
});

describe("Day13 分词与金额归一化", () => {
  it("「5万/五万/50,000」统一归一化为 50000", () => {
    assert.ok(normalizeAmounts("单笔超过5万").includes("50000"));
    assert.ok(normalizeAmounts("超过五万元").includes("50000"));
    assert.ok(normalizeAmounts("¥50,000").includes("50000"));
    assert.ok(tokenize("额度恢复10万了吗").includes("100000"));
  });

  it("编号类 token 完整保留（fin-001 / cust-8842）", () => {
    const t = tokenize("请查 FIN-001 与 CUST-8842 的处理口径");
    assert.ok(t.includes("fin-001"));
    assert.ok(t.includes("cust-8842"));
  });
});

describe("Day13 ACL 前置过滤（越权物理隔离）", () => {
  it("普通客服检索并购关键词：命中结果零机密文档，统计面板只给份数不给标题", () => {
    const r = searchRag("Project Starfall 并购对价是多少", "support_agent");
    assert.equal(r.pool.total, 52);
    assert.ok(r.pool.visible < 52);
    assert.equal(r.pool.filteredConfidential, 5);
    for (const h of r.hits) assert.equal(h.docId.includes("M&A"), false);
    // 命中/拦截/通报等字段不含机密文档标题（query 回显属用户自身输入，不算泄露）
    const serialized = JSON.stringify({ pool: r.pool, hits: r.hits, intercepted: r.intercepted, notices: r.notices });
    assert.equal(serialized.includes("Project Starfall"), false);
    assert.equal(serialized.includes("尽职调查"), false);
  });

  it("集团高管检索并购关键词：机密文档正常命中且带精准引用标号", () => {
    const r = searchRag("Project Starfall 并购对价安排", "executive");
    assert.equal(r.pool.filteredConfidential, 0);
    assert.ok(r.hits.some((h) => h.docId.endsWith("M&A-01")));
    for (const h of r.hits) assert.match(h.ref, /^\[.+-\d+ §\d+]$/);
  });

  it("财务主管可见内部 SOP，但机密并购文件仍被过滤", () => {
    const r = searchRag("退款操作流程", "finance_lead");
    assert.ok(r.pool.visible > 40);
    assert.equal(r.pool.filteredConfidential, 5);
    assert.ok(r.hits.some((h) => h.docId.startsWith("FIN-SOP")));
  });

  it("部门内部 SOP 对普通客服不可见（filteredInternal > 0）", () => {
    const r = searchRag("绩效考核指标", "support_agent");
    assert.ok(r.pool.filteredInternal > 0);
    assert.equal(r.hits.some((h) => h.docId === "CS-SOP-038"), false);
  });
});

describe("Day13 废止拦截（2025 十万旧规防幻觉）", () => {
  it("十万旧规命中即被拦截，不进引用；通报指回 FIN-001 现行制度", () => {
    const r = searchRag("现在付款审批额度是10万吗", "finance_lead");
    assert.ok(r.intercepted.some((d) => d.docId === "POL-FIN-2025-011"));
    assert.equal(r.hits.some((h) => h.docId === "POL-FIN-2025-011"), false);
    assert.ok(r.notices.some((n) => n.includes("废止")));
    assert.ok(r.notices.some((n) => n.includes("FIN-001")));
    assert.ok(r.hits.some((h) => h.docId === "POL-FIN-2026-001"));
  });

  it("已废止旧物流标准同样被拦截", () => {
    const r = searchRag("干线运输几天算超期", "support_agent");
    assert.ok(r.intercepted.some((d) => d.docId === "POL-OPS-2024-009"));
    assert.ok(r.hits.some((h) => h.docId === "POL-OPS-2026-001"));
  });
});

describe("Day13 边界场景", () => {
  it("空查询与纯符号查询不崩溃且返回空命中", () => {
    for (const q of ["", "   ", "？！。，"]) {
      const r = searchRag(q, "support_agent");
      assert.equal(r.hits.length, 0);
      assert.ok(r.notices.length > 0);
    }
  });

  it("非法角色抛出异常（由 API 层转 400）", () => {
    assert.throws(() => searchRag("退款", "hacker" as never), /非法角色/);
  });

  it("TopK 截断生效（默认不超过 6 条）", () => {
    const r = searchRag("客户 退款 物流 审批 工单 赔付 超期", "executive");
    assert.ok(r.hits.length <= 6);
  });
});
