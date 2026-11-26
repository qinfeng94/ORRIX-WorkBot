/**
 * memory.ts —— Day 9 三层企业记忆的核心纯函数（仅服务端使用）
 * 三层协同：
 *   ① 工作记忆：当前对话最近 6 轮原文，超出部分滑动摘要压缩（本文件计算节省 Token 百分比）；
 *   ② 情景记忆：跨会话自动提取关键工单结论（如 CUST-8842 跟进状态），写入 memory_episodes；
 *   ③ 语义记忆：用户的部门偏好与称呼风格，写入 user_preferences。
 * 边界：所有函数都是确定性纯函数（不联网、不读库），提取逻辑可被用户在记忆面板查看/编辑/删除。
 */

/** 工作记忆滑动窗口：保留最近 6 轮原文（1 轮 = 用户提问 + AI 回复） */
export const WORKING_WINDOW_ROUNDS = 6;

/** 上下文窗口预算（演示口径）：用于 /chat 顶部占用仪表盘 */
export const CONTEXT_BUDGET_TOKENS = 8000;

/** 一轮完整对话（历史轮次，不含当前进行中的提问） */
export interface ChatRound {
  user: string;
  assistant: string;
}

/** 组装给大模型的messages（role 仅 user/assistant） */
export interface MemoryChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Token 估算（零依赖启发式）：中文字符 ≈ 1 token，其他字符 ≈ 4 字符 1 token。
 * 只用于展示层仪表盘与节省百分比，不参与计费（计费以厂商返回的 usage 为准）。
 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff01-\uff5e]/g) ?? []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk + other / 4);
}

export interface WorkingMemoryResult {
  /** 溢出轮次的压缩摘要（无溢出时为空串） */
  summaryText: string;
  /** 被摘要压缩掉的轮次数 */
  summarizedRounds: number;
  /** 保留原文的最近轮次（拍平成 messages） */
  keptMessages: MemoryChatMessage[];
  /** 不做压缩时的原始 Token 量 */
  originalTokens: number;
  /** 压缩后的 Token 量（摘要 + 保留原文） */
  compressedTokens: number;
  /** 节省百分比（0-100，四舍五入） */
  savedPercent: number;
}

/** 截断辅助：超长按句号/换行优先断句，避免摘要在词语中间断开 */
function truncateForSummary(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastStop = Math.max(
    cut.lastIndexOf("。"),
    cut.lastIndexOf("；"),
    cut.lastIndexOf("，"),
    cut.lastIndexOf(" "),
  );
  return (lastStop > maxChars * 0.5 ? cut.slice(0, lastStop) : cut) + "…";
}

/**
 * ① 工作记忆：滑动窗口 + 溢出摘要压缩。
 * 输入是历史已完成轮次（不含当前提问）；最近 6 轮保留原文，更早的轮次
 * 压缩成「第 N 轮 问：… 答：…」式摘要。
 */
export function buildWorkingMemory(rounds: ChatRound[]): WorkingMemoryResult {
  const safeRounds = rounds.slice(-30); // 历史上限 30 轮，防请求体膨胀
  const overflowCount = Math.max(0, safeRounds.length - WORKING_WINDOW_ROUNDS);
  const overflow = safeRounds.slice(0, overflowCount);
  const kept = safeRounds.slice(-Math.min(safeRounds.length, WORKING_WINDOW_ROUNDS));

  // 口径统一：original 与 kept 用同一拍平格式估算，保证「无压缩时节省为 0」严格成立
  const originalTokens = estimateTokens(
    safeRounds.map((r) => `${r.user}\n${r.assistant}`).join("\n"),
  );
  const keptMessages: MemoryChatMessage[] = kept.flatMap((r) => [
    { role: "user" as const, content: r.user },
    { role: "assistant" as const, content: r.assistant },
  ]);
  const keptTokens = estimateTokens(
    keptMessages.map((m) => m.content).join("\n"),
  );

  if (overflowCount === 0) {
    return {
      summaryText: "",
      summarizedRounds: 0,
      keptMessages,
      originalTokens,
      compressedTokens: keptTokens,
      savedPercent: 0,
    };
  }

  const summaryLines = overflow.map((r, i) => {
    const roundNo = i + 1;
    return `第${roundNo}轮 问：${truncateForSummary(r.user, 24)} 答：${truncateForSummary(r.assistant, 64)}`;
  });
  const summaryText = `[前情摘要·更早 ${overflowCount} 轮已压缩]\n${summaryLines.join("\n")}`;
  const compressedTokens = keptTokens + estimateTokens(summaryText);
  const savedPercent =
    originalTokens > 0
      ? Math.max(0, Math.round((1 - compressedTokens / originalTokens) * 100))
      : 0;

  return {
    summaryText,
    summarizedRounds: overflowCount,
    keptMessages,
    originalTokens,
    compressedTokens,
    savedPercent,
  };
}

/* ================================================================
 * ② 情景记忆：跨会话提取关键工单结论
 * ================================================================ */

export interface ExtractedEpisode {
  episodeType: "ticket_conclusion";
  content: string;
  ticketRefs: string;
}

/**
 * 从「本轮提问 + AI 最终回复」里提取工单结论。
 * 规则（确定性，不用大模型）：命中 CUST-xxxx / TCK-xxxx / AP-xxxx 单号
 * 且回复非空才生成一条情景摘要；金额与回复首句一并入档，便于跨会话回看。
 */
export function extractEpisode(
  question: string,
  replyText: string,
): ExtractedEpisode | null {
  const combined = `${question}\n${replyText}`;
  const custRefs = Array.from(new Set(combined.match(/CUST-\d{3,6}/gi) ?? []));
  const tckRefs = Array.from(new Set(combined.match(/TCK-[A-Z]?\d+/gi) ?? []));
  const apRefs = Array.from(new Set(combined.match(/AP-\d{8}-\d{3}/gi) ?? []));
  const refs = [...tckRefs, ...custRefs, ...apRefs];
  if (refs.length === 0) return null;

  const amounts = Array.from(new Set(replyText.match(/¥\s?[\d,，]+(?:\.\d+)?/g) ?? []));
  const replyClean = replyText.replace(/\s+/g, " ").trim();
  if (replyClean.length === 0) return null;
  const conclusion = truncateForSummary(replyClean, 120);

  const parts: string[] = [];
  if (tckRefs.length > 0) parts.push(`工单 ${tckRefs.join("、")}`);
  if (custRefs.length > 0) parts.push(`客户 ${custRefs.join("、")}`);
  if (amounts.length > 0) parts.push(`涉及金额 ${amounts.join(" / ")}`);
  if (apRefs.length > 0) parts.push(`本次生成审批单 ${apRefs.join("、")}`);

  return {
    episodeType: "ticket_conclusion",
    content: `${parts.length > 0 ? `${parts.join(" · ")}｜` : ""}本次结论：${conclusion}`,
    ticketRefs: refs.join(" "),
  };
}

/* ================================================================
 * ③ 语义记忆：部门偏好自动学习 + 称呼风格
 * ================================================================ */

/** 业务流 → 部门映射（默认租户口径；多租户调用方应传入租户配置的 flowDepartments） */
export const FLOW_DEPARTMENT: Record<string, string> = {
  logistics: "运营部",
  finance: "财务部",
  complaint: "客服部",
  generic: "",
};

/**
 * ③ 语义记忆自动学习：根据本轮业务流更新部门偏好事实。
 * 规则：generic 不学习；命中部门时 department 更新为该部门，
 *      并在 facts 里保证有一条「常关注部门：X」；称呼风格不由 AI 猜测，交给用户手改。
 * Day 27 多租户：deptMap 缺省 = 默认租户映射；其他租户传入 tenantConfig.flowDepartments。
 */
export function learnPreference(
  prev: { department: string; facts: string[] },
  flow: string,
  deptMap: Readonly<Record<string, string>> = FLOW_DEPARTMENT,
): { department: string; facts: string[] } {
  const dept = deptMap[flow] ?? "";
  if (dept === "") return prev;
  const factLabel = `常关注部门：${dept}`;
  const facts = prev.facts.includes(factLabel)
    ? prev.facts
    : [...prev.facts, factLabel];
  return { department: dept, facts };
}

/* ================================================================
 * ④ 记忆片段开关与注入预览（面板 UI 与上下文注入的统一口径）
 * ================================================================ */

/**
 * 从事实清单中筛出「启用中」的部分——即真正注入 AI 上下文的口径。
 * 停用清单（disabledFacts）是 facts 的子集；不在清单里的残留项一律忽略。
 */
export function selectInjectableFacts(
  facts: string[],
  disabledFacts: string[],
): string[] {
  const off = new Set(disabledFacts ?? []);
  return (facts ?? []).filter((f) => !off.has(f));
}

/**
 * 孤儿清理：剔除「已不在事实清单里」的停用残留（API 保存 disabledFacts 时的口径）。
 */
export function cleanDisabledFacts(
  facts: string[],
  disabledFacts: string[],
): string[] {
  const alive = new Set(facts ?? []);
  return (disabledFacts ?? []).filter((f) => alive.has(f));
}

export interface InjectPreview {
  /** 启用中的事实条数 */
  activeFacts: number;
  /** 启用中的情景片段条数 */
  activeEpisodes: number;
  /** 情景片段总数 */
  totalEpisodes: number;
}

/**
 * 注入预览：面板顶部「下轮对话将参考 X 条事实 · Y/Z 条情景」的唯一口径。
 * 面板展示与实际注入（chat 路由）共用同一组函数，杜绝口径漂移。
 */
export function buildInjectPreview(
  facts: string[],
  disabledFacts: string[],
  episodes: readonly { enabled: boolean }[],
): InjectPreview {
  return {
    activeFacts: selectInjectableFacts(facts, disabledFacts).length,
    activeEpisodes: episodes.filter((e) => e.enabled).length,
    totalEpisodes: episodes.length,
  };
}
