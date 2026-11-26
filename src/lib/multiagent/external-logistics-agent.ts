/**
 * external-logistics-agent.ts —— 外部华东物流 A2A 代理（本项目内独立仿真，仅限服务端使用）
 * 溯源：04 号文档 CISO 条款 5（跨组织外部内容一律按「资料」隔离，验真结论只上报、不执行任何动作）；
 *      AGENTS.md 代码红线 2（令牌不硬编码：优先 .env.local，缺省仅提供演示仿真令牌，非生产密钥）。
 * 设计：
 * - 这是「外部组织」的服务端仿真：注册表、验真逻辑、A2A 名片都在这里，绝不 import 主项目业务模块；
 * - 内置演示注册表：EWB:99812 为真、EWB:00000 为伪造，其余编号一律「查无此单」；
 * - 令牌：生产从 EXTERNAL_LOGISTICS_A2A_TOKEN 读取；两端（客户端 / 外部代理）共用同一解析函数，
 *   离线演示无 .env.local 时回退到同一演示令牌，保证开箱可跑。
 */

/* ================================================================
 * 一、Bearer 令牌（生产走环境变量；演示缺省令牌仅为离线仿真，非密钥）
 * ================================================================ */

/** 离线演示令牌（仿真沙盒内两端共用；生产部署必须在 .env.local 配置真实令牌覆盖它） */
export const DEMO_A2A_BEARER_TOKEN = "ewb-a2a-demo-token-2026";

/** 统一解析 Bearer 令牌：环境变量优先，缺省回退演示令牌（两端一致才能握手成功） */
export function resolveA2aBearerToken(): string {
  return process.env.EXTERNAL_LOGISTICS_A2A_TOKEN ?? DEMO_A2A_BEARER_TOKEN;
}

/* ================================================================
 * 二、承运商运单注册表（内置演示数据，全部虚构）
 * ================================================================ */

export interface EwbRecord {
  verdict: "genuine" | "forged";
  carrier: string;
  route: string;
  receiptNo: string;
  /** 承运商存档的开票金额（元） */
  invoicedCny: number;
}

/** 演示注册表：仅登记 EWB:99812（真）与 EWB:00000（伪造）；查无编号一律 unregistered */
export const EWB_REGISTRY: Readonly<Record<string, EwbRecord>> = {
  "99812": {
    verdict: "genuine",
    carrier: "华东干线物流（仿真承运商）",
    route: "上海仓 → 杭州华东分拨",
    receiptNo: "RCPT-EWB-99812（承运商存档回单）",
    invoicedCny: 6800,
  },
  "00000": {
    verdict: "forged",
    carrier: "—",
    route: "—",
    receiptNo: "—",
    invoicedCny: 0,
  },
};

export type EwbVerdict = "genuine" | "forged" | "unregistered";

export interface EwbVerifyOutcome {
  ewbId: string;
  verdict: EwbVerdict;
  record: EwbRecord | null;
  checkedAt: string;
}

/** 从「EWB:99812」等写法归一化出纯数字编号（全角冒号与空白都容忍） */
export function normalizeEwbId(raw: string): string | null {
  const m = raw.trim().match(/^EWB[:：]?\s*(\d{3,8})$/);
  return m ? m[1] : null;
}

/** 外部代理的核心验真逻辑（确定性规则，查注册表，绝不编造） */
export function verifyEwb(rawEwbId: string): EwbVerifyOutcome {
  const normalized = normalizeEwbId(rawEwbId);
  if (normalized === null) {
    return {
      ewbId: rawEwbId,
      verdict: "unregistered",
      record: null,
      checkedAt: new Date().toISOString(),
    };
  }
  const record = EWB_REGISTRY[normalized] ?? null;
  return {
    ewbId: `EWB:${normalized}`,
    verdict: record ? record.verdict : "unregistered",
    record,
    checkedAt: new Date().toISOString(),
  };
}

/* ================================================================
 * 三、A2A Agent 名片（.well-known/agent.json）
 * ================================================================ */

/** 组装 A2A Agent 名片（baseOrigin 用于拼出任务端点绝对地址） */
export function buildAgentCard(baseOrigin: string): Record<string, unknown> {
  return {
    name: "华东物流 A2A 验真代理",
    description:
      "外部华东物流承运商的跨组织验真代理（本项目内独立仿真）。提供 EWB 电子运单编号真伪核验任务；" +
      "验真结论仅作为「资料」返回给调用方，不执行任何业务动作。",
    protocol: "A2A/1.0",
    version: "1.0.0",
    url: `${baseOrigin}/api/external-logistics/a2a/tasks`,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      tasks: ["verify_ewb"],
    },
    securitySchemes: {
      bearer: { type: "http", scheme: "bearer" },
    },
    security: [{ bearer: [] }],
    provider: {
      organization: "华东干线物流（仿真承运商 · 演示数据全部虚构）",
      url: `${baseOrigin}/api/external-logistics/.well-known/agent.json`,
    },
    skills: [
      {
        id: "verify_ewb",
        name: "运单验真",
        description:
          "核验 EWB 电子运单编号真伪（内置演示注册表：EWB:99812 为真、EWB:00000 为伪造，查无编号返回 unregistered）",
      },
    ],
    "x-demo-note": "本代理为 WorkBot A2A 跨组织协作教学仿真，所有数据虚构，无真实承运商接入。",
  };
}
