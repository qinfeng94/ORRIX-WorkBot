/**
 * llm-client.mjs — WorkBot 统一大模型接入层（零第三方依赖，纯 Node 内置模块）
 *
 * 设计目标（承接 AGENTS.md 代码红线）：
 * - 适配两家厂商：Claude Sonnet 5（Anthropic Messages API，Adaptive Thinking + effort 档位）
 *   与 GPT-5.x（OpenAI Responses API，reasoning.effort 档位），一键切换主模型；
 * - 逐字流式输出，统计首字延迟 TTFT（毫秒）；
 * - 主厂商返回 429/503 时自动秒切备用厂商（故障演习由调用方通过 forceOutage 注入）；
 * - 默认无 Key 离线高仿真模式，`--live` 时才读取调用方传入的 API Key 走真实 API；
 * - 密钥只在内存中传递，绝不打印、绝不写入日志（审计日志只增不改）；
 * - 本模块只做「AI 只读 + 起草」类能力，不含任何打款/写业务数据逻辑（红区物理隔离）。
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** @typedef {'claude' | 'openai'} ProviderKey */
/** @typedef {'low' | 'medium' | 'high'} EffortLevel */
/** @typedef {'user' | 'assistant'} ChatRole */

/**
 * @typedef {Object} ChatMessage
 * @property {ChatRole} role
 * @property {string} content
 */

/**
 * @typedef {Object} ModelInfo
 * @property {string} providerId    厂商标识（anthropic / openai）
 * @property {string} model         实际 API 模型名
 * @property {string} label         中文展示名
 * @property {EffortLevel} effortDefault  默认 effort 档位
 * @property {number} priceInPerM   每百万输入 token 美元单价（估算用）
 * @property {number} priceOutPerM  每百万输出 token 美元单价（估算用）
 */

/** 模型注册表：换模型 / 加厂商只改这里 */
export const MODEL_REGISTRY = {
  claude: {
    providerId: 'anthropic',
    model: 'claude-sonnet-5',
    label: 'Claude Sonnet 5（Adaptive Thinking）',
    effortDefault: 'medium',
    priceInPerM: 3,
    priceOutPerM: 15,
  },
  openai: {
    providerId: 'openai',
    model: 'gpt-5.1',
    label: 'GPT-5.1（Responses API）',
    effortDefault: 'medium',
    priceInPerM: 1.25,
    priceOutPerM: 10,
  },
};

/** 有效的 effort 档位 */
const VALID_EFFORTS = new Set(['low', 'medium', 'high']);

/** 触发自动切换的故障状态码 */
const FALLBACK_STATUS = new Set([429, 503]);

/**
 * @typedef {Object} ProviderFault
 * @property {number} status
 * @property {string} providerId
 * @property {string} message
 */

/**
 * 解析主备调用链：主厂商故障时自动切到另一家
 * @param {ProviderKey} primary
 * @returns {[ProviderKey, ProviderKey]}
 */
export function resolveChain(primary) {
  if (!MODEL_REGISTRY[primary]) {
    throw new Error(`未知主模型「${primary}」，可选：${Object.keys(MODEL_REGISTRY).join(' / ')}`);
  }
  const keys = /** @type {ProviderKey[]} */ (Object.keys(MODEL_REGISTRY));
  return [primary, keys.find((k) => k !== primary) ?? primary];
}

/** @param {string} text 中文为主的 token 估算（约 1.5 字符 / token） */
function estimateTokens(text) {
  return Math.ceil(text.length / 1.5);
}

/**
 * 按 注册表单价 计算美元花费（保留 6 位小数）
 * @param {ProviderKey} key
 * @param {number} inputTokens
 * @param {number} outputTokens
 */
export function estimateCostUsd(key, inputTokens, outputTokens) {
  const info = MODEL_REGISTRY[key];
  const usd = (inputTokens / 1e6) * info.priceInPerM + (outputTokens / 1e6) * info.priceOutPerM;
  return Number(usd.toFixed(6));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * 离线高仿真（默认模式，无 Key 可跑，用于演练与开发）
 * ------------------------------------------------------------------ */

const OFFLINE_REPLIES = {
  claude:
    '已读取 11 月应收账款只读快照并逐笔核对：共 42 张发票，其中 3 张存在「明细相加 ≠ 合计」的疑似错账，' +
    '涉及金额 ¥18,460。已按现行 FIN-001 制度标记：其中 1 张单笔 ¥52,300，超过 ¥50,000 红线，' +
    '仅生成琥珀色预警与人工审批草稿，等待具名审批人签字，我不会执行任何付款动作。',
  openai:
    '应收账款快照核对完成：11 月共 42 张发票，发现 3 张算术异常（明细与合计不符），合计差额 ¥18,460。' +
    '按现行 FIN-001 制度，其中 1 张单笔 ¥52,300 已标记为「强制人工审批」，AI 不审批、不打款，' +
    '已起草客户通知话术放入草稿区，等待王主管确认后发出。',
};

/**
 * 离线仿真：逐字流式吐出回复（replyOverride 优先，否则用内置高仿真文案）；
 * forceOutage=true 时先抛 429（模拟主厂商限流）
 * @param {ProviderKey} key
 * @param {boolean} forceOutage
 * @param {(chunk: string) => void} onToken
 * @param {string} [replyOverride] 调用方指定的离线回复文本（如对话工作台按证据拼装的答复）
 * @returns {Promise<{text: string, inputTokens: number, outputTokens: number}>}
 */
async function offlineStream(key, forceOutage, onToken, replyOverride) {
  await sleep(120);
  if (forceOutage) {
    throw /** @type {ProviderFault} */ ({
      status: 429,
      providerId: MODEL_REGISTRY[key].providerId,
      message: '【演习注入】主厂商限流 429（simulate-outage）',
    });
  }
  await sleep(280 + Math.random() * 300); // 模拟网络 + 思考首字延迟
  const text = replyOverride && replyOverride.length > 0 ? replyOverride : OFFLINE_REPLIES[key];
  for (let i = 0; i < text.length; ) {
    const step = 2 + Math.floor(Math.random() * 3); // 每次 2~4 个字符，模拟逐字流
    onToken(text.slice(i, i + step));
    i += step;
    await sleep(12 + Math.random() * 28);
  }
  return { text, inputTokens: estimateTokens(text) / 4, outputTokens: estimateTokens(text) };
}

/* ------------------------------------------------------------------ *
 * 真实 API（仅 --live 模式）
 * ------------------------------------------------------------------ */

/**
 * 通用 SSE 行解析器：把 fetch 流按 data: 事件逐条回调
 * @param {import('node:stream/web').ReadableStream<Uint8Array>} body
 * @param {(payload: string) => void} onData
 */
async function readSse(body, onData) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) {
        onData(trimmed.slice(5).trim());
      }
    }
  }
}

/** 是否为触发切换的厂商故障 */
function isFallbackWorthy(err) {
  return typeof err === 'object' && err !== null &&
    FALLBACK_STATUS.has(/** @type {ProviderFault} */ (err).status ?? NaN);
}

/**
 * Claude Sonnet 5（Anthropic Messages API）真实流式调用
 * effort 档位走 Adaptive Thinking：low/medium/high 由服务端自动分配思考预算
 * @param {Object} args
 * @param {string} args.apiKey
 * @param {ChatMessage[]} args.messages
 * @param {EffortLevel} args.effort
 * @param {(chunk: string) => void} args.onToken
 */
async function claudeLiveStream({ apiKey, messages, effort, onToken }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'adaptive-thinking-2025-11-01',
    },
    body: JSON.stringify({
      model: MODEL_REGISTRY.claude.model,
      max_tokens: 2048,
      stream: true,
      thinking: { type: 'adaptive' },
      effort,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });
  if (!res.ok || !res.body) {
    throw /** @type {ProviderFault} */ ({
      status: res.status,
      providerId: 'anthropic',
      message: `Anthropic HTTP ${res.status}`,
    });
  }
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  await readSse(res.body, (payload) => {
    if (payload === '[DONE]') return;
    let evt;
    try { evt = JSON.parse(payload); } catch { return; }
    if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
      text += evt.delta.text;
      onToken(evt.delta.text);
    } else if (evt.type === 'message_start' && evt.message?.usage) {
      inputTokens = evt.message.usage.input_tokens ?? 0;
    } else if (evt.type === 'message_delta' && evt.usage) {
      outputTokens = evt.usage.output_tokens ?? outputTokens;
    }
  });
  return { text, inputTokens, outputTokens };
}

/**
 * GPT-5.x（OpenAI Responses API）真实流式调用
 * effort 档位走 reasoning.effort：low/medium/high
 * @param {Object} args
 * @param {string} args.apiKey
 * @param {ChatMessage[]} args.messages
 * @param {EffortLevel} args.effort
 * @param {(chunk: string) => void} args.onToken
 */
async function openaiLiveStream({ apiKey, messages, effort, onToken }) {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL_REGISTRY.openai.model,
      stream: true,
      reasoning: { effort },
      input: messages.map((m) => ({
        role: m.role,
        content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content }],
      })),
    }),
  });
  if (!res.ok || !res.body) {
    throw /** @type {ProviderFault} */ ({
      status: res.status,
      providerId: 'openai',
      message: `OpenAI HTTP ${res.status}`,
    });
  }
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  await readSse(res.body, (payload) => {
    if (payload === '[DONE]') return;
    let evt;
    try { evt = JSON.parse(payload); } catch { return; }
    if (evt.type === 'response.output_text.delta') {
      text += evt.delta ?? '';
      onToken(evt.delta ?? '');
    } else if (evt.type === 'response.completed' && evt.response?.usage) {
      inputTokens = evt.response.usage.input_tokens ?? 0;
      outputTokens = evt.response.usage.output_tokens ?? 0;
    }
  });
  return { text, inputTokens, outputTokens };
}

/* ------------------------------------------------------------------ *
 * 对外主入口：带故障切换的流式对话
 * ------------------------------------------------------------------ */

/**
 * @typedef {Object} StreamChatOptions
 * @property {ProviderKey} primary             主模型（一键切换主模型就改这个）
 * @property {ChatMessage[]} messages          对话消息
 * @property {EffortLevel} [effort]            effort 档位，缺省用注册表默认值
 * @property {boolean} [live]                  true=真实 API；false=离线高仿真（默认）
 * @property {Partial<Record<ProviderKey, string>>} [apiKeys]  各厂商 API Key（内存传递，禁止落日志）
 * @property {boolean} [forceOutage]           故障演习：强制让主厂商抛 429
 * @property {string} [offlineReply]           离线仿真模式下使用的自定义回复文本
 * @property {(chunk: string) => void} [onToken]  逐字回调（首字触发即 TTFT 终点）
 * @property {(info: {from: ProviderKey, to: ProviderKey, reason: string}) => void} [onFallback]
 *                                            主→备切换瞬间回调（在第一个字吐出之前触发）
 */

/**
 * @typedef {Object} StreamResult
 * @property {ProviderKey} providerKey     实际服务厂商
 * @property {string} providerId
 * @property {string} model
 * @property {string} text                 完整回复
 * @property {number} ttftMs               首字延迟（毫秒）
 * @property {number} totalMs              总耗时（毫秒）
 * @property {{inputTokens: number, outputTokens: number}} usage
 * @property {number} costUsd              美元花费
 * @property {boolean} wasFallback         是否发生了主→备自动切换
 * @property {boolean} offlineSim          本次调用是否为离线仿真
 */

/**
 * 主入口：按主备链依次尝试，429/503 自动秒切备用厂商
 * @param {StreamChatOptions} opts
 * @returns {Promise<StreamResult>}
 */
export async function streamChat(opts) {
  const { primary, messages, onToken = () => {} } = opts;
  const effort = opts.effort ?? MODEL_REGISTRY[primary].effortDefault;
  if (!VALID_EFFORTS.has(effort)) {
    throw new Error(`无效 effort 档位「${effort}」，可选：low / medium / high`);
  }
  const live = opts.live === true;
  const chain = resolveChain(primary);
  /** @type {ProviderFault | null} */
  let primaryFault = null;

  for (let i = 0; i < chain.length; i++) {
    const key = chain[i];
    const isFallbackAttempt = i > 0;
    const forceOutage = (opts.forceOutage === true) && !isFallbackAttempt;
    if (live && !forceOutage && !opts.apiKeys?.[key]) {
      throw new Error(`--live 模式缺少 ${key} 的 API Key（请写入 .env.local，不要传进代码）`);
    }

    const startedAt = Date.now();
    let firstTokenAt = 0; // 首字到达时刻，用于 TTFT
    const tokenProbe = (chunk) => {
      if (chunk && !firstTokenAt) firstTokenAt = Date.now();
      onToken(chunk);
    };
    try {
      const result = forceOutage
        ? await offlineStream(key, true, tokenProbe, opts.offlineReply) // 演习注入：主厂商必失败
        : live
          ? await (key === 'claude'
              ? claudeLiveStream({ apiKey: /** @type {string} */ (opts.apiKeys?.[key]), messages, effort, onToken: tokenProbe })
              : openaiLiveStream({ apiKey: /** @type {string} */ (opts.apiKeys?.[key]), messages, effort, onToken: tokenProbe }))
          : await offlineStream(key, false, tokenProbe, opts.offlineReply);

      const totalMs = Date.now() - startedAt;
      // 离线仿真时输入按提问长度估算
      const inputTokens = result.inputTokens || estimateTokens(messages.map((m) => m.content).join('\n'));
      return {
        providerKey: key,
        providerId: MODEL_REGISTRY[key].providerId,
        model: MODEL_REGISTRY[key].model,
        text: result.text,
        ttftMs: firstTokenAt ? firstTokenAt - startedAt : totalMs,
        totalMs,
        usage: { inputTokens: Math.ceil(inputTokens), outputTokens: result.outputTokens },
        costUsd: estimateCostUsd(key, Math.ceil(inputTokens), result.outputTokens),
        wasFallback: isFallbackAttempt,
        offlineSim: !live,
      };
    } catch (err) {
      if (isFallbackAttempt || !isFallbackWorthy(err)) {
        throw err; // 备用厂商也挂了，或非 429/503 故障：直接上抛，绝不静默吞错
      }
      primaryFault = /** @type {ProviderFault} */ (err);
      // 秒切备用厂商（无重试等待，符合「切断不丢日志」的快恢复思路）；切换瞬间对外广播
      if (typeof opts.onFallback === 'function') {
        opts.onFallback({
          from: key,
          to: chain[i + 1] ?? key,
          reason: `HTTP ${primaryFault.status ?? '未知'}：${primaryFault.message ?? '厂商故障'}`,
        });
      }
    }
  }
  throw primaryFault ?? new Error('调用链为空');
}

/* ------------------------------------------------------------------ *
 * 用量记账：JSONL 只增不改
 * ------------------------------------------------------------------ */

/**
 * @typedef {Object} UsageLogEntry
 * @property {string} ts              ISO 时间戳
 * @property {string} event           固定为 'llm_call'
 * @property {string} providerId
 * @property {string} model
 * @property {'live' | 'offline-sim'} mode
 * @property {EffortLevel} effort
 * @property {number} ttftMs
 * @property {number} totalMs
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} usdCost
 * @property {boolean} wasFallback
 * @property {boolean} simulatedOutage
 */

/**
 * 追加一条用量日志（JSONL，只增不改，无任何修改/删除通道）
 * @param {string} logPath
 * @param {UsageLogEntry} entry
 */
export async function appendUsageLog(logPath, entry) {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, JSON.stringify(entry) + '\n', 'utf8');
}
