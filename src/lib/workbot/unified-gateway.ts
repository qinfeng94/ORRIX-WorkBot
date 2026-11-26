/**
 * unified-gateway.ts — Day 24 双供应商动态路由统一网关（零第三方依赖）
 * 溯源：AGENTS.md + config/model-routing.json ——
 *   ① 动态路由：确定性分类器把请求分到「简单分类档（快模型）」或「复杂财务推理档（旗舰模型）」，
 *      金额判定口径与 FIN-001 一致：严格「超过」¥50,000 才升格，等于不触发；
 *   ② 熔断降级：按厂商独立计数，连续 3 次失败 → 熔断 60 秒 → 期间直走备用厂商（热切，不重试等待）；
 *      冷却结束后半开放行一次探测，成功闭合恢复、失败重新熔断一个周期；
 *   ③ 7 层耗时拆分：网络连接 / 解析分类 / 向量化 / ACL 检索 / 首字延迟 TTFT / 生成速率 / 缓存命中；
 *   ④ 审计：appendGatewayLog 只增不改 JSONL（不含提问原文，只留字数 + 哈希，杜绝 PII 落日志）；
 *   ⑤ 红区：本网关只有「只读 + 起草」能力，物理不存在任何打款 / 写业务数据的函数。
 *
 * 默认离线高仿真（无 Key 可跑，厂商流式行为按 config/providers.*.sim 档位模拟）；
 * 演习故障通过 GatewayRequest.drill 注入（connect-refuse 连接拒绝 / midstream-drop 中途断网）。
 */

import { appendFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FIN001_THRESHOLD_YUAN } from "@/lib/fin001";

/* ================= 一、类型定义 ================= */

export type ProviderKey = "claude" | "openai";
export type RoutingTier = "fast" | "flagship";
export type BreakerState = "closed" | "open" | "half-open";
export type AclRole = "support_agent" | "finance_lead" | "executive";
export type DrillMode = "connect-refuse" | "midstream-drop";
export type LayerName = "network" | "ttft" | "generation";

/** 演习故障注入：只作用于指定厂商，备用厂商永远健康 */
export interface DrillInjection {
  provider: ProviderKey;
  mode: DrillMode;
  /** midstream-drop：逐字吐出多少个字符后「断网」 */
  afterTokens?: number;
}

export interface GatewayRequest {
  query: string;
  /** 调用方角色（ACL 预过滤口径），缺省 executive */
  role?: AclRole;
  /** 覆盖自动分类的档位（演习用） */
  tierOverride?: RoutingTier;
  /** 逐字回调（首字到达即 TTFT 终点） */
  onToken?: (chunk: string) => void;
  drill?: DrillInjection;
  requestId?: string;
  /**
   * 离线仿真耗时缩放系数（仅评测门禁 / 单元测试用，生产不传 = 1）：
   * 缩小 connectMs/ttftMs/charMs/解析/向量/ACL 的仿真等待，让 25 题全量门禁可在秒级跑完；
   * 只缩放 sleep，不改路由 / 熔断 / 故障注入语义。
   */
  simSpeedFactor?: number;
}

/** 7 层耗时拆分（毫秒；tokensPerSec 单位为 Token/秒） */
export interface GatewayLayerTiming {
  networkMs: number;
  parseMs: number;
  vectorMs: number;
  aclMs: number;
  ttftMs: number;
  generationMs: number;
  tokensPerSec: number;
  cacheHit: boolean;
  /** 命中缓存时，相比此前同请求基线节省的毫秒数 */
  cacheSavedMs: number;
}

export interface BreakerEvent {
  provider: ProviderKey;
  type:
    | "failure_count" // 失败计数 +1（未达阈值）
    | "tripped_open" // 达到阈值，熔断开启
    | "rejected_while_open" // 熔断期内拒绝探测，直接走备用
    | "half_open_probe" // 冷却结束，半开放行一次探测
    | "recovered_closed"; // 半开探测成功，闭合恢复
  at: string;
  failures?: number;
  state?: BreakerState;
  cooldownRemainingMs?: number;
}

export interface FailedAttempt {
  provider: ProviderKey;
  model: string;
  faultKind: DrillMode | "provider-error";
  status: number;
  message: string;
  /** 故障暴露在哪一层（瓶颈定位的关键证据） */
  reachedLayer: LayerName;
  elapsedMs: number;
}

export interface GatewayResult {
  requestId: string;
  ts: string;
  role: AclRole;
  queryChars: number;
  /** 提问原文不落任何日志，只留 fnv1a 指纹便于对账 */
  queryHash: string;
  tier: RoutingTier;
  tierReason: string;
  providerChain: ProviderKey[];
  providerUsed: ProviderKey;
  model: string;
  wasFallback: boolean;
  fallbackReason: string | null;
  /** 熔断期内跳过主厂商直走备用（零探测浪费） */
  primarySkippedByBreaker: boolean;
  breakerEvents: BreakerEvent[];
  failedAttempts: FailedAttempt[];
  layers: GatewayLayerTiming;
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number;
  text: string;
  totalMs: number;
  offlineSim: true;
  notices: string[];
}

/* ================= 二、配置加载（fail-closed 校验） ================= */

interface SimProfile {
  connectMs: [number, number];
  ttftMs: [number, number];
  charMs: [number, number];
}

export interface ProviderProfile {
  providerId: string;
  label: string;
  flagshipModel: string;
  fastModel: string;
  priceInPerM: number;
  priceOutPerM: number;
  sim: SimProfile;
}

export interface TierRoute {
  label: string;
  usage: string;
  primary: ProviderKey;
  backup: ProviderKey;
  modelSlot: "fastModel" | "flagshipModel";
  effort: "low" | "medium" | "high";
}

export interface RoutingConfig {
  version: string;
  description: string;
  circuitBreaker: { failureThreshold: number; cooldownMs: number; halfOpenProbe: boolean };
  providers: Record<ProviderKey, ProviderProfile>;
  routing: Record<RoutingTier, TierRoute>;
  classifier: { amountThreshold: number; complexKeywords: string[] };
  cache: { enabled: boolean; maxEntries: number };
  layers: { key: string; label: string }[];
}

function assertObject(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`配置校验失败：${path} 应为对象`);
  }
  return v as Record<string, unknown>;
}

function assertString(v: unknown, path: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`配置校验失败：${path} 应为非空字符串`);
  }
  return v;
}

function assertNumber(v: unknown, path: string, min: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min) {
    throw new Error(`配置校验失败：${path} 应为不小于 ${min} 的数字`);
  }
  return v;
}

function assertProviderKey(v: unknown, path: string): ProviderKey {
  if (v !== "claude" && v !== "openai") {
    throw new Error(`配置校验失败：${path} 应为 claude / openai`);
  }
  return v;
}

function parseSimProfile(v: unknown, path: string): SimProfile {
  const o = assertObject(v, path);
  const range = (key: string): [number, number] => {
    const arr = o[key];
    if (!Array.isArray(arr) || arr.length !== 2 || typeof arr[0] !== "number" || typeof arr[1] !== "number" || arr[0] > arr[1]) {
      throw new Error(`配置校验失败：${path}.${key} 应为 [min, max] 且 min <= max`);
    }
    return [arr[0], arr[1]];
  };
  return { connectMs: range("connectMs"), ttftMs: range("ttftMs"), charMs: range("charMs") };
}

function parseProvider(v: unknown, path: string): ProviderProfile {
  const o = assertObject(v, path);
  return {
    providerId: assertString(o.providerId, `${path}.providerId`),
    label: assertString(o.label, `${path}.label`),
    flagshipModel: assertString(o.flagshipModel, `${path}.flagshipModel`),
    fastModel: assertString(o.fastModel, `${path}.fastModel`),
    priceInPerM: assertNumber(o.priceInPerM, `${path}.priceInPerM`, 0),
    priceOutPerM: assertNumber(o.priceOutPerM, `${path}.priceOutPerM`, 0),
    sim: parseSimProfile(o.sim, `${path}.sim`),
  };
}

function parseTierRoute(v: unknown, path: string): TierRoute {
  const o = assertObject(v, path);
  const slot = o.modelSlot;
  if (slot !== "fastModel" && slot !== "flagshipModel") {
    throw new Error(`配置校验失败：${path}.modelSlot 应为 fastModel / flagshipModel`);
  }
  const effort = o.effort;
  if (effort !== "low" && effort !== "medium" && effort !== "high") {
    throw new Error(`配置校验失败：${path}.effort 应为 low / medium / high`);
  }
  return {
    label: assertString(o.label, `${path}.label`),
    usage: assertString(o.usage, `${path}.usage`),
    primary: assertProviderKey(o.primary, `${path}.primary`),
    backup: assertProviderKey(o.backup, `${path}.backup`),
    modelSlot: slot,
    effort,
  };
}

/** 解析并校验路由配置；任何缺失/非法字段一律拒绝启动（fail-closed） */
export function parseRoutingConfig(raw: unknown): RoutingConfig {
  const root = assertObject(raw, "根节点");
  const cb = assertObject(root.circuitBreaker, "circuitBreaker");
  const providersRaw = assertObject(root.providers, "providers");
  const routingRaw = assertObject(root.routing, "routing");
  const classifier = assertObject(root.classifier, "classifier");
  const cacheRaw = assertObject(root.cache, "cache");
  if (!Array.isArray(root.layers) || root.layers.length === 0) {
    throw new Error("配置校验失败：layers 应为非空数组");
  }
  const kwRaw = classifier.complexKeywords;
  if (!Array.isArray(kwRaw) || kwRaw.some((k) => typeof k !== "string")) {
    throw new Error("配置校验失败：classifier.complexKeywords 应为字符串数组");
  }
  return {
    version: assertString(root.version, "version"),
    description: assertString(root.description, "description"),
    circuitBreaker: {
      failureThreshold: assertNumber(cb.failureThreshold, "circuitBreaker.failureThreshold", 1),
      cooldownMs: assertNumber(cb.cooldownMs, "circuitBreaker.cooldownMs", 1),
      halfOpenProbe: cb.halfOpenProbe === true,
    },
    providers: {
      claude: parseProvider(providersRaw.claude, "providers.claude"),
      openai: parseProvider(providersRaw.openai, "providers.openai"),
    },
    routing: {
      fast: parseTierRoute(routingRaw.fast, "routing.fast"),
      flagship: parseTierRoute(routingRaw.flagship, "routing.flagship"),
    },
    classifier: {
      amountThreshold: assertNumber(classifier.amountThreshold, "classifier.amountThreshold", 0),
      complexKeywords: kwRaw as string[],
    },
    cache: {
      enabled: cacheRaw.enabled === true,
      maxEntries: assertNumber(cacheRaw.maxEntries, "cache.maxEntries", 1),
    },
    layers: (root.layers as unknown[]).map((l, i) => {
      const o = assertObject(l, `layers[${i}]`);
      return { key: assertString(o.key, `layers[${i}].key`), label: assertString(o.label, `layers[${i}].label`) };
    }),
  };
}

let cachedConfig: RoutingConfig | null = null;

/** 从 config/model-routing.json 读取配置（cwd = 项目根） */
export function loadRoutingConfig(): RoutingConfig {
  if (cachedConfig) return cachedConfig;
  const raw = readFileSync(join(process.cwd(), "config", "model-routing.json"), "utf8");
  cachedConfig = parseRoutingConfig(JSON.parse(raw) as unknown);
  return cachedConfig;
}

/* ================= 三、熔断器（连续失败计数 → 断路 → 半开恢复） ================= */

interface BreakerEntry {
  state: BreakerState;
  failures: number;
  openUntilMs: number;
}

export interface BreakerSnapshot {
  provider: ProviderKey;
  state: BreakerState;
  consecutiveFailures: number;
  openUntilMs: number;
  remainingCooldownMs: number;
}

export class CircuitBreaker {
  private entries = new Map<ProviderKey, BreakerEntry>();
  private threshold: number;
  private cooldownMs: number;

  constructor(threshold: number, cooldownMs: number) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
  }

  get thresholdLimit(): number {
    return this.threshold;
  }

  get cooldownDurationMs(): number {
    return this.cooldownMs;
  }

  private ensure(provider: ProviderKey): BreakerEntry {
    let e = this.entries.get(provider);
    if (!e) {
      e = { state: "closed", failures: 0, openUntilMs: 0 };
      this.entries.set(provider, e);
    }
    return e;
  }

  /** 是否放行；open 且冷却结束则转入 half-open 并放行本次探测 */
  canPass(provider: ProviderKey, nowMs: number): { allowed: boolean; state: BreakerState; remainingMs: number } {
    const e = this.ensure(provider);
    if (e.state === "closed") return { allowed: true, state: "closed", remainingMs: 0 };
    if (e.state === "open") {
      if (nowMs >= e.openUntilMs) {
        e.state = "half-open"; // 半开：放行一次探测
        return { allowed: true, state: "half-open", remainingMs: 0 };
      }
      return { allowed: false, state: "open", remainingMs: e.openUntilMs - nowMs };
    }
    return { allowed: true, state: "half-open", remainingMs: 0 };
  }

  /** 记一次失败；达阈值或半开探测失败即熔断一个冷却周期 */
  recordFailure(provider: ProviderKey, nowMs: number): { failures: number; tripped: boolean; state: BreakerState } {
    const e = this.ensure(provider);
    if (e.state === "half-open") {
      // 半开探测失败：重新熔断一个完整周期
      e.state = "open";
      e.openUntilMs = nowMs + this.cooldownMs;
      return { failures: this.threshold, tripped: true, state: "open" };
    }
    if (e.state === "open") {
      e.openUntilMs = nowMs + this.cooldownMs;
      return { failures: e.failures, tripped: true, state: "open" };
    }
    e.failures += 1;
    if (e.failures >= this.threshold) {
      e.state = "open";
      e.openUntilMs = nowMs + this.cooldownMs;
      return { failures: e.failures, tripped: true, state: "open" };
    }
    return { failures: e.failures, tripped: false, state: "closed" };
  }

  /** 记一次成功：闭合并清零计数 */
  recordSuccess(provider: ProviderKey): void {
    this.entries.set(provider, { state: "closed", failures: 0, openUntilMs: 0 });
  }

  snapshots(nowMs: number): BreakerSnapshot[] {
    const keys: ProviderKey[] = ["claude", "openai"];
    return keys.map((k) => {
      const e = this.ensure(k);
      const remaining = e.state === "open" ? Math.max(0, e.openUntilMs - nowMs) : 0;
      return {
        provider: k,
        state: e.state,
        consecutiveFailures: e.failures,
        openUntilMs: e.openUntilMs,
        remainingCooldownMs: remaining,
      };
    });
  }
}

/* ================= 四、确定性分类器与缓存键 ================= */

/** 提取提问中的最大单笔金额（支持 ¥52,800 / 5.28万 两种写法），无金额返回 0 */
export function extractMaxAmount(query: string): number {
  let max = 0;
  for (const m of query.matchAll(/[¥￥]\s*([0-9][0-9,]*(?:\.[0-9]+)?)/g)) {
    const n = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > max) max = n;
  }
  for (const m of query.matchAll(/([0-9]+(?:\.[0-9]+)?)\s*万/g)) {
    const n = parseFloat(m[1]) * 10000;
    if (Number.isFinite(n) && n > max) max = n;
  }
  return Math.round(max);
}

/** 确定性档位分类：金额严格超红线 > 复杂关键词 > 默认快模型 */
export function classifyQuery(query: string, cfg: RoutingConfig): { tier: RoutingTier; reason: string } {
  const maxAmount = extractMaxAmount(query);
  if (maxAmount > cfg.classifier.amountThreshold) {
    return {
      tier: "flagship",
      reason: `检测到单笔金额 ¥${maxAmount.toLocaleString("en-US")}，严格超过红线 ¥${cfg.classifier.amountThreshold.toLocaleString("en-US")}（FIN-001 口径），升格旗舰推理档`,
    };
  }
  for (const kw of cfg.classifier.complexKeywords) {
    if (query.toUpperCase().includes(kw.toUpperCase())) {
      return { tier: "flagship", reason: `命中复杂财务关键词「${kw}」，走旗舰推理档` };
    }
  }
  return { tier: "fast", reason: "未命中金额红线与复杂财务特征，走快模型省成本" };
}

function cacheKey(role: AclRole, query: string): string {
  return `${role}::${query.trim().replace(/\s+/g, " ")}`;
}

function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 轻量分词（网关内部向量化用，不依赖 raglab，保持模块正交） */
function tokenize(query: string): string[] {
  return [...query.toLowerCase().matchAll(/[a-z0-9][a-z0-9\-_.]*/g)].map((m) => m[0]);
}

/** 64 维确定性哈希向量（真实执行，耗时随文本长度可测） */
function embed(tokens: string[]): number[] {
  const dim = 64;
  const vec = new Array<number>(dim).fill(0);
  for (const t of tokens) {
    let h = 0x811c9dc5;
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    vec[(h >>> 0) % dim] += 1;
  }
  return vec;
}

/* ================= 五、ACL 预过滤文档池（网关自带最小演示集） ================= */

interface AclDoc {
  docId: string;
  title: string;
  depts: AclRole[];
  abolished?: boolean;
}

const ACL_DOC_POOL: AclDoc[] = [
  { docId: "DOC-01", title: "差旅报销制度", depts: ["support_agent", "finance_lead", "executive"] },
  { docId: "DOC-02", title: "FIN-001 大额付款审批细则（现行）", depts: ["finance_lead", "executive"] },
  { docId: "DOC-03", title: "客户服务话术手册", depts: ["support_agent", "finance_lead", "executive"] },
  { docId: "DOC-04", title: "高管应收账款月报", depts: ["executive"] },
  { docId: "DOC-05", title: "已废止：2025 版 10 万审批制度（仅作对照，物理剔除出打分管线）", depts: ["finance_lead", "executive"], abolished: true },
  { docId: "DOC-06", title: "发票对账操作指引", depts: ["finance_lead", "executive"] },
];

/* ================= 六、离线高仿真厂商流（含演习故障注入） ================= */

export class GatewayFault extends Error {
  status: number;
  providerId: string;
  kind: DrillMode | "provider-error";
  reachedLayer: LayerName;
  partialChars: number;

  constructor(
    providerId: string,
    kind: DrillMode | "provider-error",
    status: number,
    reachedLayer: LayerName,
    message: string,
    partialChars = 0,
  ) {
    super(message);
    this.name = "GatewayFault";
    this.providerId = providerId;
    this.kind = kind;
    this.status = status;
    this.reachedLayer = reachedLayer;
    this.partialChars = partialChars;
  }
}

/** 可切换类故障：演习注入的断网一律可切；真实口径 429/503 可切 */
function isFallbackWorthy(err: unknown): boolean {
  if (!(err instanceof GatewayFault)) return false;
  return err.status === 429 || err.status === 503 || err.kind === "connect-refuse" || err.kind === "midstream-drop";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function rand(range: [number, number]): number {
  return Math.round(range[0] + Math.random() * (range[1] - range[0]));
}

/** 按评测加速系数缩放仿真耗时区间（生产 factor=1 行为不变） */
function randScaled(range: [number, number], factor: number): number {
  return Math.max(0, Math.round(rand(range) * factor));
}

/** 合规离线回复（旗舰档按现行 FIN-001 口径，绝不出现自动打款承诺） */
function offlineReply(tier: RoutingTier, maxAmount: number): string {
  if (tier === "flagship") {
    const amountLine = maxAmount > 0 ? `本次涉及最大单笔金额 ¥${maxAmount.toLocaleString("en-US")}，` : "";
    const overLine = maxAmount > FIN001_THRESHOLD_YUAN ? "单笔严格超过 ¥50,000 红线，触发 FIN-001 强制人工审批，" : "";
    return (
      `【旗舰推理 · 只读核对草稿】${amountLine}${overLine}` +
      "已按现行制度核对完毕：AI 只读、起草、标记，不审批、不打款；" +
      "琥珀色预警卡与人工审批草稿已生成，等待具名审批人签字放行。"
    );
  }
  return (
    "【快模型草稿】已识别该请求为常规分类任务，按标准话术起草回复草稿；" +
    "未触发 FIN-001 大额红线，无任何写操作与打款动作。"
  );
}

interface AttemptTiming {
  networkMs: number;
  ttftMs: number;
  generationMs: number;
  tokensPerSec: number;
  text: string;
  outputTokens: number;
}

/** 单厂商离线流式调用：L1 连接 → L5 首字 → L6 逐字生成（含演习注入点） */
async function attemptProvider(args: {
  key: ProviderKey;
  profile: ProviderProfile;
  model: string;
  reply: string;
  onToken: (chunk: string) => void;
  drill?: DrillInjection;
  speedFactor: number;
}): Promise<AttemptTiming> {
  const drillHere = args.drill && args.drill.provider === args.key ? args.drill : undefined;
  const f = args.speedFactor;

  // L1 网络连接（connect-refuse 注入点：连接阶段即被拒绝）
  const connectStart = Date.now();
  if (drillHere?.mode === "connect-refuse") {
    await sleep(Math.round(randScaled(args.profile.sim.connectMs, f) * 0.6));
    throw new GatewayFault(
      args.profile.providerId,
      "connect-refuse",
      503,
      "network",
      `【演习注入】${args.key} 连接被拒绝（模拟主厂商断网，连接层失败）`,
    );
  }
  await sleep(randScaled(args.profile.sim.connectMs, f));
  const networkMs = Date.now() - connectStart;

  // L5 首字延迟
  const ttftStart = Date.now();
  await sleep(randScaled(args.profile.sim.ttftMs, f));
  const ttftMs = Date.now() - ttftStart;

  // L6 逐字生成（midstream-drop 注入点：吐出 N 字后连接中断）
  const genStart = Date.now();
  let sent = 0;
  for (const ch of args.reply) {
    if (drillHere?.mode === "midstream-drop" && sent >= (drillHere.afterTokens ?? 12)) {
      throw new GatewayFault(
        args.profile.providerId,
        "midstream-drop",
        503,
        "generation",
        `【演习注入】${args.key} 流式传输中断（已传 ${sent} 字后连接断开，模拟中途断网）`,
        sent,
      );
    }
    args.onToken(ch);
    sent += 1;
    await sleep(randScaled(args.profile.sim.charMs, f));
  }
  const generationMs = Date.now() - genStart;
  const outputTokens = Math.max(1, Math.ceil(args.reply.length / 1.5));
  return {
    networkMs,
    ttftMs,
    generationMs,
    tokensPerSec: generationMs > 0 ? Number((outputTokens / (generationMs / 1000)).toFixed(1)) : 0,
    text: args.reply,
    outputTokens,
  };
}

/* ================= 七、网关状态（模块级单例 + 演习/测试复位） ================= */

interface CacheEntry {
  text: string;
  tier: RoutingTier;
  provider: ProviderKey;
  model: string;
  baselineTotalMs: number;
  createdAt: number;
}

interface GatewayState {
  cfg: RoutingConfig;
  breaker: CircuitBreaker;
  cache: Map<string, CacheEntry>;
  reqSeq: number;
}

let state: GatewayState | null = null;

/**
 * 初始化（或复位）网关状态。演习可用 cooldownMsOverride 压缩冷却时长（生产不传，走配置 60 秒）。
 */
export function initGatewayState(opts?: { cooldownMsOverride?: number }): RoutingConfig {
  const cfg = loadRoutingConfig();
  const cooldown = opts?.cooldownMsOverride ?? cfg.circuitBreaker.cooldownMs;
  state = {
    cfg,
    breaker: new CircuitBreaker(cfg.circuitBreaker.failureThreshold, cooldown),
    cache: new Map(),
    reqSeq: 0,
  };
  return cfg;
}

function getState(): GatewayState {
  if (!state) initGatewayState();
  return state as GatewayState;
}

/** 测试 / 演习复位（清空断路器与缓存，绝不触碰任何审计台账） */
export function resetGatewayStateForTests(): void {
  state = null;
}

export function getBreakerSnapshots(): BreakerSnapshot[] {
  return getState().breaker.snapshots(Date.now());
}

/* ================= 八、主入口：7 层耗时拆分 + 熔断热切 ================= */

/**
 * 统一网关主入口：
 *   L2 解析分类 → L7 缓存查 → L3 向量化 → L4 ACL 检索 → L1 连接 → L5 首字 → L6 生成
 * 主厂商失败自动热切备用；熔断期内直接跳过主厂商（零探测浪费）。
 */
export async function runGateway(req: GatewayRequest): Promise<GatewayResult> {
  const st = getState();
  const cfg = st.cfg;
  const startedAt = Date.now();
  st.reqSeq += 1;
  const requestId = req.requestId ?? `GW-${String(st.reqSeq).padStart(3, "0")}-${Date.now().toString(36)}`;
  const role = req.role ?? "executive";
  const onToken = req.onToken ?? (() => {});
  const f = req.simSpeedFactor ?? 1;
  const notices: string[] = [];
  const breakerEvents: BreakerEvent[] = [];
  const failedAttempts: FailedAttempt[] = [];

  // ---- L2 解析 / 分类 ----
  const parseStart = Date.now();
  const trimmed = req.query.trim();
  const cls = classifyQuery(trimmed, cfg);
  const tier: RoutingTier = req.tierOverride ?? cls.tier;
  const tierReason = req.tierOverride ? `调用方指定档位（覆盖自动分类：${cls.reason}）` : cls.reason;
  await sleep(randScaled([2, 6], f));
  const parseMs = Date.now() - parseStart;

  const route = cfg.routing[tier];
  const chain: ProviderKey[] = [route.primary, route.backup];

  // ---- L7 缓存命中检查（同问题 + 同角色才命中；命中即跳过 L1/L3/L4/L5/L6） ----
  const key = cacheKey(role, trimmed);
  const hit = cfg.cache.enabled ? st.cache.get(key) : undefined;
  if (hit) {
    notices.push(
      `【缓存】命中同请求缓存（此前基线 ${hit.baselineTotalMs}ms），本次跳过网络/向量/ACL/生成全链路，直接回放草稿`,
    );
    onToken(hit.text);
    const totalMs = Date.now() - startedAt;
    const result: GatewayResult = {
      requestId,
      ts: new Date().toISOString(),
      role,
      queryChars: trimmed.length,
      queryHash: fnv1a(trimmed),
      tier,
      tierReason,
      providerChain: chain,
      providerUsed: hit.provider,
      model: `${hit.model}（缓存回放）`,
      wasFallback: false,
      fallbackReason: null,
      primarySkippedByBreaker: false,
      breakerEvents,
      failedAttempts,
      layers: {
        networkMs: 0,
        parseMs,
        vectorMs: 0,
        aclMs: 0,
        ttftMs: 0,
        generationMs: 0,
        tokensPerSec: 0,
        cacheHit: true,
        cacheSavedMs: hit.baselineTotalMs,
      },
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      text: hit.text,
      totalMs,
      offlineSim: true,
      notices,
    };
    return result;
  }

  // ---- L3 向量化（真实确定性哈希向量 + 仿真耗时下限） ----
  const vectorStart = Date.now();
  embed(tokenize(trimmed));
  await sleep(randScaled([8, 18], f));
  const vectorMs = Date.now() - vectorStart;

  // ---- L4 ACL 预过滤检索（越权文档在打分之前物理剔除） ----
  const aclStart = Date.now();
  const visible = ACL_DOC_POOL.filter((d) => !d.abolished && d.depts.includes(role));
  await sleep(randScaled([4, 12], f));
  const aclMs = Date.now() - aclStart;
  notices.push(
    `【ACL】以角色 ${role} 预过滤文档池：可见 ${visible.length}/${ACL_DOC_POOL.length} 篇，已废止文件物理剔除`,
  );

  // ---- 主备链调用（熔断热切在这里发生） ----
  const maxAmount = extractMaxAmount(trimmed);
  const reply = offlineReply(tier, maxAmount);
  let providerUsed: ProviderKey | null = null;
  let model = "";
  let timing: AttemptTiming | null = null;
  let wasFallback = false;
  let fallbackReason: string | null = null;
  let primarySkippedByBreaker = false;

  for (let i = 0; i < chain.length; i++) {
    const pk = chain[i];
    const profile = cfg.providers[pk];
    const verdict = st.breaker.canPass(pk, Date.now());
    if (!verdict.allowed) {
      if (i === 0) primarySkippedByBreaker = true;
      breakerEvents.push({
        provider: pk,
        type: "rejected_while_open",
        at: new Date().toISOString(),
        state: verdict.state,
        cooldownRemainingMs: verdict.remainingMs,
      });
      notices.push(`【熔断】${pk} 熔断中（剩 ${(verdict.remainingMs / 1000).toFixed(1)} 秒），跳过探测直走备用`);
      continue;
    }
    if (verdict.state === "half-open") {
      breakerEvents.push({ provider: pk, type: "half_open_probe", at: new Date().toISOString(), state: "half-open" });
      notices.push(`【半开】${pk} 冷却结束，放行一次探测请求`);
    }

    try {
      const attempt = await attemptProvider({
        key: pk,
        profile,
        model: profile[route.modelSlot],
        reply,
        onToken,
        drill: req.drill,
        speedFactor: f,
      });
      st.breaker.recordSuccess(pk);
      if (verdict.state === "half-open") {
        breakerEvents.push({ provider: pk, type: "recovered_closed", at: new Date().toISOString(), state: "closed" });
        notices.push(`【恢复】${pk} 半开探测成功，熔断器已闭合，重新担任主厂商`);
      }
      providerUsed = pk;
      model = profile[route.modelSlot];
      timing = attempt;
      wasFallback = i > 0;
      break;
    } catch (err) {
      const fault = err instanceof GatewayFault
        ? err
        : new GatewayFault(
            profile.providerId,
            "provider-error",
            500,
            "ttft",
            err instanceof Error ? err.message : String(err),
          );
      if (!isFallbackWorthy(fault)) throw fault; // 非可切换故障：上抛，绝不静默吞错
      const fb = st.breaker.recordFailure(pk, Date.now());
      breakerEvents.push({
        provider: pk,
        type: fb.tripped ? "tripped_open" : "failure_count",
        at: new Date().toISOString(),
        failures: fb.failures,
        state: fb.state,
      });
      if (fb.tripped) {
        notices.push(
          `【熔断开启】${pk} 连续 ${fb.failures}/${cfg.circuitBreaker.failureThreshold} 次失败，熔断 ${Math.round(st.breaker.cooldownDurationMs / 1000)} 秒，期间直走备用 ${route.backup}`,
        );
      } else {
        notices.push(
          `【热切】${pk} 第 ${fb.failures}/${cfg.circuitBreaker.failureThreshold} 次失败（${fault.message}），立即热切备用 ${route.backup}`,
        );
      }
      failedAttempts.push({
        provider: pk,
        model: profile[route.modelSlot],
        faultKind: fault.kind,
        status: fault.status,
        message: fault.message,
        reachedLayer: fault.reachedLayer,
        elapsedMs: Date.now() - startedAt,
      });
      fallbackReason = fault.message;
    }
  }

  if (!providerUsed || !timing) {
    throw new Error(`主备链全部失败，网关放弃（绝不硬凑成功）：${failedAttempts.map((a) => a.message).join("；")}`);
  }

  const inputTokens = Math.max(1, Math.ceil(trimmed.length / 1.5));
  const profile = cfg.providers[providerUsed];
  const costUsd = Number(
    (
      (inputTokens / 1e6) * profile.priceInPerM +
      (timing.outputTokens / 1e6) * profile.priceOutPerM
    ).toFixed(6),
  );

  const result: GatewayResult = {
    requestId,
    ts: new Date().toISOString(),
    role,
    queryChars: trimmed.length,
    queryHash: fnv1a(trimmed),
    tier,
    tierReason,
    providerChain: chain,
    providerUsed,
    model,
    wasFallback,
    fallbackReason,
    primarySkippedByBreaker,
    breakerEvents,
    failedAttempts,
    layers: {
      networkMs: timing.networkMs,
      parseMs,
      vectorMs,
      aclMs,
      ttftMs: timing.ttftMs,
      generationMs: timing.generationMs,
      tokensPerSec: timing.tokensPerSec,
      cacheHit: false,
      cacheSavedMs: 0,
    },
    usage: { inputTokens, outputTokens: timing.outputTokens },
    costUsd,
    text: timing.text,
    totalMs: Date.now() - startedAt,
    offlineSim: true,
    notices,
  };

  // 演习请求不写缓存（避免演习注入污染正常缓存）；成功响应才缓存
  if (cfg.cache.enabled && !req.drill) {
    if (st.cache.size >= cfg.cache.maxEntries) {
      const oldest = st.cache.keys().next().value;
      if (oldest !== undefined) st.cache.delete(oldest); // FIFO 淘汰
    }
    st.cache.set(key, {
      text: timing.text,
      tier,
      provider: providerUsed,
      model,
      baselineTotalMs: result.totalMs,
      createdAt: Date.now(),
    });
  }
  return result;
}

/* ================= 九、审计台账（JSONL 只增不改，无修改/删除通道） ================= */

export interface GatewayLogEntry {
  ts: string;
  event: "gateway_request";
  requestId: string;
  role: AclRole;
  tier: RoutingTier;
  tierReason: string;
  providerUsed: ProviderKey;
  model: string;
  wasFallback: boolean;
  primarySkippedByBreaker: boolean;
  breakerEvents: BreakerEvent[];
  failedAttempts: FailedAttempt[];
  layers: GatewayLayerTiming;
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number;
  totalMs: number;
  cacheHit: boolean;
  /** 提问原文不落日志：只留字数与指纹（PII 防线） */
  queryChars: number;
  queryHash: string;
  drill: { provider: ProviderKey; mode: DrillMode } | null;
}

/** 追加一条网关请求台账（只增不改；不含提问原文，杜绝 PII 落日志） */
export async function appendGatewayLog(entry: GatewayLogEntry): Promise<void> {
  const logPath = join(process.cwd(), "data", "day24", "gateway_requests.jsonl");
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, JSON.stringify(entry) + "\n", "utf8");
}

/* ================= 十、延迟瀑布渲染（控制台 / 页面共用） ================= */

/** 渲染单请求延迟瀑布：7 层耗时条形 + 瓶颈层定位 + 失败尝试证据链 */
export function renderWaterfall(r: GatewayResult): string {
  const lines: string[] = [];
  const tierLabel = r.tier === "flagship" ? "旗舰推理档" : "简单分类档";
  const head = `延迟瀑布 ${r.requestId} · ${tierLabel} → ${r.providerUsed}/${r.model.replace("（缓存回放）", "")}`;
  lines.push(head);
  if (r.wasFallback && r.fallbackReason) {
    lines.push(`  !! 主厂商故障已热切备用：${r.fallbackReason}`);
  }
  if (r.primarySkippedByBreaker) {
    lines.push("  >> 熔断期内：跳过主厂商零探测直走备用");
  }

  if (r.layers.cacheHit) {
    lines.push("  L7 缓存命中  <" + "·".repeat(20) + "> 全链路跳过");
    lines.push(`  L2 解析/分类  ${String(r.layers.parseMs).padStart(5)}ms`);
    lines.push(
      `  == 缓存节省 ${r.layers.cacheSavedMs}ms（基线），本次仅 ${r.totalMs}ms 完成 ==`,
    );
    return lines.join("\n");
  }

  const rows: { key: string; ms: number; note: string }[] = [
    { key: "L1 网络连接", ms: r.layers.networkMs, note: "" },
    { key: "L2 解析/分类", ms: r.layers.parseMs, note: r.tierReason },
    { key: "L3 向量化", ms: r.layers.vectorMs, note: "" },
    { key: "L4 ACL 检索", ms: r.layers.aclMs, note: "" },
    { key: "L5 首字延迟", ms: r.layers.ttftMs, note: "TTFT" },
    {
      key: "L6 生成",
      ms: r.layers.generationMs,
      note: `${r.layers.tokensPerSec} Token/秒 · ${r.usage.outputTokens} Token`,
    },
  ];
  const max = Math.max(...rows.map((row) => row.ms), 1);
  const barWidth = 30;
  let bottleneck = rows[0];
  for (const row of rows) {
    if (row.ms > bottleneck.ms) bottleneck = row;
    const width = Math.max(1, Math.round((row.ms / max) * barWidth));
    lines.push(`  ${row.key}  ${"█".repeat(width)} ${String(row.ms).padStart(5)}ms  ${row.note}`);
  }
  lines.push(`  L7 缓存      未命中（本次全链路直连）`);
  lines.push(`  -- 总耗时 ${r.totalMs}ms · 瓶颈层：${bottleneck.key}（${bottleneck.ms}ms）`);
  for (const fa of r.failedAttempts) {
    lines.push(`  x 失败尝试 ${fa.provider}/${fa.model} 于 ${fa.reachedLayer} 层中断（HTTP ${fa.status}）→ 热切证据已入台账`);
  }
  return lines.join("\n");
}
