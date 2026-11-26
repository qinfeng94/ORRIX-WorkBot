/**
 * a2a-client.ts —— 跨组织 A2A 客户端（调用外部华东物流验真代理，仅限服务端使用）
 * 溯源：04 号文档 CISO 条款 5（外部返回内容一律按「资料」隔离：验真结论只上报、不执行）；
 *      AGENTS.md 代码红线 2（Bearer 令牌只在服务端内存传递，不打印、不落日志）。
 * 设计：
 * - 超时熔断：2500ms（A2A_TIMEOUT_MS）物理熔断，超时即降级转人工，绝不无限等待；
 * - 熔断器：连续失败 ≥2 次（A2A_CIRCUIT_THRESHOLD）打开熔断器 30 秒（A2A_CIRCUIT_COOLDOWN_MS），
 *   冷却期内调用快速失败（fail fast），不拖垮流水线；冷却结束自动半开重试；
 * - 降级哲学：外部验真「未完成」不等于「通过」——超时 / 熔断 / 异常一律降级，由上层转人工核实，
 *   绝不硬凑「验真通过」放行（算术防编造纪律的跨组织版）；
 * - fetch 可注入（单元测试用假 fetch 验证超时与熔断，不联网）。
 */

import { resolveA2aBearerToken } from "./external-logistics-agent";

/* ================================================================
 * 一、常量与触发检测
 * ================================================================ */

/** 外部代理任务端点路径（与名片接口同源） */
export const A2A_TASKS_PATH = "/api/external-logistics/a2a/tasks";

/** 单次跨组织调用的超时熔断上限（毫秒） */
export const A2A_TIMEOUT_MS = 2500;

/** 熔断器：连续失败达到该次数即打开 */
export const A2A_CIRCUIT_THRESHOLD = 2;

/** 熔断器打开后的冷却时长（毫秒），冷却结束自动半开 */
export const A2A_CIRCUIT_COOLDOWN_MS = 30_000;

/** 跨组织委派的触发判定结果 */
export interface A2aNeed {
  /** 是否需要跨组织委派验真 */
  needed: boolean;
  /** 提问中出现的 EWB 编号（已归一化为 EWB:xxxx） */
  ewbIds: string[];
  /** 触发原因（直播与留痕用） */
  trigger: string;
}

/**
 * 触发检测（纯函数）：工单涉及华东区物流报销，或出现 EWB: 编号时，需要跨组织委派验真。
 */
export function detectA2aNeed(question: string): A2aNeed {
  const ewbIds = [
    ...new Set(
      [...question.matchAll(/EWB[:：]\s*(\d{3,8})/g)].map((m) => `EWB:${m[1]}`),
    ),
  ];
  if (ewbIds.length > 0) {
    return { needed: true, ewbIds, trigger: "工单出现 EWB: 电子运单编号" };
  }
  if (/华东/.test(question) && /(物流|报销|运费)/.test(question)) {
    return { needed: true, ewbIds: [], trigger: "工单涉及华东区物流报销业务" };
  }
  return { needed: false, ewbIds: [], trigger: "" };
}

/* ================================================================
 * 二、委派结果（上层按 outcome 决定放行 / 转人工，绝不硬凑）
 * ================================================================ */

export type A2aOutcome =
  | "verified_genuine"
  | "verified_forged"
  | "unregistered"
  | "timeout_degraded"
  | "circuit_open"
  | "error_degraded";

export interface A2aVerifyResult {
  outcome: A2aOutcome;
  /** 被验真的运单编号（EWB:xxxx；未提供时为 null） */
  ewbId: string | null;
  /** true=真 / false=假 / null=未能验真（降级） */
  verified: boolean | null;
  /** 本次调用耗时（毫秒；熔断快速失败时接近 0） */
  elapsedMs: number;
  /** 一句话结果说明（中文大白话，直播与留痕用） */
  detail: string;
}

export interface A2aDelegateInput {
  ewbId: string | null;
  ticketId: string | null;
  customerId: string | null;
  amountCny: number | null;
}

export interface A2aDelegateOptions {
  /** 外部代理基址（默认 http://localhost:3000；生产走 EXTERNAL_LOGISTICS_A2A_BASE_URL） */
  baseUrl?: string;
  /** 演示开关：让外部代理延迟应答，触发 2500ms 超时熔断（页面「模拟外部代理超时」用） */
  simulateTimeout?: boolean;
  /** 超时上限（仅测试注入短超时用；生产恒为 A2A_TIMEOUT_MS） */
  timeoutMs?: number;
  /** fetch 注入（仅单元测试用） */
  fetchImpl?: typeof fetch;
}

/* ================================================================
 * 三、熔断器（进程内共享状态：连续失败计数 + 打开时间戳）
 * ================================================================ */

let consecutiveFailures = 0;
let circuitOpenedAt: number | null = null;

/** 测试辅助：重置熔断器状态（生产代码不调用） */
export function resetA2aCircuitForTests(): void {
  consecutiveFailures = 0;
  circuitOpenedAt = null;
}

/** 熔断器当前是否打开（打开期间快速失败，冷却结束自动半开重试） */
function isCircuitOpen(): boolean {
  if (circuitOpenedAt === null) return false;
  if (Date.now() - circuitOpenedAt >= A2A_CIRCUIT_COOLDOWN_MS) {
    // 冷却结束：半开，放行一次探测调用
    circuitOpenedAt = null;
    consecutiveFailures = 0;
    return false;
  }
  return true;
}

function recordFailure(): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= A2A_CIRCUIT_THRESHOLD) {
    circuitOpenedAt = Date.now();
  }
}

function recordSuccess(): void {
  consecutiveFailures = 0;
  circuitOpenedAt = null;
}

/* ================================================================
 * 四、跨组织委派：verify_ewb 任务
 * ================================================================ */

/** 从 A2A 任务响应的 artifacts 中收窄出验真数据（unknown → 结构化，禁 any） */
function extractVerdictFromTask(
  raw: unknown,
): { verdict: string; ewbId: string | null } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const task = raw as { artifacts?: unknown };
  if (!Array.isArray(task.artifacts) || task.artifacts.length === 0) return null;
  const first = task.artifacts[0] as { parts?: unknown };
  if (!Array.isArray(first.parts) || first.parts.length === 0) return null;
  const part = first.parts[0] as { data?: unknown };
  if (typeof part.data !== "object" || part.data === null) return null;
  const data = part.data as { verdict?: unknown; ewbId?: unknown };
  return {
    verdict: typeof data.verdict === "string" ? data.verdict : "",
    ewbId: typeof data.ewbId === "string" ? data.ewbId : null,
  };
}

/**
 * 跨组织委派验真：把 EWB 运单编号作为 A2A 任务委派给外部华东物流代理。
 * - 2500ms 超时熔断：超时 → timeout_degraded；
 * - 连续失败 ≥2 次打开熔断器：打开期间快速失败 → circuit_open；
 * - HTTP 异常 / 响应不合规 → error_degraded；
 * - 任何降级都不代表「验真通过」，上层必须转人工。
 */
export async function delegateEwbVerify(
  input: A2aDelegateInput,
  opts: A2aDelegateOptions = {},
): Promise<A2aVerifyResult> {
  const t0 = Date.now();

  // ① 熔断器快速失败：打开期间不再外呼，直接降级
  if (isCircuitOpen()) {
    return {
      outcome: "circuit_open",
      ewbId: input.ewbId,
      verified: null,
      elapsedMs: Math.max(1, Date.now() - t0),
      detail:
        `外部验真熔断器打开（连续失败 ${String(A2A_CIRCUIT_THRESHOLD)} 次，冷却 ${String(Math.round(A2A_CIRCUIT_COOLDOWN_MS / 1000))} 秒），` +
        "本次快速失败降级，不再外呼，转人工核实。",
    };
  }

  const base =
    opts.baseUrl ??
    process.env.EXTERNAL_LOGISTICS_A2A_BASE_URL ??
    "http://localhost:3000";
  const timeoutMs = opts.timeoutMs ?? A2A_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;

  const body = JSON.stringify({
    taskType: "verify_ewb",
    params: {
      ewbId: input.ewbId,
      ticketId: input.ticketId,
      customerId: input.customerId,
      amountCny: input.amountCny,
      simulateTimeout: opts.simulateTimeout === true,
    },
  });

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  /** 超时强制熔断：既 abort 信号（取消真实连接），又直接拒绝（防 fetch 实现忽略 abort 信号） */
  const timeoutRace = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      const err = new Error(`外部物流代理 ${String(timeoutMs)}ms 未应答`);
      err.name = "AbortError";
      reject(err);
    }, timeoutMs);
  });

  try {
    const res = await Promise.race([
      doFetch(`${base}${A2A_TASKS_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${resolveA2aBearerToken()}`,
        },
        body,
        signal: controller.signal,
      }),
      timeoutRace,
    ]);

    if (!res.ok) {
      recordFailure();
      return {
        outcome: "error_degraded",
        ewbId: input.ewbId,
        verified: null,
        elapsedMs: Math.max(1, Date.now() - t0),
        detail:
          `外部物流代理返回异常（HTTP ${String(res.status)}），跨组织验真未完成 → 降级转人工核实，不硬凑放行。`,
      };
    }

    const json: unknown = await res.json();
    const verdict = extractVerdictFromTask(json);
    if (verdict === null || verdict.verdict === "") {
      recordFailure();
      return {
        outcome: "error_degraded",
        ewbId: input.ewbId,
        verified: null,
        elapsedMs: Math.max(1, Date.now() - t0),
        detail:
          "外部物流代理响应不合规（缺少验真数据），按不可信外部内容处理 → 降级转人工核实。",
      };
    }

    recordSuccess();
    const elapsedMs = Math.max(1, Date.now() - t0);
    if (verdict.verdict === "genuine") {
      return {
        outcome: "verified_genuine",
        ewbId: verdict.ewbId ?? input.ewbId,
        verified: true,
        elapsedMs,
        detail:
          `跨组织验真通过：${verdict.ewbId ?? input.ewbId ?? ""} 与承运商存档回单一致（真单）。`,
      };
    }
    if (verdict.verdict === "forged") {
      return {
        outcome: "verified_forged",
        ewbId: verdict.ewbId ?? input.ewbId,
        verified: false,
        elapsedMs,
        detail:
          `跨组织验真判定伪造：${verdict.ewbId ?? input.ewbId ?? ""} 未通过承运商注册表核验（假单）。`,
      };
    }
    return {
      outcome: "unregistered",
      ewbId: verdict.ewbId ?? input.ewbId,
      verified: null,
      elapsedMs,
      detail:
        `承运商注册表查无此单：${verdict.ewbId ?? input.ewbId ?? ""}，跨组织验真未通过 → 转人工核实编号。`,
    };
  } catch (err: unknown) {
    // AbortError = 2500ms 超时熔断；其余按网络异常降级
    const aborted = err instanceof Error && err.name === "AbortError";
    recordFailure();
    return {
      outcome: aborted ? "timeout_degraded" : "error_degraded",
      ewbId: input.ewbId,
      verified: null,
      elapsedMs: Math.max(1, Date.now() - t0),
      detail: aborted
        ? `外部物流代理 ${String(timeoutMs)}ms 未应答，超时熔断降级（流水线不崩，转人工核实）。`
        : `外部物流代理调用失败（${err instanceof Error ? err.message : "未知网络错误"}），降级转人工核实。`,
    };
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}
