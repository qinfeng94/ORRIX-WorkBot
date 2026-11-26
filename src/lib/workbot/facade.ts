/**
 * workbot/facade.ts —— 统一推理入口门面（ADR-004 §三 · Day 25 起为薄委托层）
 * Day 25 收官：Day 23 编排流水线与 Day 24 双供应商网关已合并为唯一生产核心
 * core-engine.ts，本文件只保留历史入口签名（runWorkbot / streamWorkbot /
 * registerFlowEngine / assertWorkbotHealthy）并全部委托核心实现。
 * 页面/路由仍只准 import 本门面，禁止绕过直调内室引擎或 core-engine 内部函数。
 * 溯源：BENCHMARK-ORCHESTRATION.md §5 收口决定；ADR-004 §五迁移路线。
 */
import {
  assertCoreEngineHealthy,
  registerFlowEngine,
  runCoreEngine,
  streamCoreEngine,
} from "@/lib/workbot/core-engine";
import type { WorkbotRequest, WorkbotResult } from "@/lib/workbot/types";

export { registerFlowEngine };

/** 非流式入口：委托唯一生产核心 */
export async function runWorkbot(req: WorkbotRequest): Promise<WorkbotResult> {
  return runCoreEngine(req);
}

/** 流式入口：统一信封 SSE Response（路由直接 return 它即可） */
export function streamWorkbot(req: WorkbotRequest): Response {
  return streamCoreEngine(req);
}

/** 启动自检：委托核心三件套（LLM 网关 + 韧性档位 + 门卫红线） */
export function assertWorkbotHealthy(): void {
  assertCoreEngineHealthy();
}
