/**
 * memory.test.ts —— Day 9 三层记忆核心纯函数的单元测试（Node 内置 test runner，零第三方依赖）
 * 运行：pnpm test（即 node --experimental-strip-types --test tests/）
 * 覆盖：① 工作记忆滑窗压缩与 Token 节省；② 情景记忆提取；③ 语义偏好学习。
 * 边界：被测对象 src/lib/memory.ts 是确定性纯函数，测试不联网、不读库。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildWorkingMemory,
  estimateTokens,
  extractEpisode,
  learnPreference,
  selectInjectableFacts,
  cleanDisabledFacts,
  buildInjectPreview,
  FLOW_DEPARTMENT,
  WORKING_WINDOW_ROUNDS,
  type ChatRound,
} from "../src/lib/memory.ts";

/** 造一轮长对话（确保摘要截断真实生效） */
function longRound(n: number): ChatRound {
  const pad = "这是一段用于测试的足够长的文本，".repeat(3);
  return {
    user: `第${String(n)}轮提问：${pad}请帮我分析工单编号 TCK-${String(1000 + n)} 的处理进度与后续建议`,
    assistant: `第${String(n)}轮回复：${pad}结论是按制度走流程，涉及金额 ¥${String(1000 + n * 7)},500，需具名审批人签字放行，AI 不审批不打款。`,
  };
}

describe("① 工作记忆：滑动窗口与摘要压缩", () => {
  it("estimateTokens：中文按字计数，英文按 4 字符 1 token", () => {
    assert.equal(estimateTokens("你好世界呀"), 5);
    assert.equal(estimateTokens("abcdefgh"), 2);
    assert.equal(estimateTokens(""), 0);
    // 混合：5 个中文 + 8 个英文 → 5 + 2 = 7
    assert.equal(estimateTokens("你好世界呀abcdefgh"), 7);
  });

  it("不超过 6 轮时全部保留原文，不产生摘要、不报节省", () => {
    const rounds = Array.from({ length: WORKING_WINDOW_ROUNDS }, (_, i) => longRound(i + 1));
    const wm = buildWorkingMemory(rounds);
    assert.equal(wm.summarizedRounds, 0);
    assert.equal(wm.summaryText, "");
    assert.equal(wm.keptMessages.length, WORKING_WINDOW_ROUNDS * 2);
    assert.equal(wm.savedPercent, 0);
    assert.equal(wm.compressedTokens, wm.originalTokens);
  });

  it("超出 6 轮时旧轮次被压缩，节省 Token 百分比为正", () => {
    const rounds = Array.from({ length: 8 }, (_, i) => longRound(i + 1));
    const wm = buildWorkingMemory(rounds);
    // 前 2 轮被压缩，最近 6 轮保留原文（12 条 message）
    assert.equal(wm.summarizedRounds, 2);
    assert.equal(wm.keptMessages.length, WORKING_WINDOW_ROUNDS * 2);
    // 摘要里只包含被压缩的前 2 轮
    assert.ok(wm.summaryText.includes("第1轮"));
    assert.ok(wm.summaryText.includes("第2轮"));
    assert.ok(!wm.summaryText.includes("第3轮"));
    // 长文本下压缩必须真的省 Token
    assert.ok(wm.compressedTokens < wm.originalTokens);
    assert.ok(wm.savedPercent > 0);
    // 节省百分比与定义一致：1 - 压缩后/压缩前
    const expectPct = Math.round((1 - wm.compressedTokens / wm.originalTokens) * 100);
    assert.equal(wm.savedPercent, expectPct);
  });

  it("保留的原文正好是最近 6 轮（不丢最后一轮）", () => {
    const rounds = Array.from({ length: 9 }, (_, i) => longRound(i + 1));
    const wm = buildWorkingMemory(rounds);
    const keptUsers = wm.keptMessages
      .filter((m) => m.role === "user")
      .map((m) => m.content);
    assert.equal(keptUsers.length, WORKING_WINDOW_ROUNDS);
    assert.ok(keptUsers[keptUsers.length - 1].includes("第9轮"));
    assert.ok(!keptUsers.some((c) => c.includes("第3轮提问")));
  });

  it("摘要截断生效：两条被压缩轮次的摘要短于两条原文", () => {
    const rounds = Array.from({ length: 8 }, (_, i) => longRound(i + 1));
    const wm = buildWorkingMemory(rounds);
    const twoRoundsOriginal =
      rounds[0].user.length +
      rounds[0].assistant.length +
      rounds[1].user.length +
      rounds[1].assistant.length;
    assert.ok(wm.summaryText.length < twoRoundsOriginal);
    assert.ok(wm.summaryText.includes("…"));
  });

  it("历史轮次上限 30 轮：超出的更早轮次直接丢弃", () => {
    const rounds = Array.from({ length: 35 }, (_, i) => longRound(i + 1));
    const wm = buildWorkingMemory(rounds);
    assert.equal(wm.summarizedRounds, 30 - WORKING_WINDOW_ROUNDS);
    assert.equal(wm.keptMessages.length, WORKING_WINDOW_ROUNDS * 2);
    // 第 35 轮（最新）必须保留
    const keptUsers = wm.keptMessages.filter((m) => m.role === "user").map((m) => m.content);
    assert.ok(keptUsers[keptUsers.length - 1].includes("第35轮"));
  });

  it("空历史：不压缩、不保留、不报错", () => {
    const wm = buildWorkingMemory([]);
    assert.equal(wm.summarizedRounds, 0);
    assert.equal(wm.keptMessages.length, 0);
    assert.equal(wm.originalTokens, 0);
    assert.equal(wm.savedPercent, 0);
    assert.equal(wm.summaryText, "");
  });
});

describe("② 情景记忆：关键工单结论提取", () => {
  it("命中 CUST + TCK + 金额时生成完整结论", () => {
    const ep = extractEpisode(
      "查 CUST-8842 重复扣款的处理进度",
      "工单 TCK-3117 显示张*被重复扣款合计 ¥52,800，超过 FIN-001 红线，须具名审批人签字放行。",
    );
    assert.ok(ep !== null);
    assert.equal(ep.episodeType, "ticket_conclusion");
    assert.ok(ep.content.includes("客户 CUST-8842"));
    assert.ok(ep.content.includes("工单 TCK-3117"));
    assert.ok(ep.content.includes("¥52,800"));
    assert.ok(ep.content.includes("本次结论"));
    assert.equal(ep.ticketRefs, "TCK-3117 CUST-8842");
  });

  it("命中审批单号 AP-xxxxx 时一并入档", () => {
    const ep = extractEpisode(
      "跟进 CUST-8842 的退款",
      "已生成 Dry-Run 草稿，审批单 AP-20261126-001 等待具名审批人签字。",
    );
    assert.ok(ep !== null);
    assert.ok(ep.content.includes("AP-20261126-001"));
    assert.ok(ep.ticketRefs.includes("AP-20261126-001"));
  });

  it("重复出现的单号只记一次（去重）", () => {
    const ep = extractEpisode(
      "CUST-8842 的状态，再查一次 CUST-8842",
      "CUST-8842 当前状态为处理中。",
    );
    assert.ok(ep !== null);
    // 单号引用列表去重
    assert.equal(ep.ticketRefs, "CUST-8842");
    // 结论正文里的「客户 CUST-8842」片段只出现一次
    assert.equal((ep.content.match(/客户 CUST-8842/g) ?? []).length, 1);
  });

  it("无任何单号时不生成情景记忆（避免噪音）", () => {
    assert.equal(extractEpisode("今天天气怎么样", "今天晴，适合开会。"), null);
  });

  it("回复为空或纯空白时不生成情景记忆", () => {
    assert.equal(extractEpisode("查 CUST-8842", ""), null);
    assert.equal(extractEpisode("查 CUST-8842", "   \n\t  "), null);
  });
});

describe("③ 语义记忆：部门偏好与称呼风格学习", () => {
  it("FLOW_DEPARTMENT 映射：四类业务流对应正确部门", () => {
    assert.equal(FLOW_DEPARTMENT.finance, "财务部");
    assert.equal(FLOW_DEPARTMENT.logistics, "运营部");
    assert.equal(FLOW_DEPARTMENT.complaint, "客服部");
    assert.equal(FLOW_DEPARTMENT.generic, "");
  });

  it("generic 流不学习：原样返回，不产生部门事实", () => {
    const prev = { department: "财务部", facts: ["常关注部门：财务部"] };
    const next = learnPreference(prev, "generic");
    assert.deepEqual(next, prev);
    assert.equal(next.department, "财务部");
  });

  it("首次命中部门时写入 department 并追加事实", () => {
    const next = learnPreference({ department: "", facts: [] }, "finance");
    assert.equal(next.department, "财务部");
    assert.deepEqual(next.facts, ["常关注部门：财务部"]);
  });

  it("重复命中同一部门时事实不重复累积（幂等）", () => {
    const first = learnPreference({ department: "", facts: [] }, "finance");
    const second = learnPreference(first, "finance");
    assert.equal(second.department, "财务部");
    assert.equal(second.facts.length, 1);
    assert.deepEqual(second.facts, ["常关注部门：财务部"]);
  });

  it("部门切换时 department 更新为最新部门，事实清单保留历史", () => {
    const finance = learnPreference({ department: "", facts: [] }, "finance");
    const logistics = learnPreference(finance, "logistics");
    assert.equal(logistics.department, "运营部");
    assert.deepEqual(logistics.facts, ["常关注部门：财务部", "常关注部门：运营部"]);
  });

  it("称呼风格等既有事实不被学习逻辑破坏", () => {
    const prev = {
      department: "",
      facts: ["称呼风格：正式敬语", "偏好先看金额再看工单"],
    };
    const next = learnPreference(prev, "complaint");
    assert.equal(next.department, "客服部");
    assert.equal(next.facts.length, 3);
    assert.ok(next.facts.includes("称呼风格：正式敬语"));
    assert.ok(next.facts.includes("偏好先看金额再看工单"));
    assert.ok(next.facts.includes("常关注部门：客服部"));
  });
});

describe("④ 记忆片段开关：启用/停用切换口径", () => {
  const FACTS = ["常关注部门：财务部", "偏好先看金额再看工单", "称呼风格：正式敬语"];

  it("全部启用时，注入清单与事实清单完全一致", () => {
    assert.deepEqual(selectInjectableFacts(FACTS, []), FACTS);
  });

  it("停用其中一条后，注入清单剔除该条且保持原有顺序", () => {
    const injected = selectInjectableFacts(FACTS, ["偏好先看金额再看工单"]);
    assert.deepEqual(injected, ["常关注部门：财务部", "称呼风格：正式敬语"]);
  });

  it("停用多条后，注入清单只剩启用项", () => {
    const injected = selectInjectableFacts(FACTS, [
      "偏好先看金额再看工单",
      "称呼风格：正式敬语",
    ]);
    assert.deepEqual(injected, ["常关注部门：财务部"]);
  });

  it("停用清单含孤儿项（已删除的事实）时被忽略，不影响注入", () => {
    const injected = selectInjectableFacts(FACTS, ["早已删除的幽灵事实"]);
    assert.deepEqual(injected, FACTS);
  });

  it("事实清单为空时注入为空（停用清单残留也无害）", () => {
    assert.deepEqual(selectInjectableFacts([], ["孤儿停用项"]), []);
  });

  it("开关往返：停用再启用后注入清单恢复原样（UI 状态转移语义）", () => {
    // 停用 = 从 disabled 列表加入；启用 = 移出（与面板 toggleFact 的转移一致）
    let disabledList = [...FACTS].slice(0, 0);
    disabledList = [...disabledList, FACTS[1]]; // 停用第 2 条
    const afterOff = selectInjectableFacts(FACTS, disabledList);
    assert.equal(afterOff.length, 2);
    disabledList = disabledList.filter((f) => f !== FACTS[1]); // 重新启用
    assert.deepEqual(selectInjectableFacts(FACTS, disabledList), FACTS);
  });

  it("孤儿清理：剔除已从事实清单删除的停用残留，保留合法项顺序", () => {
    const cleaned = cleanDisabledFacts(
      ["事实A", "事实B"],
      ["孤儿残留", "事实A", "另一个孤儿"],
    );
    assert.deepEqual(cleaned, ["事实A"]);
    assert.deepEqual(cleanDisabledFacts([], ["孤儿"]), []);
    assert.deepEqual(cleanDisabledFacts(["事实A"], []), []);
  });
});

describe("④ 注入预览：面板顶部计数口径", () => {
  it("全量启用时：事实数 = 总数，情景 Y/Z 相等", () => {
    const p = buildInjectPreview(["事实1", "事实2"], [], [
      { enabled: true },
      { enabled: true },
      { enabled: true },
    ]);
    assert.equal(p.activeFacts, 2);
    assert.equal(p.activeEpisodes, 3);
    assert.equal(p.totalEpisodes, 3);
  });

  it("部分停用时：只统计启用中的片段", () => {
    const p = buildInjectPreview(
      ["事实1", "事实2", "事实3"],
      ["事实1", "事实3"],
      [{ enabled: true }, { enabled: false }, { enabled: true }],
    );
    assert.equal(p.activeFacts, 1);
    assert.equal(p.activeEpisodes, 2);
    assert.equal(p.totalEpisodes, 3);
  });

  it("全部停用 / 空数据时：预览归零不报错", () => {
    const allOff = buildInjectPreview(
      ["事实1"],
      ["事实1"],
      [{ enabled: false }, { enabled: false }],
    );
    assert.equal(allOff.activeFacts, 0);
    assert.equal(allOff.activeEpisodes, 0);
    assert.equal(allOff.totalEpisodes, 2);

    const empty = buildInjectPreview([], [], []);
    assert.equal(empty.activeFacts, 0);
    assert.equal(empty.activeEpisodes, 0);
    assert.equal(empty.totalEpisodes, 0);
  });

  it("口径一致性：预览的 activeFacts 与 chat 注入用的 selectInjectableFacts 同源", () => {
    const facts = ["事实A", "事实B"];
    const disabledFacts = ["事实A"];
    const episodes = [{ enabled: true }, { enabled: false }];
    const preview = buildInjectPreview(facts, disabledFacts, episodes);
    assert.equal(preview.activeFacts, selectInjectableFacts(facts, disabledFacts).length);
    assert.equal(preview.activeEpisodes, episodes.filter((e) => e.enabled).length);
  });
});
