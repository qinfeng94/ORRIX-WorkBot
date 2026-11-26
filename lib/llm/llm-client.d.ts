/**
 * llm-client.d.ts — 统一大模型接入层的 TypeScript 类型声明
 * 供 Next.js（app/ 下任意 Route Handler / Server Action）import 复用：
 *   import { streamChat, appendUsageLog } from '@/lib/llm/llm-client.mjs';
 */

export type ProviderKey = 'claude' | 'openai';
export type EffortLevel = 'low' | 'medium' | 'high';
export type ChatRole = 'user' | 'assistant';
export type UsageMode = 'live' | 'offline-sim';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ModelInfo {
  providerId: string;
  model: string;
  label: string;
  effortDefault: EffortLevel;
  priceInPerM: number;
  priceOutPerM: number;
}

export interface StreamChatOptions {
  /** 主模型（一键切换主模型就改这个） */
  primary: ProviderKey;
  messages: ChatMessage[];
  /** effort 档位，缺省用注册表默认值 */
  effort?: EffortLevel;
  /** true = 真实 API；false = 离线高仿真（默认） */
  live?: boolean;
  /** 各厂商 API Key（内存传递，禁止落日志） */
  apiKeys?: Partial<Record<ProviderKey, string>>;
  /** 故障演习：强制让主厂商抛 429 */
  forceOutage?: boolean;
  /** 离线仿真模式下使用的自定义回复文本 */
  offlineReply?: string;
  /** 逐字回调（首字触发即 TTFT 终点） */
  onToken?: (chunk: string) => void;
  /** 主→备切换瞬间回调（在第一个字吐出之前触发） */
  onFallback?: (info: { from: ProviderKey; to: ProviderKey; reason: string }) => void;
}

export interface StreamResult {
  providerKey: ProviderKey;
  providerId: string;
  model: string;
  text: string;
  /** 首字延迟（毫秒） */
  ttftMs: number;
  /** 总耗时（毫秒） */
  totalMs: number;
  usage: { inputTokens: number; outputTokens: number };
  /** 美元花费 */
  costUsd: number;
  /** 是否发生了主→备自动切换 */
  wasFallback: boolean;
  /** 本次调用是否为离线仿真 */
  offlineSim: boolean;
}

export interface UsageLogEntry {
  ts: string;
  event: 'llm_call';
  providerId: string;
  model: string;
  mode: UsageMode;
  effort: EffortLevel;
  ttftMs: number;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  usdCost: number;
  wasFallback: boolean;
  simulatedOutage: boolean;
}

export declare const MODEL_REGISTRY: Record<ProviderKey, ModelInfo>;
export declare function resolveChain(primary: ProviderKey): [ProviderKey, ProviderKey];
export declare function estimateCostUsd(key: ProviderKey, inputTokens: number, outputTokens: number): number;
export declare function streamChat(opts: StreamChatOptions): Promise<StreamResult>;
export declare function appendUsageLog(logPath: string, entry: UsageLogEntry): Promise<void>;
