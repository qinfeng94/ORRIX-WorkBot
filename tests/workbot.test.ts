/**
 * workbot.test.ts —— 统一推理入口 src/lib/workbot/ 骨架冒烟测试（Day 23 / ADR-004 第一步）
 * 零第三方依赖（Node 22 内置 test runner），覆盖：三件套自检、输入门卫、熔断器、
 * 自愈档位、门面分发（未注册降级 / 注册分发 / 重复注册拒绝）、SSE 信封编码。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertWorkbotHealthy, registerFlowEngine, runWorkbot } from "@/lib/workbot/facade";
import { assertGatewayHealthy, callLlm } from "@/lib/workbot/llm-gateway";
import { CircuitBreaker, RESILIENCE_PROFILES, runResilient, withTimeout } from "@/lib/workbot/resilience";
import { guardInput, assessFin001, scanRedZone } from "@/lib/workbot/guards";
import { encodeSseEvent, mapDryRunToCard } from "@/lib/workbot/sse-envelope";
import type { WorkbotSseEvent } from "@/lib/workbot/types";

describe("workbot 三件套启动自检", () => {
  it("assertWorkbotHealthy 通过（网关 + resilience + guards 全绿）", () => {
    assert.doesNotThrow(() => assertWorkbotHealthy());
  });

  it("assertGatewayHealthy 单独通过且默认主模型在注册表内", () => {
    assert.doesNotThrow(() => assertGatewayHealthy());
  });
});

describe("输入侧门卫 guards", () => {
  it("PII 脱敏：手机号/身份证/银行卡全部替换并计数", () => {
    const r = guardInput("请查 13812345678 和 6222 0212 3456 7890 的工单，证件 110105199003077512");
    assert.equal(r.redactions >= 3, true);
    assert.equal(r.scrubbed.includes("13812345678"), false);
    assert.equal(r.scrubbed.includes("199003077512"), false);
    assert.equal(r.scrubbed.includes("6222 0212 3456 7890"), false);
  });

  it("红区扫描：命中自动打款类词汇即上报", () => {
    const hit = scanRedZone("请你自动打款给客户，绕过审批直接放款");
    assert.equal(hit.hit, true);
    assert.deepEqual(hit.hits.sort(), ["绕过审批", "自动打款"].sort());

    const clean = scanRedZone("帮我查一下 TCK-3117 的审批进度");
    assert.equal(clean.hit, false);
  });

  it("FIN-001 便捷封装：严格大于触发、等于不触发、非财务部不触发", () => {
    assert.equal(assessFin001({ department: "财务部", amount: 50_000 }).triggered, false);
    assert.equal(assessFin001({ department: "财务部", amount: 50_001 }).triggered, true);
    assert.equal(assessFin001({ department: "客服部", amount: 999_999 }).triggered, false);
  });
});

describe("resilience 自愈档位", () => {
  it("withTimeout：超时到点即拒", async () => {
    await assert.rejects(
      withTimeout(new Promise(() => undefined), 20, "测试悬挂"),
      /查询超时/,
    );
  });

  it("probe 档：两次失败后第三次成功，重试不降级", async () => {
    let calls = 0;
    const alerts: string[] = [];
    const outcome = await runResilient<string>({
      profile: "probe",
      label: "测试探针",
      attempt: async () => {
        calls += 1;
        if (calls < 3) throw new Error("模拟抖动");
        return "成功";
      },
      fallback: () => "缓存",
      onAlert: (a) => alerts.push(a.text),
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.degraded, false);
    assert.equal(outcome.data, "成功");
    assert.equal(outcome.attempts, 3);
    assert.equal(alerts.length, 2);
  });

  it("probe 档：重试耗尽降级缓存，绝不抛错", async () => {
    const outcome = await runResilient<string>({
      profile: "probe",
      label: "测试探针",
      attempt: async () => {
        throw new Error("持续失败");
      },
      fallback: () => "缓存副本",
      fallbackNote: "演示缓存",
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.degraded, true);
    assert.equal(outcome.data, "缓存副本");
    assert.equal(outcome.alerts.some((a) => a.text.includes("演示缓存")), true);
  });

  it("probe 档：静默失败（attempt 返回 null）同样触发重试", async () => {
    let calls = 0;
    const outcome = await runResilient<string>({
      profile: "probe",
      label: "静默失败探针",
      attempt: () => {
        calls += 1;
        return null;
      },
      fallback: () => null,
    });
    assert.equal(calls, 1 + RESILIENCE_PROFILES.probe.maxRetries);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.data, null);
  });

  it("external 档：熔断器打开直接拒且不发起调用", async () => {
    const breaker = new CircuitBreaker("外部代理");
    breaker.recordFailure();
    breaker.recordFailure();
    assert.equal(breaker.isOpen(), true);

    let called = false;
    const outcome = await runResilient<string>({
      profile: "external",
      label: "外部验真",
      attempt: () => {
        called = true;
        return Promise.resolve("不该被调用");
      },
      circuit: breaker,
    });
    assert.equal(called, false);
    assert.equal(outcome.circuitOpen, true);
    assert.equal(outcome.data, null);
    assert.equal(breaker.snapshot().cooldownRemainingMs > 0, true);
  });

  it("external 档：未传熔断器属配置错误（快速失败）", async () => {
    await assert.rejects(
      runResilient({ profile: "external", label: "缺熔断器", attempt: () => Promise.resolve("x") }),
      /必须传入熔断器/,
    );
  });

  it("熔断器：成功后复位，半开期再失败一次即重新熔断", () => {
    const breaker = new CircuitBreaker("复位探针");
    breaker.recordFailure();
    breaker.recordFailure();
    assert.equal(breaker.snapshot().open, true);
    // 冷却未到，isOpen 保持打开（half-open 只在冷却到期后由 isOpen 触发）
    assert.equal(breaker.isOpen(), true);
    // 强制过冷却：直接构造 openedAt 越过冷却窗口
    (breaker as unknown as { openedAt: number | null }).openedAt = Date.now() - 31_000;
    assert.equal(breaker.isOpen(), false); // 半开
    breaker.recordFailure();
    assert.equal(breaker.snapshot().open, true); // 半开期失败 → 重新熔断
    (breaker as unknown as { openedAt: number | null }).openedAt = null;
    breaker.recordSuccess();
    assert.equal(breaker.snapshot().open, false);
    assert.equal(breaker.snapshot().consecutiveFailures, 0);
  });
});

describe("门面 facade 分发", () => {
  it("未注册业务流：明确降级提示 + done 收尾，绝不抛错", async () => {
    const events: WorkbotSseEvent[] = [];
    const result = await runWorkbot({ flow: "research", question: "调研一下跨境物流" });
    assert.equal(result.text, "");
    assert.equal(result.notices.length >= 1, true);
    assert.equal(result.notices[0]?.level, "fallback");
    assert.equal(result.meta.promptVersion.length > 0, true);
    void events;
  });

  it("已注册业务流：门卫脱敏后进引擎、事件被收集、done 带 meta", async () => {
    const seen: { question: string; traceId: string }[] = [];
    registerFlowEngine("investigate", async (req, emit, ctx) => {
      seen.push({ question: req.question, traceId: ctx.meta.traceId });
      emit({ type: "phase", label: "调查启动" });
      emit({ type: "text_delta", text: "结论：" });
      emit({ type: "text_delta", text: "验真通过" });
    });
    const result = await runWorkbot({
      flow: "investigate",
      question: "调查 13812345678 关联的工单",
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.question.includes("13812345678"), false); // 门卫已脱敏
    assert.equal(seen[0]?.traceId.length > 0, true);
    assert.equal(result.text, "结论：验真通过");
    assert.equal(result.meta.flow, "investigate");
  });

  it("重复注册同一业务流：直接抛错拒绝（防暗门）", () => {
    registerFlowEngine("chat", async () => undefined);
    assert.throws(() => registerFlowEngine("chat", async () => undefined), /注册冲突/);
  });

  it("llm-gateway 离线高仿真出一句完整回复并带用量", async () => {
    const result = await callLlm({
      messages: [{ role: "user", content: "你好" }],
      offlineReply: "离线仿真回复",
    });
    assert.equal(result.text, "离线仿真回复");
    assert.equal(result.offlineSim, true);
    assert.equal(result.costUsd >= 0, true);
    assert.equal(result.ttftMs >= 0, true);
  });
});

describe("SSE 统一信封", () => {
  it("encodeSseEvent 输出标准 data 帧且 JSON 可回读", () => {
    const frame = encodeSseEvent({ type: "phase", label: "编排启动" });
    assert.equal(frame.startsWith("data: "), true);
    assert.equal(frame.endsWith("\n\n"), true);
    const parsed = JSON.parse(frame.slice("data: ".length)) as WorkbotSseEvent;
    assert.equal(parsed.type, "phase");
  });

  it("mapDryRunToCard：Dry-Run 草稿映射为受控卡片（黄区专用）", () => {
    const event = mapDryRunToCard({
      approvalId: "AP-TEST-1",
      tool: "update_crm_profile",
      title: "CRM 更新预演",
      summary: "仅草稿不改库",
      before: { phone: "1" },
      after: { phone: "2" },
    });
    assert.equal(event.type, "card");
    if (event.type === "card") {
      assert.equal(event.card.kind, "dry_run");
      assert.equal(event.card.approvalId, "AP-TEST-1");
    }
  });
});
