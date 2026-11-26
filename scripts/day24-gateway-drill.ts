/**
 * day24-gateway-drill.ts — Day 24 一键压测演习脚本（零第三方依赖）
 *
 * 演习主线：主厂商中途断网 → 网关连续 3 次失败自动熔断 60 秒（演习压缩为 2.5 秒）
 *           → 熔断期直走备用厂商 → 冷却结束半开探测恢复主厂商 → 延迟瀑布精确定位瓶颈层。
 *
 * 运行：pnpm day24:drill
 * 台账：data/day24/gateway_requests.jsonl（只增不改；不含提问原文，PII 防线见 unified-gateway.ts）
 * 红线：网关全程只读 + 起草，物理不存在任何打款 / 写业务数据动作。
 */

import {
  appendGatewayLog,
  getBreakerSnapshots,
  initGatewayState,
  renderWaterfall,
  runGateway,
  type GatewayResult,
} from "../src/lib/workbot/unified-gateway.ts";

/* ---------------- 演习话术（虚构演示数据） ---------------- */

const SIMPLE_Q = "帮我把「您的单子我们看过了」这句客服话术改得更客气一些";
const COMPLEX_Q = "请核对 CUST-8842 的 11 月发票快照：单笔 ¥52,800 疑似重复扣款，涉及 FIN-001 审批，该怎么处理？";

const SEP = "=".repeat(74);
const log = (s: string = "") => console.log(s);

/** 断言（护栏自检）：失败即标红退出，绝不硬凑 PASS */
function check(name: string, ok: boolean, detail: string): boolean {
  console.log(`  ${ok ? "[PASS]" : "[FAIL]"} ${name} —— ${detail}`);
  return ok;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 打印一次请求的关键结论行 */
function summarize(r: GatewayResult): void {
  log(`  实际服务：${r.providerUsed}/${r.model} · 档位=${r.tier} · 总耗时=${r.totalMs}ms · 花费=$${r.costUsd}`);
  for (const n of r.notices) log(`  ${n}`);
}

async function main(): Promise<void> {
  log(SEP);
  log(" Day 24 网关演习：主厂商中途断网 → 自动熔断热切备用 → 瀑布定位瓶颈层");
  log(SEP);
  log(" 红线提示：网关全程只读 + 起草，无任何打款 / 写业务数据动作（红区物理隔离）");
  log("");

  // 演习参数：冷却 60000ms 压缩为 10000ms（仅演习；生产以 config/model-routing.json 为准）
  // 注意：备用厂商流式回包约 4 秒，冷却必须大于它，才能让阶段 3 仍落在熔断窗口内
  const cfg = initGatewayState({ cooldownMsOverride: 10000 });
  log(` [配置] 熔断阈值=连续 ${cfg.circuitBreaker.failureThreshold} 次失败 · 冷却=${cfg.circuitBreaker.cooldownMs / 1000}秒（演习压缩为 10 秒）`);
  log(` [路由] 简单分类档 → ${cfg.routing.fast.primary}(主)/${cfg.routing.fast.backup}(备) · 复杂财务推理档 → ${cfg.routing.flagship.primary}(主)/${cfg.routing.flagship.backup}(备)`);
  log(` [分类口径] 金额严格超过 ¥${cfg.classifier.amountThreshold.toLocaleString("en-US")} 才升旗舰档（等于不触发，FIN-001 口径）`);
  log("");

  const allResults: GatewayResult[] = [];
  const run = async (
    label: string,
    query: string,
    role: "support_agent" | "finance_lead" | "executive",
    drill?: { provider: "claude" | "openai"; mode: "connect-refuse" | "midstream-drop"; afterTokens?: number },
  ): Promise<GatewayResult> => {
    log(`── ${label} ──`);
    const r = await runGateway({ query, role, drill });
    log(renderWaterfall(r));
    summarize(r);
    await appendGatewayLog({
      ts: r.ts,
      event: "gateway_request",
      requestId: r.requestId,
      role: r.role,
      tier: r.tier,
      tierReason: r.tierReason,
      providerUsed: r.providerUsed,
      model: r.model,
      wasFallback: r.wasFallback,
      primarySkippedByBreaker: r.primarySkippedByBreaker,
      breakerEvents: r.breakerEvents,
      failedAttempts: r.failedAttempts,
      layers: r.layers,
      usage: r.usage,
      costUsd: r.costUsd,
      totalMs: r.totalMs,
      cacheHit: r.layers.cacheHit,
      queryChars: r.queryChars,
      queryHash: r.queryHash,
      drill: drill ? { provider: drill.provider, mode: drill.mode } : null,
    });
    allResults.push(r);
    log("");
    return r;
  };

  /* ---------- 阶段 1：基线两连发（主厂商健康） ---------- */
  log(SEP);
  log(" 阶段 1 · 基线对照：简单分类走快模型，复杂财务推理走旗舰模型");
  log(SEP);
  const r1 = await run("基线 A · 简单分类档", SIMPLE_Q, "support_agent");
  const r2 = await run("基线 B · 复杂财务推理档（¥52,800 超 FIN-001 红线）", COMPLEX_Q, "finance_lead");

  /* ---------- 阶段 2：主厂商中途断网 ×3 → 第 3 次熔断开启 ---------- */
  log(SEP);
  log(" 阶段 2 · 故障注入：旗舰主厂商（claude）逐字吐出 12 字后中途断网，连续 3 次");
  log(SEP);
  const faultResults: GatewayResult[] = [];
  for (let i = 1; i <= 3; i++) {
    const r = await run(
      `断网演习 #${i}（第 ${i}/3 次失败）`,
      `${COMPLEX_Q}【断网演习#${i}】`,
      "finance_lead",
      { provider: "claude", mode: "midstream-drop", afterTokens: 12 },
    );
    faultResults.push(r);
  }

  /* ---------- 阶段 3：熔断期内直走备用（零探测浪费） ---------- */
  log(SEP);
  log(" 阶段 3 · 熔断期：主厂商被断路器挡住，同请求直接由备用厂商承接");
  log(SEP);
  const r3 = await run("熔断期请求（不再探测主厂商）", `${COMPLEX_Q}【熔断期直走】`, "finance_lead");

  /* ---------- 阶段 4：冷却结束 → 半开探测 → 恢复主厂商 ---------- */
  log(" 等待冷却结束（10 秒）……");
  await sleep(10100);
  log(SEP);
  log(" 阶段 4 · 半开恢复：放行一次探测请求，成功则闭合熔断器");
  log(SEP);
  const r4 = await run("半开探测请求", `${COMPLEX_Q}【半开恢复】`, "finance_lead");

  /* ---------- 阶段 5：缓存命中对照 ---------- */
  log(SEP);
  log(" 阶段 5 · 缓存命中：同一问题第二次提问，全链路近跳过");
  log(SEP);
  const r5a = await run("缓存基线（首次提问）", `${SIMPLE_Q}【缓存对照】`, "support_agent");
  const r5b = await run("缓存命中（同问题立即再问）", `${SIMPLE_Q}【缓存对照】`, "support_agent");

  /* ---------- 护栏自检 ---------- */
  log(SEP);
  log(" 护栏自检（任何一项 FAIL 即演习失败，退出码 1）");
  log(SEP);
  const snapshots = getBreakerSnapshots();
  let ok = true;

  // ① 熔断阈值：前两次只计数，第 3 次才 tripped_open
  const tripEvents = faultResults.map((r) => r.breakerEvents.find((e) => e.type === "tripped_open"));
  ok = check(
    "熔断阈值=3：第 1/2 次仅计数，第 3 次才开启",
    !tripEvents[0] && !tripEvents[1] && tripEvents[2] !== undefined,
    `三次请求 tripped_open 事件 = ${tripEvents.map((e) => (e ? "有" : "无")).join(" / ")}`,
  ) && ok;

  // ② 每次断网都精确落在 generation 层（瓶颈定位证据）
  ok = check(
    "故障层定位：3 次断网全部落在 generation（生成）层",
    faultResults.every((r) => r.failedAttempts.every((a) => a.reachedLayer === "generation")),
    faultResults.flatMap((r) => r.failedAttempts.map((a) => a.reachedLayer)).join(",") || "无",
  ) && ok;

  // ③ 熔断期零探测：阶段 3 跳过主厂商直走备用，且全部成功
  ok = check(
    "熔断期热切：阶段 3 跳过主厂商，由备用厂商承接成功",
    r3.primarySkippedByBreaker && r3.wasFallback && r3.failedAttempts.length === 0,
    `primarySkippedByBreaker=${r3.primarySkippedByBreaker} · 实际服务=${r3.providerUsed}`,
  ) && ok;

  // ④ 半开恢复：阶段 4 探测成功，主厂商复位，两厂熔断器全绿
  ok = check(
    "半开恢复：探测成功后主厂商复位，两厂断路器均为 closed",
    r4.providerUsed === "claude" && snapshots.every((s) => s.state === "closed"),
    `阶段4实际服务=${r4.providerUsed} · 当前=${snapshots.map((s) => `${s.provider}:${s.state}`).join(" / ")}`,
  ) && ok;

  // ⑤ 缓存命中：L5/L6 归零，节省毫秒不少于缓存基线总耗时
  ok = check(
    "缓存命中：首字/生成为 0，节省 ≥ 缓存基线总耗时",
    r5b.layers.cacheHit && r5b.layers.ttftMs === 0 && r5b.layers.generationMs === 0 && r5b.layers.cacheSavedMs >= r5a.totalMs,
    `cacheSavedMs=${r5b.layers.cacheSavedMs}ms · 基线=${r5a.totalMs}ms · 本次=${r5b.totalMs}ms`,
  ) && ok;

  // ⑥ 全程零失败丢失：所有请求均有草稿文本（AI 只读 + 起草，绝不硬凑成功也绝不静默吞错）
  ok = check(
    "草稿兜底：全部请求均返回草稿文本，无静默失败",
    allResults.every((r) => r.text.length > 0),
    `${allResults.length} 次请求全部有草稿`,
  ) && ok;

  /* ---------- 瓶颈层结论 ---------- */
  const direct = allResults.filter((r) => !r.layers.cacheHit && r.failedAttempts.length === 0);
  const avg = (pick: (r: GatewayResult) => number): number =>
    Math.round(direct.reduce((sum, r) => sum + pick(r), 0) / Math.max(1, direct.length));
  log("");
  log(SEP);
  log(` 瓶颈层结论（按 ${direct.length} 次成功直连请求平均）：`);
  log(`   L1 网络连接 均值 ${avg((r) => r.layers.networkMs)}ms · L2 解析 ${avg((r) => r.layers.parseMs)}ms · L3 向量 ${avg((r) => r.layers.vectorMs)}ms`);
  log(`   L4 ACL ${avg((r) => r.layers.aclMs)}ms · L5 首字延迟 TTFT ${avg((r) => r.layers.ttftMs)}ms · L6 生成 ${avg((r) => r.layers.generationMs)}ms`);
  const layerAvgs: [string, number][] = [
    ["L1 网络连接", avg((r) => r.layers.networkMs)],
    ["L2 解析/分类", avg((r) => r.layers.parseMs)],
    ["L3 向量化", avg((r) => r.layers.vectorMs)],
    ["L4 ACL 检索", avg((r) => r.layers.aclMs)],
    ["L5 首字延迟", avg((r) => r.layers.ttftMs)],
    ["L6 生成", avg((r) => r.layers.generationMs)],
  ];
  const worst = layerAvgs.reduce((a, b) => (b[1] > a[1] ? b : a));
  log(`   ==> 瓶颈层：${worst[0]}（均值 ${worst[1]}ms）—— 降本增效优先压这一层`);
  log(` 台账：data/day24/gateway_requests.jsonl（只增不改，累计 ${allResults.length} 条，不含提问原文）`);
  log(SEP);

  if (!ok) {
    log(" 演习结论：存在 FAIL 项，禁止放行。");
    process.exit(1);
  }
  log(" 演习结论：6 项护栏自检全部 PASS，熔断热切与瓶颈定位链路可信。");
}

main().catch((err: unknown) => {
  console.error("[演习中断]", err instanceof Error ? err.message : err);
  process.exit(1);
});
