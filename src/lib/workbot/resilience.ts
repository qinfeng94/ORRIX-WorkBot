/**
 * workbot/resilience.ts —— 全项目唯一超时/重试/熔断策略（ADR-004 §四）
 * 三档统一档位（取代散装的 resilientFetch / A2A 熔断器 / llm-client 各自实现）：
 *  - probe    ：内网只读探针，400ms 超时、最多重试 2 次、重试耗尽降级缓存（继承 Day 15 尽调口径）；
 *  - external ：外部服务（如跨组织 A2A 验真），2500ms 超时 + 连续失败 2 次开熔断冷却 30s
 *               （继承 Day 17 A2A 口径：假单/查无此单/超时/熔断一律转人工，绝不硬凑放行）；
 *  - llm      ：主备秒切，由 llm-gateway 内部委托 llm-client 承担，本文件不重复实现。
 * 设计纪律：runResilient 绝不抛错中断编排——宁可降级/转人工，绝不硬凑（继承既有引擎的容错原则）。
 */

/* ================================================================
 * 一、统一档位常量（数值与既有引擎一致，收口不改变行为）
 * ================================================================ */

export interface ResilienceProfile {
  /** 单次尝试超时（毫秒） */
  timeoutMs: number;
  /** 超时/失败后的最大重试次数（总尝试 = 1 + maxRetries） */
  maxRetries: number;
  /** 是否配套熔断器 */
  circuit: boolean;
}

export const RESILIENCE_PROFILES: Readonly<Record<"probe" | "external", ResilienceProfile>> = {
  probe: { timeoutMs: 400, maxRetries: 2, circuit: false },
  external: { timeoutMs: 2500, maxRetries: 0, circuit: true },
} as const;

/** 熔断器统一参数（继承 A2A 口径：连续失败 ≥2 次打开，冷却 30 秒） */
export const CIRCUIT_FAILURE_THRESHOLD = 2;
export const CIRCUIT_COOLDOWN_MS = 30_000;

/* ================================================================
 * 二、超时护栏
 * ================================================================ */

/** 给单个尝试套超时护栏：到点即拒，底层悬挂 promise 不占事件循环 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`查询超时（>${String(ms)}ms）：${label}`)), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/* ================================================================
 * 三、熔断器（继承 A2A 熔断器语义：连续失败计数，冷却到期自动半开）
 * ================================================================ */

export interface CircuitState {
  open: boolean;
  consecutiveFailures: number;
  openedAt: number | null;
  /** 熔断器打开期间剩余冷却毫秒数（0 = 已半开可尝试） */
  cooldownRemainingMs: number;
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  private readonly label: string;
  private readonly threshold: number;
  private readonly cooldownMs: number;

  constructor(
    label: string,
    threshold: number = CIRCUIT_FAILURE_THRESHOLD,
    cooldownMs: number = CIRCUIT_COOLDOWN_MS,
  ) {
    this.label = label;
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
  }

  /** 熔断器打开且仍在冷却期内 → 直接拒，调用方按「转人工」降级 */
  isOpen(): boolean {
    if (this.openedAt === null) return false;
    if (Date.now() - this.openedAt >= this.cooldownMs) {
      // 冷却结束：半开，放行一次尝试（由 recordFailure/recordSuccess 决定走向）
      this.openedAt = null;
      this.failures = this.threshold - 1; // 半开期再失败一次即重新熔断
      return false;
    }
    return true;
  }

  /** 供观测/页面展示的只读快照 */
  snapshot(): CircuitState {
    const remaining =
      this.openedAt === null ? 0 : Math.max(0, this.cooldownMs - (Date.now() - this.openedAt));
    return {
      open: this.openedAt !== null,
      consecutiveFailures: this.failures,
      openedAt: this.openedAt,
      cooldownRemainingMs: remaining,
    };
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.openedAt = Date.now();
      console.warn(
        `[workbot/resilience] 熔断器打开：${this.label} 连续失败 ${String(this.failures)} 次，冷却 ${String(Math.round(this.cooldownMs / 1000))} 秒`,
      );
    }
  }
}

/* ================================================================
 * 四、通用自愈包装（绝不抛错版本）
 * ================================================================ */

export interface ResilientOutcome<T> {
  ok: boolean;
  /** 是否走了降级数据 */
  degraded: boolean;
  /** 熔断器打开导致的直接拒（external 档专用语义：一律转人工） */
  circuitOpen: boolean;
  data: T | null;
  attempts: number;
  /** 过程中的告警文案（含每次失败原因与降级说明） */
  alerts: { level: "warn" | "error"; text: string }[];
}

export interface ResilientOptions<T> {
  profile: "probe" | "external";
  label: string;
  /** 第 n 次尝试（1 起）。返回 null 视为「静默失败」，走重试；external 档只尝试一次 */
  attempt: (n: number) => Promise<T> | null;
  /** 全部重试耗尽后的降级数据（null = 无缓存可用 → data 为 null 但不抛错） */
  fallback?: () => T | null;
  fallbackNote?: string;
  /** external 档必传：配套熔断器 */
  circuit?: CircuitBreaker;
  /** 每条告警回调（引擎可转发成 SSE notice 事件） */
  onAlert?: (alert: { level: "warn" | "error"; text: string }) => void;
}

/**
 * 通用自愈容错：每次尝试独立超时；probe 档失败重试最多 maxRetries 次、耗尽后降级缓存；
 * external 档先看熔断器（开 → circuitOpen=true 直接转人工），单次超时/失败即记熔断。
 * 任何路径都不抛错——编排层拿 outcome 自行决定后续，符合「宁可降级绝不硬凑」。
 */
export async function runResilient<T>(opts: ResilientOptions<T>): Promise<ResilientOutcome<T>> {
  const profile = RESILIENCE_PROFILES[opts.profile];
  const alerts: ResilientOutcome<T>["alerts"] = [];
  const recordAlert = (level: "warn" | "error", text: string): void => {
    alerts.push({ level, text });
    opts.onAlert?.({ level, text });
  };

  // external 档：熔断器打开直接拒，绝不发起网络调用
  if (profile.circuit) {
    const breaker = opts.circuit;
    if (breaker === undefined) {
      throw new Error(`runResilient 配置错误：external 档（${opts.label}）必须传入熔断器`);
    }
    if (breaker.isOpen()) {
      const remaining = breaker.snapshot().cooldownRemainingMs;
      const text = `${opts.label}：外部验真熔断器打开（冷却剩余 ${String(Math.round(remaining / 1000))} 秒），按红线一律转人工`;
      recordAlert("warn", text);
      return { ok: false, degraded: true, circuitOpen: true, data: null, attempts: 0, alerts };
    }
  }

  const totalAttempts = 1 + profile.maxRetries;
  for (let n = 1; n <= totalAttempts; n++) {
    const isLast = n === totalAttempts;
    try {
      const p = opts.attempt(n);
      if (p === null) throw new Error("数据源返回空载荷（静默失败）");
      const data = await withTimeout(Promise.resolve(p), profile.timeoutMs, opts.label);
      opts.circuit?.recordSuccess();
      return { ok: true, degraded: false, circuitOpen: false, data, attempts: n, alerts };
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      opts.circuit?.recordFailure();
      const action = profile.circuit
        ? "按红线转人工"
        : isLast
          ? "触发降级策略"
          : `自动重试（${String(n)}/${String(profile.maxRetries)}）`;
      recordAlert("error", `${opts.label}：${reason} → ${action}`);

      if (isLast) {
        const cached = opts.fallback?.() ?? null;
        if (cached !== null) {
          recordAlert(
            "warn",
            `${opts.label}：重试耗尽，已降级到本地缓存副本——${opts.fallbackNote ?? "派生快照，仅供参考"}`,
          );
          return { ok: false, degraded: true, circuitOpen: false, data: cached, attempts: n, alerts };
        }
        recordAlert("error", `${opts.label}：降级缓存也不可用，该数据源按「无数据」继续编排`);
        return { ok: false, degraded: true, circuitOpen: false, data: null, attempts: n, alerts };
      }
    }
  }
  // 防御性兜底（循环必有一路 return，理论不可达；禁 any 约束下显式收口）
  return { ok: false, degraded: true, circuitOpen: false, data: null, attempts: totalAttempts, alerts };
}

/* ================================================================
 * 五、启动自检
 * ================================================================ */

/** 档位/熔断器健康自检：数值漂移（如 400ms 被误改）在模块加载阶段即暴露 */
export function assertResilienceHealthy(): void {
  const { probe, external } = RESILIENCE_PROFILES;
  if (probe.timeoutMs !== 400 || probe.maxRetries !== 2) {
    throw new Error("WorkBot resilience 自检失败：probe 档参数漂移（应为 400ms / 重试 2 次）");
  }
  if (external.timeoutMs !== 2500 || !external.circuit) {
    throw new Error("WorkBot resilience 自检失败：external 档参数漂移（应为 2500ms + 熔断器）");
  }
  const breaker = new CircuitBreaker("自检探针");
  breaker.recordFailure();
  breaker.recordFailure();
  if (!breaker.snapshot().open) {
    throw new Error("WorkBot resilience 自检失败：熔断器连续 2 次失败未打开");
  }
  breaker.recordSuccess();
  if (breaker.snapshot().open) {
    throw new Error("WorkBot resilience 自检失败：熔断器成功后未复位");
  }
}
