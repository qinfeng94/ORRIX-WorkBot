/**
 * a2a.test.ts —— 跨组织 A2A 验真链路的单元测试（Node 内置 test runner，零第三方依赖）
 * 覆盖：① EWB / 华东物流报销触发检测；② 外部代理注册表验真（真单 / 假单 / 查无此单）；
 *      ③ a2a-client 委派（验真通过 / 伪造 / 未登记 / 401 异常 / 超时熔断 / 熔断器快速失败）。
 * 边界：fetch 全部注入假实现，测试不联网；超时用 50ms 短超时注入（生产恒为 2500ms）；无 PII。
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  A2A_CIRCUIT_THRESHOLD,
  A2A_TASKS_PATH,
  A2A_TIMEOUT_MS,
  delegateEwbVerify,
  detectA2aNeed,
  resetA2aCircuitForTests,
} from "../src/lib/multiagent/a2a-client.ts";
import {
  buildAgentCard,
  DEMO_A2A_BEARER_TOKEN,
  normalizeEwbId,
  verifyEwb,
} from "../src/lib/multiagent/external-logistics-agent.ts";

/** 伪造一个 A2A 任务响应（与 /api/external-logistics/a2a/tasks 的响应结构一致） */
function fakeA2aTaskResponse(verdict: string, ewbId: string): Response {
  return new Response(
    JSON.stringify({
      taskId: "TASK-TEST-0001",
      taskType: "verify_ewb",
      status: "completed",
      artifacts: [
        {
          artifactId: "ART-1",
          name: "ewb_verification",
          parts: [{ kind: "data", data: { ewbId, verdict } }],
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** 构造注入用 fetch（可记录调用次数） */
function fakeFetch(responder: () => Response | Promise<Response>): {
  fn: typeof fetch;
  calls: () => number;
} {
  let count = 0;
  const fn = (async (): Promise<Response> => {
    count += 1;
    return responder();
  }) as typeof fetch;
  return { fn, calls: () => count };
}

/* ================================================================
 * ① 触发检测（华东区物流报销 / EWB: 编号）
 * ================================================================ */

describe("A2A 触发检测 detectA2aNeed", () => {
  it("出现 EWB: 编号即触发（半角 / 全角冒号都认）", () => {
    const r1 = detectA2aNeed("报销运单 EWB:99812 请验真");
    assert.equal(r1.needed, true);
    assert.deepEqual(r1.ewbIds, ["EWB:99812"]);
    const r2 = detectA2aNeed("报销运单 EWB：99812 请验真");
    assert.equal(r2.needed, true);
    assert.deepEqual(r2.ewbIds, ["EWB:99812"]);
  });

  it("华东区物流报销即触发（即使没有 EWB 编号）", () => {
    const r = detectA2aNeed("CUST-6602 华东区物流报销单待处理");
    assert.equal(r.needed, true);
    assert.deepEqual(r.ewbIds, []);
    assert.ok(r.trigger.includes("华东区物流报销"));
  });

  it("普通财务 / 客诉工单不误触发", () => {
    assert.equal(detectA2aNeed("处理 TCK-3117：CUST-8842 被重复扣款").needed, false);
    assert.equal(detectA2aNeed("重大客诉：物流时效投诉").needed, false);
    assert.equal(detectA2aNeed("美西仓海运超期").needed, false);
  });

  it("编号归一化：容忍空白与全角冒号，拒绝非法格式", () => {
    assert.equal(normalizeEwbId("EWB:99812"), "99812");
    assert.equal(normalizeEwbId("EWB： 99812"), "99812");
    assert.equal(normalizeEwbId("EWB:12"), null);
    assert.equal(normalizeEwbId("99812"), null);
  });
});

/* ================================================================
 * ② 外部代理注册表验真（EWB:99812 真 / EWB:00000 伪造 / 查无此单）
 * ================================================================ */

describe("外部代理注册表 verifyEwb", () => {
  it("EWB:99812 判定真单，返回承运商存档回单", () => {
    const r = verifyEwb("EWB:99812");
    assert.equal(r.verdict, "genuine");
    assert.ok(r.record);
    assert.ok(r.record.receiptNo.length > 0);
    assert.equal(r.ewbId, "EWB:99812");
  });

  it("EWB:00000 判定伪造", () => {
    const r = verifyEwb("EWB:00000");
    assert.equal(r.verdict, "forged");
  });

  it("未登记编号一律 unregistered（绝不编造结论）", () => {
    assert.equal(verifyEwb("EWB:12345").verdict, "unregistered");
    assert.equal(verifyEwb("随便填的").verdict, "unregistered");
  });

  it("A2A 名片：公开可发现，声明 verify_ewb 任务与 Bearer 鉴权", () => {
    const card = buildAgentCard("http://localhost:3000") as {
      url: string;
      capabilities: { tasks: string[] };
      securitySchemes: Record<string, { scheme: string }>;
    };
    assert.equal(card.url, "http://localhost:3000/api/external-logistics/a2a/tasks");
    assert.ok(card.capabilities.tasks.includes("verify_ewb"));
    assert.equal(card.securitySchemes.bearer.scheme, "bearer");
  });
});

/* ================================================================
 * ③ a2a-client 委派：验真 / 异常 / 超时熔断 / 熔断器
 * ================================================================ */

describe("a2a-client 委派 delegateEwbVerify", () => {
  beforeEach(() => {
    resetA2aCircuitForTests();
  });

  const input = {
    ewbId: "EWB:99812",
    ticketId: "TCK-L2088",
    customerId: "CUST-6602",
    amountCny: 6800,
  };

  it(`超时常量口径：${A2A_TIMEOUT_MS}ms，熔断阈值 ${A2A_CIRCUIT_THRESHOLD} 次`, () => {
    assert.equal(A2A_TIMEOUT_MS, 2500);
    assert.equal(A2A_CIRCUIT_THRESHOLD, 2);
  });

  it("请求塑形：携带 Bearer 令牌、verify_ewb 任务与 simulateTimeout 透传", async () => {
    const cap: { value: { url: string; init: RequestInit } | null } = { value: null };
    const fn = (async (url: unknown, init?: RequestInit) => {
      cap.value = { url: String(url), init: init ?? {} };
      return fakeA2aTaskResponse("genuine", "EWB:99812");
    }) as typeof fetch;
    const r = await delegateEwbVerify(input, {
      fetchImpl: fn,
      timeoutMs: 500,
      simulateTimeout: true,
    });
    assert.equal(r.outcome, "verified_genuine");
    assert.ok(cap.value, "注入 fetch 必须被调用一次");
    assert.equal(cap.value.init.method, "POST");
    assert.ok(String(cap.value.url).endsWith(A2A_TASKS_PATH));
    const headers = new Headers(cap.value.init.headers);
    assert.equal(headers.get("authorization"), `Bearer ${DEMO_A2A_BEARER_TOKEN}`);
    const body = JSON.parse(String(cap.value.init.body)) as {
      taskType: string;
      params: { ewbId: string; ticketId: string; simulateTimeout: boolean };
    };
    assert.equal(body.taskType, "verify_ewb");
    assert.equal(body.params.ewbId, "EWB:99812");
    assert.equal(body.params.ticketId, "TCK-L2088");
    assert.equal(body.params.simulateTimeout, true, "超时演习开关必须透传给外部代理");
  });

  it("真单：外部代理返回 genuine → verified_genuine，verified=true", async () => {
    const { fn } = fakeFetch(() => fakeA2aTaskResponse("genuine", "EWB:99812"));
    const r = await delegateEwbVerify(input, { fetchImpl: fn, timeoutMs: 500 });
    assert.equal(r.outcome, "verified_genuine");
    assert.equal(r.verified, true);
    assert.equal(r.ewbId, "EWB:99812");
    assert.ok(r.detail.includes("验真通过"));
  });

  it("假单：外部代理返回 forged → verified_forged，verified=false", async () => {
    const { fn } = fakeFetch(() => fakeA2aTaskResponse("forged", "EWB:00000"));
    const r = await delegateEwbVerify(
      { ...input, ewbId: "EWB:00000" },
      { fetchImpl: fn, timeoutMs: 500 },
    );
    assert.equal(r.outcome, "verified_forged");
    assert.equal(r.verified, false);
  });

  it("查无此单：unregistered → verified=null，绝不硬凑通过", async () => {
    const { fn } = fakeFetch(() => fakeA2aTaskResponse("unregistered", "EWB:12345"));
    const r = await delegateEwbVerify(
      { ...input, ewbId: "EWB:12345" },
      { fetchImpl: fn, timeoutMs: 500 },
    );
    assert.equal(r.outcome, "unregistered");
    assert.equal(r.verified, null);
  });

  it("HTTP 401（令牌无效）→ error_degraded 降级，不算验真通过", async () => {
    const { fn, calls } = fakeFetch(
      () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );
    const r = await delegateEwbVerify(input, { fetchImpl: fn, timeoutMs: 500 });
    assert.equal(r.outcome, "error_degraded");
    assert.equal(r.verified, null);
    assert.equal(calls(), 1);
  });

  it("超时熔断：外部代理迟迟不应答 → timeout_degraded（降级不崩）", async () => {
    const never = (async (): Promise<Response> =>
      new Promise<Response>(() => {})) as typeof fetch;
    const r = await delegateEwbVerify(input, { fetchImpl: never, timeoutMs: 50 });
    assert.equal(r.outcome, "timeout_degraded");
    assert.equal(r.verified, null);
    assert.ok(r.elapsedMs >= 50);
    assert.ok(r.detail.includes("超时"));
  });

  it(`连续失败 ${String(A2A_CIRCUIT_THRESHOLD)} 次后熔断器打开：快速失败、不再外呼`, async () => {
    const never = (async (): Promise<Response> =>
      new Promise<Response>(() => {})) as typeof fetch;
    // 第 1 次超时：失败 1 次，熔断器未开
    const r1 = await delegateEwbVerify(input, { fetchImpl: never, timeoutMs: 50 });
    assert.equal(r1.outcome, "timeout_degraded");
    // 第 2 次超时：失败 2 次，熔断器打开
    const r2 = await delegateEwbVerify(input, { fetchImpl: never, timeoutMs: 50 });
    assert.equal(r2.outcome, "timeout_degraded");
    // 第 3 次：快速失败，fetch 不再被调用
    const { fn, calls } = fakeFetch(() => fakeA2aTaskResponse("genuine", "EWB:99812"));
    const r3 = await delegateEwbVerify(input, { fetchImpl: fn, timeoutMs: 500 });
    assert.equal(r3.outcome, "circuit_open");
    assert.equal(r3.verified, null);
    assert.equal(calls(), 0, "熔断打开期间不应发起任何外部调用");
    assert.ok(r3.detail.includes("熔断器打开"));
  });

  it("验真成功会重置熔断器：成功后再失败需重新累计", async () => {
    resetA2aCircuitForTests();
    // 先制造 1 次失败（距打开阈值还差 1 次）
    const never = (async (): Promise<Response> =>
      new Promise<Response>(() => {})) as typeof fetch;
    await delegateEwbVerify(input, { fetchImpl: never, timeoutMs: 50 });
    // 验真成功：熔断计数清零
    const okFetch = fakeFetch(() => fakeA2aTaskResponse("genuine", "EWB:99812"));
    const ok = await delegateEwbVerify(input, {
      fetchImpl: okFetch.fn,
      timeoutMs: 500,
    });
    assert.equal(ok.outcome, "verified_genuine");
    // 再失败 1 次：只累计 1 次，不会立刻打开熔断器
    const r = await delegateEwbVerify(input, { fetchImpl: never, timeoutMs: 50 });
    assert.equal(r.outcome, "timeout_degraded");
  });
});
