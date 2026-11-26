/**
 * research-analyst.test.ts —— Day 15 尽调研究台核心引擎单元测试（Node 内置 test runner，零第三方依赖）
 * 覆盖：① 正常路径三阶段编排（评分/缺口/引文闭环/Markdown）；
 *      ② 故障演习自愈容错（格式错误→超时→自愈、永久故障→降级缓存，绝不崩溃）；
 *      ③ 风险评分公式边界（0 分下限 / 100 封顶 / 等级阈值）；
 *      ④ 引文校验（编造引文一律剔除）。
 * 边界：被测对象 src/lib/research-analyst/engine.ts 是确定性纯函数，测试不联网、不读库。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildReportMarkdown,
  runResearchPipeline,
  scoreSupplier,
  scoreToLevel,
  validateCitations,
  type EngineEvent,
} from "../src/lib/research-analyst/engine";

/** 收集引擎事件（与线上同一调用口径，测试断言阶段齐全性用） */
function collect(): { events: EngineEvent[]; emit: (e: EngineEvent) => void } {
  const events: EngineEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}

const TOPIC = "评估华东区 3 家物流供应商的异常赔付风险与合规缺口";

describe("Day15 正常路径：三阶段编排与简报结构", () => {
  it("完整跑通三阶段，产出 3 家供应商评分与合规缺口", async () => {
    const { events, emit } = collect();
    const report = await runResearchPipeline(TOPIC, { simulateFaults: false }, emit);

    assert.ok(report.reportId.startsWith("RA-"));
    assert.equal(report.topic, TOPIC);
    assert.equal(report.suppliers.length, 3);
    // 主快照 8 条记录（6 类记录 + 2 份结算函快照口径：实际 8 条 ERP_SNAPSHOT）
    assert.equal(report.dataCoverage.erpRecords, 8);
    assert.equal(report.dataCoverage.aclDocsTotal, 52);
    assert.ok(report.dataCoverage.aclHits > 0, "ACL 检索必须命中引文");
    assert.ok(report.citations.length > 0, "证据集必须非空");
    // 三阶段事件齐全
    const phaseStarts = events.filter((e) => e.type === "phase_start");
    assert.equal(phaseStarts.length, 3);
  });

  it("三家供应商评分符合确定性公式口径（65 高 / 19 低 / 25 低，总体 36 中）", async () => {
    const report = await runResearchPipeline(TOPIC, { simulateFaults: false }, () => {});
    const byId = new Map(report.suppliers.map((s) => [s.supplierId, s]));

    const s101 = byId.get("SUP-E-101");
    assert.ok(s101);
    assert.equal(s101.score, 65); // 10 + 超期2×9 + 超上限1×12 + FIN-001待审1×25
    assert.equal(s101.level, "高");
    assert.equal(s101.metrics.fin001Pending, 1);
    assert.equal(s101.metrics.overdueIncidents, 2);

    const s102 = byId.get("SUP-E-102");
    assert.ok(s102);
    assert.equal(s102.score, 19); // 10 + 超期1×9
    assert.equal(s102.level, "低");

    const s203 = byId.get("SUP-E-203");
    assert.ok(s203);
    assert.equal(s203.score, 25); // 10 + 废止引文1×15
    assert.equal(s203.level, "低");

    assert.equal(report.overallScore, Math.round((65 + 19 + 25) / 3));
    assert.equal(report.overallLevel, "中");
  });

  it("交叉核对发现 3 项缺口：FIN-001 超红线 / 单票超上限 / 废止引文结算函", async () => {
    const report = await runResearchPipeline(TOPIC, { simulateFaults: false }, () => {});
    assert.equal(report.complianceGaps.length, 3);
    const titles = report.complianceGaps.map((g) => g.title).join("|");
    assert.ok(titles.includes("FIN-001"), "必须识别出超 5 万红线未审批缺口");
    assert.ok(titles.includes("¥3,000 上限"), "必须识别出单票赔付超上限缺口");
    assert.ok(titles.includes("已废止"), "必须识别出结算函引用废止文件缺口");

    const finGap = report.complianceGaps.find((g) => g.title.includes("FIN-001"));
    assert.ok(finGap);
    assert.equal(finGap.recordId, "SP-E-0917");
    assert.ok(finGap.detail.includes("58,000") || finGap.detail.includes("58000"));
  });

  it("引文闭环：所有缺口/发现/行动建议的引文都能在证据集中找到出处", async () => {
    const report = await runResearchPipeline(TOPIC, { simulateFaults: false }, () => {});
    const validRefs = new Set(report.citations.map((c) => c.ref));
    assert.ok(validRefs.size >= 4, "证据集至少覆盖赔付标准/FIN-001/时效规范/评审办法");

    for (const g of report.complianceGaps) {
      assert.ok(g.citations.length > 0, `缺口 ${g.recordId} 必须挂引文`);
      for (const c of g.citations) assert.ok(validRefs.has(c), `缺口引文 ${c} 必须可溯源`);
    }
    for (const s of report.suppliers) {
      for (const f of s.findings) {
        for (const c of f.citations) assert.ok(validRefs.has(c), `发现引文 ${c} 必须可溯源`);
      }
    }
    for (const a of report.actions) {
      for (const c of a.citations) assert.ok(validRefs.has(c), `行动建议引文 ${c} 必须可溯源`);
    }
    // P1 建议必须存在且涉及 FIN-001
    const p1 = report.actions.filter((a) => a.priority === "P1");
    assert.ok(p1.length >= 1);
    assert.ok(report.actions.some((a) => a.text.includes("FIN-001")));
  });

  it("Markdown 导出包含评分卡、引文出处与虚构数据免责声明", async () => {
    const report = await runResearchPipeline(TOPIC, { simulateFaults: false }, () => {});
    const md = buildReportMarkdown(report);
    assert.equal(md, report.markdown);
    assert.ok(md.includes(`# 企业尽调简报：${TOPIC}`));
    assert.ok(md.includes(report.reportId));
    assert.ok(md.includes("供应商风险评分卡"));
    assert.ok(md.includes("合规缺口清单"));
    assert.ok(md.includes("引文出处"));
    assert.ok(md.includes("[POL-"));
    assert.ok(md.includes("虚构演示内容"));
    assert.ok(md.includes("不审批、不打款"));
    // 供应商评分表必须包含三家
    assert.ok(md.includes("SUP-E-101") && md.includes("SUP-E-102") && md.includes("SUP-E-203"));
  });
});

describe("Day15 故障演习：自愈容错，绝不中途崩溃", () => {
  it("老 ERP 格式错误→超时→第 3 次自愈成功，流程不中断且数据完整", async () => {
    const report = await runResearchPipeline(TOPIC, { simulateFaults: true }, () => {});
    // 自愈成功：主快照数据一条不少
    assert.equal(report.dataCoverage.erpRecords, 8);
    // 告警留痕：erp_main 两次错误告警（格式错误 + 超时）
    const mainAlerts = report.alerts.filter((a) => a.source === "erp_main" && a.level === "error");
    assert.ok(mainAlerts.length >= 2, `erp_main 至少 2 条错误告警，实际 ${String(mainAlerts.length)}`);
    assert.ok(mainAlerts.some((a) => a.message.includes("格式错误")));
    assert.ok(mainAlerts.some((a) => a.message.includes("超时")));
    // 处置动作是自动重试而非人工介入
    assert.ok(mainAlerts.every((a) => a.action.includes("重试") || a.action.includes("降级")));
  });

  it("结算函接口永久故障 → 降级缓存继续编排，缺口照样被识别并标注覆盖缺口", async () => {
    const report = await runResearchPipeline(TOPIC, { simulateFaults: true }, () => {});
    assert.ok(
      report.dataCoverage.degradedSources.some((s) => s.includes("结算函")),
      "结算函扫描必须出现在降级源清单",
    );
    const letterAlerts = report.alerts.filter((a) => a.source === "settlement_letters");
    assert.ok(letterAlerts.length >= 3, "结算函 3 次尝试都要留痕");
    assert.ok(
      letterAlerts.some((a) => a.action === "降级缓存" && a.message.includes("缓存")),
      "最终处置必须是降级到缓存副本",
    );
    // 降级不影响结论：废止引文缺口照样被识别
    assert.ok(
      report.complianceGaps.some((g) => g.title.includes("已废止") && g.recordId === "LT-E-3011"),
    );
  });

  it("故障演习下评分与引文闭环与正常路径一致（容错不牺牲结论质量）", async () => {
    const report = await runResearchPipeline(TOPIC, { simulateFaults: true }, () => {});
    const byId = new Map(report.suppliers.map((s) => [s.supplierId, s]));
    assert.equal(byId.get("SUP-E-101")?.score, 65);
    assert.equal(report.overallLevel, "中");
    const validRefs = new Set(report.citations.map((c) => c.ref));
    for (const g of report.complianceGaps) {
      for (const c of g.citations) assert.ok(validRefs.has(c));
    }
  });
});

describe("Day15 风险评分公式边界", () => {
  it("全零指标：10 分起步，低风险", () => {
    const r = scoreSupplier({
      overdueIncidents: 0,
      capViolations: 0,
      fin001Pending: 0,
      deprecatedCitations: 0,
    });
    assert.equal(r.score, 10);
    assert.equal(r.level, "低");
  });

  it("极端违规场景封顶 100 分，绝不超上限", () => {
    const r = scoreSupplier({
      overdueIncidents: 20,
      capViolations: 20,
      fin001Pending: 20,
      deprecatedCitations: 20,
    });
    assert.equal(r.score, 100);
    assert.equal(r.level, "高");
  });

  it("等级阈值：29 低 / 30 中 / 59 中 / 60 高", () => {
    assert.equal(scoreToLevel(29), "低");
    assert.equal(scoreToLevel(30), "中");
    assert.equal(scoreToLevel(59), "中");
    assert.equal(scoreToLevel(60), "高");
  });
});

describe("Day15 引文校验：编造引文一律剔除", () => {
  it("只保留证据集中存在的引文标号", () => {
    const validRefs = new Set(["[POL-FIN-2026-001 §1]", "[POL-OPS-2026-005 §1]"]);
    const kept = validateCitations(
      ["[POL-FIN-2026-001 §1]", "[FAKE-DOC-999 §9]", "[POL-OPS-2026-005 §1]"],
      validRefs,
    );
    assert.deepEqual(kept, ["[POL-FIN-2026-001 §1]", "[POL-OPS-2026-005 §1]"]);
  });

  it("空引文清单返回空数组", () => {
    assert.deepEqual(validateCitations([], new Set(["[A §1]"])), []);
  });
});
