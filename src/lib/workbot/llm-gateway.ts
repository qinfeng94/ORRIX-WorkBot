/**
 * workbot/llm-gateway.ts —— 全项目唯一 LLM 出口（ADR-004 §四）
 * 规则：
 *  - 页面/路由禁止直接 import "@/lib/llm/llm-client.mjs"，一律走本网关；
 *  - 网关只做委托 + 口径统一（默认主模型、费用/TTFT 原样透传），不改变 llm-client 行为；
 *  - 主备秒切、密钥内存传递、离线高仿真等能力全部继承 llm-client，本文件零重复实现。
 * 溯源：BENCHMARK-ORCHESTRATION.md §2「LLM 调用出口三处直连」收口决定。
 */
import {
  MODEL_REGISTRY,
  streamChat,
  type ProviderKey,
  type StreamChatOptions,
  type StreamResult,
} from "@/lib/llm/llm-client.mjs";

/** 网关默认主模型（与 lib/llm 注册表保持一致口径，一键切换就改这里） */
export const GATEWAY_DEFAULT_PRIMARY: ProviderKey = "claude";

/** 模型价格注册表只读转发（供确定性引擎做成本估算口径；调用一律走 callLlm，禁止绕过） */
export { MODEL_REGISTRY };

/** 网关入参：与 llm-client StreamChatOptions 相同，仅 primary 改为可选（缺省用网关默认） */
export type GatewayStreamOptions = Omit<StreamChatOptions, "primary"> & {
  primary?: ProviderKey;
};

/**
 * 全项目唯一 LLM 调用入口。
 * 计费落账：调用方（路由 after() / 引擎）负责把返回的用量写进 llm_usage_logs，
 * 网关不代写，保证「谁发起谁记账」的审计口径清晰。
 */
export async function callLlm(opts: GatewayStreamOptions): Promise<StreamResult> {
  return streamChat({
    ...opts,
    primary: opts.primary ?? GATEWAY_DEFAULT_PRIMARY,
  });
}

/**
 * 网关启动自检：llm-client 注册表不可读或 streamChat 不可调用时直接抛错，
 * 让问题在模块加载阶段暴露，而不是在第一笔对话里静默降级。
 */
export function assertGatewayHealthy(): void {
  const providers = Object.keys(MODEL_REGISTRY);
  if (providers.length === 0) {
    throw new Error("WorkBot LLM 网关自检失败：llm-client 模型注册表为空");
  }
  if (typeof streamChat !== "function") {
    throw new Error("WorkBot LLM 网关自检失败：streamChat 不可调用");
  }
  if (!(GATEWAY_DEFAULT_PRIMARY in MODEL_REGISTRY)) {
    throw new Error(
      `WorkBot LLM 网关自检失败：默认主模型「${GATEWAY_DEFAULT_PRIMARY}」不在注册表中（现有：${providers.join("、")}）`,
    );
  }
}
