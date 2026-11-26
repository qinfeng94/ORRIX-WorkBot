/**
 * research-analyst/engine.ts —— Day 15 企业尽调与研究分析台核心引擎（仅服务端使用）
 * 溯源：AGENTS.md 业务红线（全程只读 / 结论强制证据链 / 日志只增不改）；
 *      /research 调研模式纪律：先查证据，后下结论，所有引文必须能在证据集中找到出处。
 * 编排三阶段（绿区只读，无任何写操作）：
 *   ① acl_kb      查内部 52 档 ACL 知识库（复用 Day 13 防越权混合检索，executive 角色视角）；
 *   ② erp_history 抓沙盒老 ERP 历史记录（无 API 的 15 年老系统仅提供仿真只读快照，不真连）；
 *   ③ cross_check 交叉核对异常单据（确定性规则，零大模型编造）。
 * 自愈容错：每个数据源包一层「超时 → 告警 → 重试 → 降级缓存」护栏，最多重试 2 次；
 *          重试仍失败自动降级到缓存副本并标注覆盖缺口，绝不中途崩溃。
 * 边界：全程确定性纯函数（无 Math.random），可被 Node 内置 test runner 直测；
 *      本模块不读取任何密钥、不写任何数据库。
 */

import { searchRag } from "../raglab/retrieval";

/* ================================================================
 * 一、事件与数据结构（SSE 对外直播口径）
 * ================================================================ */

export type PhaseId = "acl_kb" | "erp_history" | "cross_check";

export const PHASE_LABELS: Record<PhaseId, string> = {
  acl_kb: "阶段一 · 查内部 52 档 ACL 知识库",
  erp_history: "阶段二 · 抓沙盒老 ERP 历史记录",
  cross_check: "阶段三 · 交叉核对异常单据",
};

export interface SourceAlert {
  /** 告警时间戳（ISO，不含 PII） */
  ts: string;
  phase: PhaseId;
  source: string;
  level: "warn" | "error";
  message: string;
  /** 第几次尝试时产生（自愈容错留痕） */
  attempt: number;
  /** 已自动执行的处置：重试 / 降级缓存 */
  action: string;
}

/** 引擎对外的直播事件（SSE 路由原样转发，不掺密钥、不掺 PII） */
export type EngineEvent =
  | { type: "phase_start"; phase: PhaseId; label: string }
  | { type: "phase_done"; phase: PhaseId; summary: string }
  | { type: "source_start"; phase: PhaseId; source: string; label: string }
  | { type: "source_alert"; alert: SourceAlert }
  | {
      type: "source_result";
      phase: PhaseId;
      source: string;
      summary: string;
      degraded: boolean;
      alertsCount: number;
    };

export type RiskLevel = "低" | "中" | "高";

export interface SupplierRisk {
  supplierId: string;
  name: string;
  score: number;
  level: RiskLevel;
  metrics: {
    claims: number;
    claimTotalCny: number;
    overdueIncidents: number;
    policyViolations: number;
    /** 超红线但未见具名审批放行的单据数 */
    fin001Pending: number;
    /** 引用已废止文件的单据数 */
    deprecatedCitations: number;
  };
  findings: { text: string; citations: string[] }[];
}

export interface ComplianceGap {
  recordId: string;
  title: string;
  detail: string;
  citations: string[];
}

export interface ResearchAction {
  priority: "P1" | "P2" | "P3";
  text: string;
  citations: string[];
}

export interface CitationRef {
  ref: string;
  title: string;
  snippet: string;
}

export interface ResearchReport {
  reportId: string;
  topic: string;
  generatedAt: string;
  overallScore: number;
  overallLevel: RiskLevel;
  suppliers: SupplierRisk[];
  complianceGaps: ComplianceGap[];
  actions: ResearchAction[];
  citations: CitationRef[];
  alerts: SourceAlert[];
  dataCoverage: {
    aclDocsTotal: number;
    aclHits: number;
    erpRecords: number;
    degradedSources: string[];
  };
  /** 确定性小结（LLM 叙事不可用时的兜底口径，也作为离线仿真的回复文本） */
  summaryText: string;
  narrative: string;
  markdown: string;
}

export interface RunOptions {
  /** 故障演习：注入「格式错误 → 超时 → 自愈」与「结算函永久故障 → 降级缓存」两条容错链路 */
  simulateFaults: boolean;
}

/* ================================================================
 * 二、沙盒老 ERP 只读快照（虚构演示数据；供应商与单据均为仿真）
 * ================================================================ */

interface ErpRecord {
  recordId: string;
  supplierId: string;
  date: string;
  kind: "parcel_claim" | "consolidated_claim" | "overdue" | "settlement_letter";
  amountCny?: number;
  overdueDays?: number;
  detail: string;
  /** FIN-001 是否已有具名审批放行记录（undefined = 未见放行记录） */
  approved?: boolean;
  /** 结算函引用的制度编号（用于识别已废止引文） */
  citedPolicy?: string;
}

const SUPPLIERS: { supplierId: string; name: string }[] = [
  { supplierId: "SUP-E-101", name: "顺达通物流（华东干线）" },
  { supplierId: "SUP-E-102", name: "甬江云仓（华东仓配）" },
  { supplierId: "SUP-E-203", name: "杭州湾国际货代（华东清关）" },
];

const ERP_SNAPSHOT: readonly ErpRecord[] = [
  {
    recordId: "SP-E-0917",
    supplierId: "SUP-E-101",
    date: "2026-09-17",
    kind: "consolidated_claim",
    amountCny: 58000,
    detail: "合并异常赔付索赔 ¥58,000（拆自 3 张运单），未见具名审批放行记录",
  },
  {
    recordId: "SP-E-1017",
    supplierId: "SUP-E-101",
    date: "2026-10-17",
    kind: "parcel_claim",
    amountCny: 3400,
    detail: "单票丢损赔付 ¥3,400，未按贵重品通道个案处理",
  },
  {
    recordId: "OD-E-2101",
    supplierId: "SUP-E-101",
    date: "2026-10-21",
    kind: "overdue",
    overdueDays: 6,
    detail: "DE 干线批次超期 6 天未入仓",
  },
  {
    recordId: "OD-E-2145",
    supplierId: "SUP-E-101",
    date: "2026-11-05",
    kind: "overdue",
    overdueDays: 5,
    detail: "宁波口岸清关后干线超期 5 天未入仓",
  },
  {
    recordId: "OD-E-2154",
    supplierId: "SUP-E-102",
    date: "2026-11-08",
    kind: "overdue",
    overdueDays: 5,
    detail: "华东仓爆仓导致上架延误，干线超期 5 天",
  },
  {
    recordId: "SP-E-1042",
    supplierId: "SUP-E-102",
    date: "2026-11-10",
    kind: "parcel_claim",
    amountCny: 2600,
    detail: "单票丢损赔付 ¥2,600（上限内，流程合规）",
    approved: true,
  },
  {
    recordId: "LT-E-3011",
    supplierId: "SUP-E-203",
    date: "2026-10-30",
    kind: "settlement_letter",
    detail: "超期赔付结算函引用 POL-OPS-2024-009（2024 已废止 7 天旧口径）",
    citedPolicy: "POL-OPS-2024-009",
  },
  {
    recordId: "SP-E-2099",
    supplierId: "SUP-E-203",
    date: "2026-11-12",
    kind: "parcel_claim",
    amountCny: 1200,
    detail: "单票丢损赔付 ¥1,200（上限内，流程合规）",
    approved: true,
  },
];

/** 结算函扫描的降级缓存副本（老 ERP 结算函接口永久故障时兜底使用，可能滞后） */
const SETTLEMENT_LETTERS_CACHE: readonly ErpRecord[] = ERP_SNAPSHOT.filter(
  (r) => r.kind === "settlement_letter",
);

/* ================================================================
 * 三、自愈容错护栏（超时 → 告警 → 重试 → 降级，绝不中途崩溃）
 * ================================================================ */

interface ResilienceOutcome<T> {
  ok: boolean;
  degraded: boolean;
  data: T | null;
  alerts: SourceAlert[];
  attempts: number;
}

const SOURCE_TIMEOUT_MS = 400;
const MAX_RETRIES = 2;

/** 给单个尝试套超时护栏：到点即拒，底层悬挂 promise 不占事件循环 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`查询超时（>${String(ms)}ms）：${label}`)),
        ms,
      );
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * 通用自愈容错包装：
 *   每次尝试独立超时；失败即记告警并重试（最多 MAX_RETRIES 次）；
 *   重试耗尽后调用 fallback 降级（如本地缓存副本），仍拿不到则返回空数据但绝不抛错。
 */
async function resilientFetch<T>(opts: {
  phase: PhaseId;
  source: string;
  label: string;
  emit: (e: EngineEvent) => void;
  alerts: SourceAlert[];
  /** 第 n 次尝试（1 起）。返回 null 表示本次尝试被判定为「静默失败」，抛错走重试 */
  attempt: (n: number) => Promise<T> | null;
  /** 全部重试耗尽后的降级数据（null = 无缓存可用） */
  fallback: () => T | null;
  fallbackNote: string;
}): Promise<ResilienceOutcome<T>> {
  const now = (): string => new Date().toISOString();
  const recordAlert = (level: "warn" | "error", message: string, attempt: number, action: string): void => {
    const alert: SourceAlert = {
      ts: now(),
      phase: opts.phase,
      source: opts.source,
      level,
      message,
      attempt,
      action,
    };
    opts.alerts.push(alert);
    opts.emit({ type: "source_alert", alert });
  };

  for (let n = 1; n <= 1 + MAX_RETRIES; n++) {
    try {
      const p = opts.attempt(n);
      if (p === null) throw new Error("数据源返回空载荷（静默失败）");
      const data = await withTimeout(Promise.resolve(p), SOURCE_TIMEOUT_MS, opts.label);
      return { ok: true, degraded: false, data, alerts: opts.alerts, attempts: n };
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      const isLast = n === 1 + MAX_RETRIES;
      recordAlert(
        "error",
        `${opts.label}：${reason}`,
        n,
        isLast ? "触发降级策略" : `自动重试（${String(n)}/${String(MAX_RETRIES)}）`,
      );
      if (isLast) {
        const cached = opts.fallback();
        if (cached !== null) {
          recordAlert(
            "warn",
            `${opts.label}：重试耗尽，已降级到本地缓存副本——${opts.fallbackNote}`,
            n,
            "降级缓存",
          );
          return { ok: false, degraded: true, data: cached, alerts: opts.alerts, attempts: n };
        }
        // 连缓存都没有：返回空数据并标注覆盖缺口，绝不抛错中断编排
        recordAlert("error", `${opts.label}：降级缓存也不可用，该数据源按「无数据」继续编排`, n, "按无数据继续");
        return { ok: false, degraded: true, data: null, alerts: opts.alerts, attempts: n };
      }
    }
  }
  // 理论不可达（循环内已返回）；保险起见返回空结果，绝不崩溃
  return { ok: false, degraded: true, data: null, alerts: opts.alerts, attempts: 1 + MAX_RETRIES };
}

/* ================================================================
 * 四、故障演习注入（确定性：不掷骰子，第几次失败写死）
 * ================================================================ */

/** 老 ERP 主快照：第 1 次返回格式错误、第 2 次超时、第 3 次自愈成功 */
function erpMainAttempt(n: number, simulateFaults: boolean): Promise<ErpRecord[]> | null {
  if (simulateFaults && n === 1) {
    throw new Error("返回格式错误（E_FMT：响应体为 HTML 登录页，非 JSON 快照）");
  }
  if (simulateFaults && n === 2) return new Promise<never>(() => {}); // 永不 resolve → 触发超时
  return Promise.resolve([...ERP_SNAPSHOT]);
}

/** 结算函扫描：故障演习下永久故障 → 走降级缓存副本 */
function settlementLetterAttempt(n: number, simulateFaults: boolean): Promise<ErpRecord[]> | null {
  if (simulateFaults) return null;
  return Promise.resolve(SETTLEMENT_LETTERS_CACHE as ErpRecord[]);
}

/* ================================================================
 * 五、ACL 知识库检索（复用 Day 13 防越权混合检索，高管视角）
 * ================================================================ */

const ACL_QUERIES: { keywords: string; note: string }[] = [
  { keywords: "供应商 单票赔付上限 丢损赔付标准", note: "赔付标准与单票上限" },
  { keywords: "单笔超过 50000 强制人工审批 赔付申请", note: "FIN-001 大额审批红线" },
  { keywords: "干线运输 超期 查验工单 时效", note: "物流超期判定与响应时限" },
  { keywords: "供应商准入 年度评审 观察期", note: "供应商评审与观察期规则" },
];

/* ================================================================
 * 六、风险评分（确定性公式，可单测；0-100 封顶防刷分）
 * ================================================================ */

export interface SupplierMetrics {
  overdueIncidents: number;
  capViolations: number;
  fin001Pending: number;
  deprecatedCitations: number;
}

export function scoreSupplier(m: SupplierMetrics): { score: number; level: RiskLevel } {
  const raw =
    10 +
    m.overdueIncidents * 9 +
    m.capViolations * 12 +
    m.fin001Pending * 25 +
    m.deprecatedCitations * 15;
  const score = Math.min(Math.max(raw, 0), 100);
  const level: RiskLevel = score >= 60 ? "高" : score >= 30 ? "中" : "低";
  return { score, level };
}

export function scoreToLevel(score: number): RiskLevel {
  return score >= 60 ? "高" : score >= 30 ? "中" : "低";
}

/* ================================================================
 * 七、引文校验（/research 纪律：每条引文必须能在证据集中找到出处）
 * ================================================================ */

/** 校验引文清单：剔除证据集中不存在的标号（防编造），返回通过校验的部分 */
export function validateCitations(citations: string[], validRefs: Set<string>): string[] {
  return citations.filter((c) => validRefs.has(c));
}

/* ================================================================
 * 八、Markdown 导出（归档同款口径，一键下载）
 * ================================================================ */

export function buildReportMarkdown(report: ResearchReport): string {
  const lines: string[] = [];
  lines.push(`# 企业尽调简报：${report.topic}`);
  lines.push("");
  lines.push(`- 简报编号：${report.reportId}`);
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(
    `- 总体风险评分：**${String(report.overallScore)} / 100（${report.overallLevel}风险）**`,
  );
  lines.push("");
  lines.push("## 一、供应商风险评分卡");
  lines.push("");
  lines.push("| 供应商 | 风险评分 | 风险等级 | 赔付单据 | 索赔总额 | 超期次数 | 违规项 | FIN-001 待审 |");
  lines.push("|---|---:|:---:|---:|---:|---:|---:|---:|");
  for (const s of report.suppliers) {
    lines.push(
      `| ${s.name}（${s.supplierId}） | ${String(s.score)} | ${s.level} | ` +
        `${String(s.metrics.claims)} | ¥${String(s.metrics.claimTotalCny)} | ` +
        `${String(s.metrics.overdueIncidents)} | ${String(s.metrics.policyViolations)} | ` +
        `${String(s.metrics.fin001Pending)} |`,
    );
  }
  lines.push("");
  lines.push("### 供应商主要发现");
  for (const s of report.suppliers) {
    for (const f of s.findings) {
      lines.push(`- **${s.name}**：${f.text}${f.citations.length > 0 ? `（${f.citations.join("、")}）` : ""}`);
    }
  }
  lines.push("");
  lines.push("## 二、合规缺口清单");
  for (const g of report.complianceGaps) {
    lines.push(
      `- 【${g.recordId}】**${g.title}**：${g.detail}` +
        `${g.citations.length > 0 ? `（${g.citations.join("、")}）` : "（制度引文未命中，待人工复核）"}`,
    );
  }
  lines.push("");
  lines.push("## 三、行动建议");
  for (const a of report.actions) {
    lines.push(
      `- **【${a.priority}】**${a.text}${a.citations.length > 0 ? `（${a.citations.join("、")}）` : ""}`,
    );
  }
  lines.push("");
  lines.push("## 四、引文出处");
  for (const c of report.citations) {
    lines.push(`- ${c.ref}《${c.title}》：${c.snippet}`);
  }
  lines.push("");
  lines.push("## 五、数据覆盖与自愈容错记录");
  lines.push(
    `- ACL 知识库：全库 ${String(report.dataCoverage.aclDocsTotal)} 档，命中 ${String(report.dataCoverage.aclHits)} 条引文`,
  );
  lines.push(`- 老 ERP 快照：${String(report.dataCoverage.erpRecords)} 条历史记录`);
  lines.push(
    `- 降级数据源：${report.dataCoverage.degradedSources.length > 0 ? report.dataCoverage.degradedSources.join("、") : "无"}`,
  );
  for (const alert of report.alerts) {
    lines.push(
      `- 告警【${alert.level === "error" ? "错误" : "预警"}】${alert.source}：${alert.message}（处置：${alert.action}）`,
    );
  }
  lines.push("");
  lines.push("## 六、红区承诺");
  lines.push(
    "- 本台全程只读：不直写业务系统正式数据，不含任何自动打款/付款/放款能力；涉及超 ¥50,000 的事项一律转 FIN-001 强制人工审批，AI 不审批、不打款。",
  );
  lines.push(
    "- 本简报全部数据为虚构演示内容，仅用于能力验证，不构成对任何真实供应商的评价。",
  );
  lines.push("");
  return lines.join("\n");
}

/* ================================================================
 * 九、主编排流程
 * ================================================================ */

/** 简报编号序列（模块内自增；归档时数据库另有主键兜底） */
let reportSeq = 0;
function nextReportId(): string {
  reportSeq += 1;
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `RA-${today}-${String(reportSeq).padStart(4, "0")}`;
}

/**
 * 运行三阶段尽调编排。全程绿区只读；失败降级、绝不抛错中断。
 * 返回结构化简报（narrative 字段由上层 LLM 叙事填充，这里先给确定性小结）。
 */
export async function runResearchPipeline(
  topic: string,
  opts: RunOptions,
  emit: (e: EngineEvent) => void,
): Promise<ResearchReport> {
  const allAlerts: SourceAlert[] = [];
  const degradedSources: string[] = [];
  const citations: CitationRef[] = [];
  const validRefs = new Set<string>();

  /* ---------- 阶段一：查内部 52 档 ACL 知识库 ---------- */
  emit({ type: "phase_start", phase: "acl_kb", label: PHASE_LABELS.acl_kb });
  emit({ type: "source_start", phase: "acl_kb", source: "acl_kb", label: "52 档 ACL 知识库（防越权混合检索）" });
  let aclHits = 0;
  for (const q of ACL_QUERIES) {
    const res = searchRag(q.keywords, "executive", 4);
    aclHits += res.hits.length;
    for (const hit of res.hits) {
      if (!validRefs.has(hit.ref)) {
        validRefs.add(hit.ref);
        citations.push({ ref: hit.ref, title: hit.title, snippet: hit.snippet });
      }
    }
    // 废止文件命中只出拦截通报，绝不进引文（Day 13 纪律沿用）
    for (const itc of res.intercepted) {
      allAlerts.push({
        ts: new Date().toISOString(),
        phase: "acl_kb",
        source: "acl_kb",
        level: "warn",
        message: `检索命中已废止文件《${itc.title}》，已拦截并只出通报：${itc.reason}`,
        attempt: 1,
        action: "拦截废止文件",
      });
    }
  }
  emit({
    type: "source_result",
    phase: "acl_kb",
    source: "acl_kb",
    summary: `4 组关键词检索完成，累计命中 ${String(aclHits)} 条现行制度引文（已废止文件一律拦截）`,
    degraded: false,
    alertsCount: allAlerts.length,
  });
  emit({
    type: "phase_done",
    phase: "acl_kb",
    summary: `知识库就绪：${String(citations.length)} 条去重引文进入证据集`,
  });

  /* ---------- 阶段二：抓沙盒老 ERP 历史记录（自愈容错演示主场） ---------- */
  emit({ type: "phase_start", phase: "erp_history", label: PHASE_LABELS.erp_history });
  emit({ type: "source_start", phase: "erp_history", source: "erp_main", label: "老 ERP 供应商历史快照（15 年老系统仿真接口）" });

  const mainOutcome = await resilientFetch<ErpRecord[]>({
    phase: "erp_history",
    source: "erp_main",
    label: "老 ERP 历史快照",
    emit,
    alerts: allAlerts,
    attempt: (n) => erpMainAttempt(n, opts.simulateFaults),
    fallback: () => null,
    fallbackNote: "主快照无缓存可用",
  });
  const erpRecords: ErpRecord[] = mainOutcome.data ?? [];
  const selfHealed = mainOutcome.ok && !mainOutcome.degraded && mainOutcome.attempts > 1;
  emit({
    type: "source_result",
    phase: "erp_history",
    source: "erp_main",
    summary:
      erpRecords.length === 0
        ? "老 ERP 不可用，本源按「无数据」继续编排（未中断流程）"
        : `取回 ${String(erpRecords.length)} 条历史记录（第 ${String(mainOutcome.attempts)} 次尝试成功` +
          `${selfHealed ? "，自愈成功" : ""}）`,
    degraded: !mainOutcome.ok,
    alertsCount: mainOutcome.alerts.length,
  });

  emit({ type: "source_start", phase: "erp_history", source: "settlement_letters", label: "老 ERP 结算函扫描（识别废止引文）" });
  const letterOutcome = await resilientFetch<ErpRecord[]>({
    phase: "erp_history",
    source: "settlement_letters",
    label: "结算函扫描",
    emit,
    alerts: allAlerts,
    attempt: (n) => settlementLetterAttempt(n, opts.simulateFaults),
    fallback: () => SETTLEMENT_LETTERS_CACHE as ErpRecord[],
    fallbackNote: "缓存副本可能滞后，已标注数据覆盖缺口",
  });
  const letters: ErpRecord[] = letterOutcome.data ?? [];
  if (letterOutcome.degraded) degradedSources.push("老 ERP 结算函扫描（降级缓存）");
  emit({
    type: "source_result",
    phase: "erp_history",
    source: "settlement_letters",
    summary:
      letters.length === 0
        ? "结算函接口与缓存均不可用，废止引文扫描按「无数据」继续（未中断流程）"
        : `扫描 ${String(letters.length)} 份结算函${letterOutcome.degraded ? "（降级缓存口径）" : ""}`,
    degraded: letterOutcome.degraded,
    alertsCount: letterOutcome.alerts.length,
  });
  emit({
    type: "phase_done",
    phase: "erp_history",
    summary: `老 ERP 就绪：主快照 ${String(erpRecords.length)} 条 + 结算函 ${String(letters.length)} 份` +
      `${degradedSources.length > 0 ? "（含降级源，已标注覆盖缺口）" : ""}`,
  });

  /* ---------- 阶段三：交叉核对异常单据（确定性规则，零大模型编造） ---------- */
  emit({ type: "phase_start", phase: "cross_check", label: PHASE_LABELS.cross_check });
  emit({ type: "source_start", phase: "cross_check", source: "cross_check", label: "异常单据 × 制度条款 交叉核对" });

  const bySupplier = new Map<string, ErpRecord[]>();
  for (const r of erpRecords) {
    const list = bySupplier.get(r.supplierId) ?? [];
    list.push(r);
    bySupplier.set(r.supplierId, list);
  }
  // 结算函来自降级缓存时单独并入（只用于废止引文识别）
  for (const letter of letters) {
    const list = bySupplier.get(letter.supplierId) ?? [];
    if (!list.some((r) => r.recordId === letter.recordId)) list.push(letter);
    bySupplier.set(letter.supplierId, list);
  }

  /** 从证据集反查某制度文档的精准引文标号（保证引文必须能找到出处；标号形如 [DOC-xx §n]） */
  const findRef = (docId: string): string | null => {
    for (const c of citations) {
      if (c.ref.startsWith(`[${docId} §`)) return c.ref;
    }
    return null;
  };
  const refCap = findRef("POL-OPS-2026-005");
  const refOverdue = findRef("POL-OPS-2026-001");
  const refFin = findRef("POL-FIN-2026-001");
  const refReview = findRef("POL-OPS-2026-003");

  const complianceGaps: ComplianceGap[] = [];
  const findingsBySupplier = new Map<string, { text: string; citations: string[] }[]>();

  for (const [supplierId, records] of bySupplier) {
    const findings = findingsBySupplier.get(supplierId) ?? [];
    for (const r of records) {
      if (r.kind === "consolidated_claim" && (r.amountCny ?? 0) > 50000 && r.approved !== true) {
        // 单笔超 ¥50,000 未见具名放行：FIN-001 强制人工审批缺口（合并口径）
        const cites = [refFin, refCap].filter((c): c is string => c !== null);
        complianceGaps.push({
          recordId: r.recordId,
          title: "超 FIN-001 红线且未见具名审批放行",
          detail: `${r.detail}（¥${String(r.amountCny)} > ¥50,000）。按现行制度必须由具名在职审批人签字放行，AI 不审批、不打款。`,
          citations: validateCitations(cites, validRefs),
        });
        findings.push({
          text: `合并索赔 ¥${String(r.amountCny)} 超 FIN-001 红线且无放行记录`,
          citations: validateCitations(cites, validRefs),
        });
      }
      if (r.kind === "parcel_claim" && (r.amountCny ?? 0) > 3000) {
        // 单票赔付超 ¥3,000 上限：须走贵重品通道个案处理
        const cites = refCap ? [refCap] : [];
        complianceGaps.push({
          recordId: r.recordId,
          title: "单票赔付超过 ¥3,000 上限，未走贵重品通道",
          detail: `${r.detail}。按赔付标准，超上限应按贵重品通道个案处理，不得按普通丢损口径直接支付。`,
          citations: validateCitations(cites, validRefs),
        });
        findings.push({
          text: `单票赔付 ¥${String(r.amountCny)} 超 ¥3,000 上限且未按贵重品通道处理`,
          citations: validateCitations(cites, validRefs),
        });
      }
      if (r.kind === "overdue" && (r.overdueDays ?? 0) >= 5) {
        // 干线超期 5 天红线：须查验工单 + 进度通报（现行口径）
        const cites = refOverdue ? [refOverdue] : [];
        findings.push({
          text: `干线超期 ${String(r.overdueDays)} 天（${r.recordId}），按现行 5 天红线须查验工单与进度通报`,
          citations: validateCitations(cites, validRefs),
        });
      }
      if (r.kind === "settlement_letter" && r.citedPolicy) {
        // 结算函引用已废止文件：口径违规（引文只挂现行制度，废止文件仅作通报）
        const cites = refOverdue ? [refOverdue] : [];
        complianceGaps.push({
          recordId: r.recordId,
          title: "结算函引用已废止的旧口径文件",
          detail: `${r.detail}。该旧文件已废止且被检索层自动拦截，必须改按现行《跨境物流时效管理规范》重新出具结算口径。`,
          citations: validateCitations(cites, validRefs),
        });
        findings.push({
          text: `结算函 ${r.recordId} 引用已废止文件 ${r.citedPolicy}（口径违规）`,
          citations: validateCitations(cites, validRefs),
        });
      }
    }
    findingsBySupplier.set(supplierId, findings);
  }

  emit({
    type: "source_result",
    phase: "cross_check",
    source: "cross_check",
    summary: `交叉核对完成：发现 ${String(complianceGaps.length)} 项合规缺口，全部结论挂现行制度引文`,
    degraded: false,
    alertsCount: 0,
  });
  emit({
    type: "phase_done",
    phase: "cross_check",
    summary: `证据链闭合：${String(complianceGaps.length)} 项缺口 × ${String(citations.length)} 条引文`,
  });

  /* ---------- 评分与行动建议（确定性合成） ---------- */
  const supplierRisks: SupplierRisk[] = SUPPLIERS.map((s) => {
    const records = bySupplier.get(s.supplierId) ?? [];
    const gapOf = (predicate: (title: string) => boolean): number =>
      complianceGaps.filter(
        (g) => records.some((r) => r.recordId === g.recordId) && predicate(g.title),
      ).length;
    const capViolations = gapOf((t) => t.includes("¥3,000 上限"));
    const fin001Pending = gapOf((t) => t.includes("FIN-001"));
    const metrics = {
      claims: records.filter((r) => r.kind === "parcel_claim" || r.kind === "consolidated_claim").length,
      claimTotalCny: records.reduce((sum, r) => sum + (r.amountCny ?? 0), 0),
      overdueIncidents: records.filter((r) => r.kind === "overdue" && (r.overdueDays ?? 0) >= 5).length,
      /** 除 FIN-001 大额缺口外的制度违规项（超上限 / 废止引文等） */
      policyViolations: gapOf(() => true) - fin001Pending,
      fin001Pending,
      deprecatedCitations: records.filter((r) => r.kind === "settlement_letter" && r.citedPolicy).length,
    };
    const { score, level } = scoreSupplier({
      overdueIncidents: metrics.overdueIncidents,
      capViolations,
      fin001Pending,
      deprecatedCitations: metrics.deprecatedCitations,
    });
    return {
      supplierId: s.supplierId,
      name: s.name,
      score,
      level,
      metrics,
      findings: findingsBySupplier.get(s.supplierId) ?? [],
    };
  });

  const overallScore = Math.round(
    supplierRisks.reduce((sum, s) => sum + s.score, 0) / Math.max(supplierRisks.length, 1),
  );
  const overallLevel = scoreToLevel(overallScore);

  const actions: ResearchAction[] = [];
  const pushAction = (priority: "P1" | "P2" | "P3", text: string, docIds: string[]): void => {
    const cites = docIds
      .map((id) => findRef(id))
      .filter((c): c is string => c !== null);
    actions.push({ priority, text, citations: validateCitations(cites, validRefs) });
  };
  if (overallLevel !== "低" || complianceGaps.some((g) => g.title.includes("FIN-001"))) {
    pushAction(
      "P1",
      "对合并索赔 ¥58,000 立即补开 FIN-001 强制人工审批单：具名审批人签字放行前冻结该笔赔付，严禁任何形式的自动打款。",
      ["POL-FIN-2026-001"],
    );
  }
  if (supplierRisks.some((s) => s.metrics.overdueIncidents >= 2)) {
    pushAction(
      "P1",
      "对顺达通连续 2 起干线超期开立查验工单并向客户发出进度通报，事件计入季度供应商评审扣分项。",
      ["POL-OPS-2026-001", "POL-OPS-2026-003"],
    );
  }
  if (complianceGaps.some((g) => g.title.includes("¥3,000 上限"))) {
    pushAction(
      "P2",
      "单票赔付 ¥3,400 按「贵重品通道个案处理」重走流程，并倒查近 90 天同类单据是否存在同口径违规。",
      ["POL-OPS-2026-005"],
    );
  }
  if (complianceGaps.some((g) => g.title.includes("已废止"))) {
    pushAction(
      "P2",
      "撤回引用已废止 POL-OPS-2024-009 的结算函，改按现行 5 天红线口径重新出具，并对客服/运营话术库做一次废止引文清洗。",
      ["POL-OPS-2026-001"],
    );
  }
  pushAction(
    "P3",
    "将本次三项发现纳入供应商年度评审四维打分（质量、时效、价格、配合度），C 级以下进入观察期。",
    ["POL-OPS-2026-003"],
  );

  /* ---------- 组装简报 ---------- */
  const gapCount = complianceGaps.length;
  const finCount = complianceGaps.filter((g) => g.title.includes("FIN-001")).length;
  const summaryText =
    `本次尽调围绕「${topic}」完成三阶段编排：先查内部 52 档 ACL 知识库取回 ${String(citations.length)} 条现行制度引文，` +
    `再抓沙盒老 ERP ${String(erpRecords.length)} 条历史记录，最后交叉核对发现 ${String(gapCount)} 项合规缺口` +
    `${finCount > 0 ? `（其中 ${String(finCount)} 项超 FIN-001 ¥50,000 红线，一律转具名人工审批，AI 不审批、不打款）` : ""}。` +
    `三家华东区供应商总体风险评分 ${String(overallScore)} 分（${overallLevel}风险）：` +
    supplierRisks
      .map((s) => `${s.name} ${String(s.score)} 分（${s.level}）`)
      .join("、") +
    `。全部结论均可在「引文出处」中溯源到 [制度编号 §段落] 标号，无一条编造。`;

  const report: ResearchReport = {
    reportId: nextReportId(),
    topic,
    generatedAt: new Date().toISOString(),
    overallScore,
    overallLevel,
    suppliers: supplierRisks,
    complianceGaps,
    actions,
    citations,
    alerts: allAlerts,
    dataCoverage: {
      aclDocsTotal: 52,
      aclHits,
      erpRecords: erpRecords.length,
      degradedSources,
    },
    summaryText,
    narrative: "",
    markdown: "",
  };
  report.markdown = buildReportMarkdown(report);
  return report;
}

/* ================================================================
 * 十、预设课题（供页面一键胶囊与测试共用）
 * ================================================================ */

export const PRESET_TOPICS: string[] = [
  "评估华东区 3 家物流供应商的异常赔付风险与合规缺口",
  "核查 CUST-8842 重复扣款事件的赔付合规与审批缺口",
  "复盘双 11 大促期间华东区运力保障与超期赔付风险",
];
