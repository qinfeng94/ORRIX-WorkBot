/**
 * pii-scrubber.ts —— Day 19 确定性 PII 脱敏工具（零第三方依赖，仅服务端使用）
 * 溯源：04 号文档 CISO 条款 4（PII 脱敏）；AGENTS.md 代码红线 3（严禁 PII 明文落库）。
 * 边界：
 * - 纯确定性正则替换，不经过任何大模型（脱敏逻辑本身绝不允许"幻觉"）；
 * - 替换目标统一为 `[REDACTED_PII]`，覆盖手机号 / 身份证号 / 银行卡号三大类；
 * - fail-closed 优先：拿不准的长数字串宁可误杀（替换），绝不放行明文；
 * - 调用时机：请求与响应在写入监控日志 / 记忆表之前，一律先过本模块。
 */

/** 脱敏后的统一占位符 */
export const REDACTED_PII = "[REDACTED_PII]";

/**
 * 身份证号（18 位，含尾号 X）：6 位地址码 + 8 位出生日期 + 3 位顺序码 + 1 位校验位。
 * 出生日期段做了真实日历校验（月 01-12、日 01-31），避免误杀普通长数字。
 */
const ID_CARD_RE =
  /(?<!\d)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g;

/**
 * 银行卡号：连续 13~19 位数字（fail-closed——时间戳等无语义长数字串宁可误杀）。
 * 必须先于手机号执行前的注意点：18 位身份证已在上一步被替换，不会二次命中。
 */
const BANK_CARD_RE = /(?<!\d)\d{13,19}(?!\d)/g;

/** 手机号（中国大陆 11 位，1 开头第二位 3-9）：前后不能紧贴数字，防止从长串中截取 */
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;

/** 4 位一组、允许空格 / 连字符分隔的银行卡（如 6222 0212 3456 7890，总位数 13~19） */
const BANK_CARD_GROUPED_RE = /(?<!\d)(?:\d{4}[ -]?){2,4}\d{1,4}(?!\d)/g;

/** 单条脱敏统计 */
export interface PiiScrubStats {
  phone: number;
  idCard: number;
  bankCard: number;
  /** 合计替换次数 */
  total: number;
}

export interface PiiScrubResult {
  /** 脱敏后的文本 */
  text: string;
  stats: PiiScrubStats;
}

/** 空统计（避免到处手写零值对象） */
export function emptyPiiStats(): PiiScrubStats {
  return { phone: 0, idCard: 0, bankCard: 0, total: 0 };
}

/** 统计一段文本里命中的银行卡位数（13~19 位才算，防误杀短编号） */
function isBankCardCandidate(text: string): boolean {
  const digits = text.replace(/[ -]/g, "");
  return digits.length >= 13 && digits.length <= 19;
}

/**
 * scrubPii —— 确定性脱敏主入口：把文本中的手机号 / 身份证号 / 银行卡号替换为 [REDACTED_PII]。
 * 顺序：身份证（18 位）→ 银行卡（13~19 位）→ 手机号（11 位），从长到短避免二次命中。
 */
export function scrubPii(text: string): string {
  return scrubPiiDetailed(text).text;
}

/**
 * scrubPiiDetailed —— 同 scrubPii，但返回替换统计（监控面板展示"本条拦了几处 PII"用）。
 */
export function scrubPiiDetailed(text: string): PiiScrubResult {
  const stats = emptyPiiStats();
  let out = text;

  out = out.replace(ID_CARD_RE, () => {
    stats.idCard += 1;
    return REDACTED_PII;
  });

  // 先处理 4 位分组形态的银行卡（含空格 / 连字符），再处理连续长数字
  out = out.replace(BANK_CARD_GROUPED_RE, (m) => {
    if (!isBankCardCandidate(m)) return m;
    stats.bankCard += 1;
    return REDACTED_PII;
  });
  out = out.replace(BANK_CARD_RE, () => {
    stats.bankCard += 1;
    return REDACTED_PII;
  });

  out = out.replace(PHONE_RE, () => {
    stats.phone += 1;
    return REDACTED_PII;
  });

  stats.total = stats.phone + stats.idCard + stats.bankCard;
  return { text: out, stats };
}

/**
 * scrubPiiDeep —— 递归脱敏未知结构（对象 / 数组 / JSON 兼容载荷）里的所有字符串。
 * 用于工具返回值、外部文件内容等"结构未知"的响应在落监控日志前的兜底消毒。
 */
export function scrubPiiDeep(input: unknown, budget = 200): unknown {
  // 深度预算：超过层级直接截断为占位文本，防嵌套炸弹
  if (budget <= 0) return "[TRUNCATED_STRUCTURE]";
  if (typeof input === "string") return scrubPii(input);
  if (typeof input === "number" || typeof input === "boolean" || input === null) {
    return input;
  }
  if (Array.isArray(input)) {
    return input.map((item) => scrubPiiDeep(item, budget - 1));
  }
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = scrubPiiDeep(value, budget - 1);
    }
    return out;
  }
  // 函数 / symbol 等不可序列化类型：转为占位符（绝不进入监控日志）
  return "[NON_SERIALIZABLE]";
}

/** 脱敏模块自检：核心用例任一失败即抛错（供启动自检 / 测试复用） */
export function assertScrubberHealthy(): void {
  const cases: [string, boolean][] = [
    ["手机号 13812345678 请回电", true],
    ["身份证号 110101199003078515", true],
    ["身份证带 X 11010119900307851X", true],
    ["卡号 6222 0212 3456 7890", true],
    ["卡号连写 6222021234567890", true],
    ["工单 TCK-3117 与客户 CUST-8842 不是 PII", false],
    ["日期 2026-11-26 与金额 ¥52,800 不是 PII", false],
    ["审批单 AP-20261125-001 不是 PII", false],
  ];
  for (const [sample, expectRedacted] of cases) {
    const scrubbed = scrubPii(sample);
    const hit = scrubbed.includes(REDACTED_PII);
    if (hit !== expectRedacted) {
      throw new Error(
        `PII 脱敏自检失败：样本「${sample}」期望${expectRedacted ? "替换" : "保留"}，实际「${scrubbed}」`,
      );
    }
  }
}
