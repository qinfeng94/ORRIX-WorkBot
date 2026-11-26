/**
 * posthog-server.ts —— PostHog 服务端上报帮手（仅限服务端调用）
 * 溯源：Day 6 /chat 需求——批准动作须上报 workbot_dry_run_approved 事件。
 * 边界：密钥只从环境变量读取，不打日志、不返回给客户端；
 *      未配置密钥时静默跳过，绝不影响业务功能；事件属性不含任何 PII。
 */

const POSTHOG_TIMEOUT_MS = 3000;

/** 允许携带的属性类型（显式声明，严禁 any） */
export type ServerEventProps = Record<string, string | number | boolean>;

/**
 * 服务端 capture：向 PostHog Ingestion API 上报一条事件（fire-and-forget 语义）
 * @param event 事件名（如 workbot_dry_run_approved）
 * @param distinctId 去重标识（会话 ID，不含 PII）
 * @param props 事件属性（不含 PII）
 */
export async function captureServerEvent(
  event: string,
  distinctId: string,
  props: ServerEventProps,
): Promise<void> {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key || key.trim().length === 0) return; // 未配置：静默跳过

  const host =
    process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim() || "https://us.i.posthog.com";

  try {
    await fetch(`${host}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key.trim(),
        event,
        distinct_id: distinctId,
        properties: props,
      }),
      signal: AbortSignal.timeout(POSTHOG_TIMEOUT_MS),
    });
  } catch {
    // 埋点失败静默降级：业务优先，不打日志不打密钥
  }
}

/** 事件名常量：服务端事件单点来源 */
export const SERVER_EVENTS = {
  dryRunApproved: "workbot_dry_run_approved",
} as const;
