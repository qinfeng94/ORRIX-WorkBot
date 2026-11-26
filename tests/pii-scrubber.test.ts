/**
 * pii-scrubber.test.ts —— Day 19 PII 脱敏工具单元测试（Node 内置 test runner，零第三方依赖）
 * 运行：pnpm test（与既有测试同链路）
 * 覆盖：手机号 / 身份证号 / 银行卡号三大类替换，工单号 / 日期 / 金额 / 审批单号等
 *      高频业务编号的"绝不误杀"反例，以及深递归脱敏与启动自检。
 * 边界：被测对象 src/lib/pii-scrubber.ts 是确定性纯函数，测试不联网、不读库。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REDACTED_PII,
  assertScrubberHealthy,
  emptyPiiStats,
  scrubPii,
  scrubPiiDeep,
  scrubPiiDetailed,
} from "../src/lib/pii-scrubber.ts";

describe("① 手机号脱敏", () => {
  it("11 位大陆手机号被替换为 [REDACTED_PII]", () => {
    assert.equal(scrubPii("请回电 13812345678"), `请回电 ${REDACTED_PII}`);
    assert.equal(scrubPii("手机号：15987654321，谢谢"), `手机号：${REDACTED_PII}，谢谢`);
    assert.equal(scrubPii("18612341234"), REDACTED_PII);
  });

  it("非 1[3-9] 段的 11 位数字不是手机号，不误杀", () => {
    assert.equal(scrubPii("旧号 12345678901 已停用"), "旧号 12345678901 已停用");
    assert.equal(scrubPii("编号 10123456789"), "编号 10123456789");
  });

  it("嵌在长数字串里的手机号不截取（fail-closed 不误杀编号）", () => {
    // 12 位数字既不是手机号也不是银行卡（<13 位）→ 原样保留
    assert.equal(scrubPii("流水号 138123456781"), "流水号 138123456781");
  });
});

describe("② 身份证号脱敏", () => {
  it("18 位身份证（尾号数字）被替换", () => {
    assert.equal(scrubPii("证件号 110101199003078515"), `证件号 ${REDACTED_PII}`);
  });

  it("18 位身份证（尾号 X / x）被替换", () => {
    assert.equal(scrubPii("证件 11010119900307851X"), `证件 ${REDACTED_PII}`);
    assert.equal(scrubPii("证件 11010119900307851x"), `证件 ${REDACTED_PII}`);
  });

  it("出生日期段非法的 18 位长数字仍被 fail-closed 替换（绝不放行明文）", () => {
    assert.equal(scrubPii("编码 110101199013328515"), `编码 ${REDACTED_PII}`);
  });

  it("17 位或 19 位数字不满足身份证格式 → 按银行卡口径处理（fail-closed）", () => {
    // 19 位长数字 ≥13 → 走银行卡 fail-closed 替换，绝不明文放行
    assert.equal(scrubPii("长串 1101011990030785151"), `长串 ${REDACTED_PII}`);
  });
});

describe("③ 银行卡号脱敏", () => {
  it("空格分组的 16 位卡号被替换", () => {
    assert.equal(scrubPii("卡号 6222 0212 3456 7890"), `卡号 ${REDACTED_PII}`);
  });

  it("连字符分组的 16 位卡号被替换", () => {
    assert.equal(scrubPii("卡号 6222-0212-3456-7890"), `卡号 ${REDACTED_PII}`);
  });

  it("连续 13~19 位卡号被替换（fail-closed）", () => {
    assert.equal(scrubPii("卡号 6222021234567890"), `卡号 ${REDACTED_PII}`);
    assert.equal(scrubPii("卡号 6222021234567890123"), `卡号 ${REDACTED_PII}`);
  });

  it("12 位及以下的分组数字不误杀", () => {
    assert.equal(scrubPii("批次 622202123456"), "批次 622202123456");
  });
});

describe("④ 高频业务编号绝不误杀（反例）", () => {
  it("工单号 / 客户号 / 审批单号 / 发票号原样保留", () => {
    const sample =
      "工单 TCK-3117、客户 CUST-8842、审批单 AP-20261125-001、发票 INV-2026-0901";
    assert.equal(scrubPii(sample), sample);
  });

  it("日期、金额、超期天数原样保留", () => {
    const sample = "2026-11-26 到期，金额 ¥52,800，超期 6 天，批次 DE-204 共 38 箱";
    assert.equal(scrubPii(sample), sample);
  });

  it("已脱敏格式的银行账号（星号掩码）不再二次破坏", () => {
    assert.equal(scrubPii("尾号 6222 **** **** 1234"), "尾号 6222 **** **** 1234");
  });
});

describe("⑤ 混合场景与统计", () => {
  it("一条文本同时命中三类 PII，全部替换且统计正确", () => {
    const r = scrubPiiDetailed(
      "客户 13812345678 反馈：证件 110101199003078515，扣款卡 6222 0212 3456 7890 被重复扣款",
    );
    assert.ok(!r.text.includes("13812345678"));
    assert.ok(!r.text.includes("110101199003078515"));
    assert.ok(!r.text.includes("6222"));
    assert.equal(r.text.split(REDACTED_PII).length - 1, 3);
    assert.equal(r.stats.phone, 1);
    assert.equal(r.stats.idCard, 1);
    assert.equal(r.stats.bankCard, 1);
    assert.equal(r.stats.total, 3);
  });

  it("无 PII 文本统计为零", () => {
    const r = scrubPiiDetailed("工单 TCK-3117 处理中");
    assert.deepEqual(r.stats, emptyPiiStats());
  });

  it("scrubPiiDeep：递归脱敏对象 / 数组里的字符串，非字符串值原样保留", () => {
    const out = scrubPiiDeep({
      question: "本人手机 13812345678",
      meta: { tags: ["财务", "卡号 6222021234567890"], count: 2, ok: true, nil: null },
    }) as { question: string; meta: { tags: string[]; count: number; ok: boolean; nil: null } };
    assert.equal(out.question, `本人手机 ${REDACTED_PII}`);
    assert.equal(out.meta.tags[0], "财务");
    assert.equal(out.meta.tags[1], `卡号 ${REDACTED_PII}`);
    assert.equal(out.meta.count, 2);
    assert.equal(out.meta.ok, true);
    assert.equal(out.meta.nil, null);
  });
});

describe("⑥ 启动自检", () => {
  it("assertScrubberHealthy：核心正反用例全部通过不抛错", () => {
    assert.doesNotThrow(() => assertScrubberHealthy());
  });
});
