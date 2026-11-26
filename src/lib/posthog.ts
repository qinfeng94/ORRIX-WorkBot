/**
 * PostHog 转化漏斗埋点（客户端专用）
 * 溯源：Week 1 真实数据闭环——4 步漏斗：
 *   ① funnel_1_ticket_view        查看工单
 *   ② funnel_2_fin001_alert       触发 FIN-001 告警
 *   ③ funnel_3_approve_click      点击审批
 *   ④ funnel_4_db_write_success   落库成功
 * 边界：密钥只走 NEXT_PUBLIC_ 环境变量（AGENTS.md 代码红线 2）；
 *      未配置密钥时静默跳过，绝不影响业务功能；事件属性不含任何 PII。
 */

type PostHogClient = typeof import("posthog-js").default;

let client: PostHogClient | null = null;
let initPromise: Promise<void> | null = null;

/** 初始化（幂等）；仅在浏览器端且配置了 NEXT_PUBLIC_POSTHOG_KEY 时生效 */
export function initPostHog(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key || key.trim().length === 0) return;

    const mod = await import("posthog-js");
    const posthog = mod.default;
    posthog.init(key.trim(), {
      api_host:
        process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim() || "https://us.i.posthog.com",
      autocapture: false,
      capture_pageview: false,
      persistence: "localStorage+cookie",
    });
    client = posthog;
  })().catch(() => {
    // 埋点失败静默降级：业务优先，日志不打密钥不打 PII
    initPromise = null;
  });

  return initPromise;
}

/** 漏斗事件允许携带的属性类型（显式声明，严禁 any） */
export type FunnelProps = Record<string, string | number | boolean>;

/** 漏斗事件名常量：全站单点来源 */
export const FUNNEL_EVENTS = {
  ticketView: "funnel_1_ticket_view",
  fin001Alert: "funnel_2_fin001_alert",
  approveClick: "funnel_3_approve_click",
  dbWriteSuccess: "funnel_4_db_write_success",
} as const;

/** 上报漏斗事件（未初始化 / 异常时静默跳过） */
export function trackFunnel(event: string, props?: FunnelProps): void {
  if (typeof window === "undefined" || client === null) return;
  try {
    client.capture(event, props);
  } catch {
    // 静默降级
  }
}
