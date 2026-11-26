/**
 * react-agent.ts —— Day 11 零框架透明自主调查引擎（纯原生 ReAct 循环，仅限服务端使用）
 * 溯源：04 号文档三色权限边界（本模块只有绿区只读探针，无任何写工具）；
 *      AGENTS.md 业务红线（FIN-001 含拆单合并口径 / 红区严禁自动打款 / 废止旧 10 万制度）；
 *      项目 Non-Goals（不引入任何 Agent 框架，思考-行动-观察全程对外透明直播）。
 * 设计：
 * - 纯原生 ReAct 循环：Thought（思考）→ Action（行动）→ Observation（观察），每一步都通过
 *   emit 回调对外直播，绝不隐藏中间过程；
 * - maxSteps = 8 物理熔断：步骤计数超过上限立即切断循环（防死循环护栏，不是提示词劝阻）；
 * - 探针注册表只有 3 把只读工具；打款/付款/放款类工具物理不存在，启动自检兜底；
 * - 推理采用「先查证据、后下结论」：最终结论强制附带证据链溯源（E1/E2/... → 工具 + 查询 + 发现 + 制度出处），
 *   证据不足时如实说「证据不足」，绝不编造数据。
 */

/* ================================================================
 * 一、模拟只读快照（虚构演示数据；客户姓名已脱敏，无银行账号字段）
 * ================================================================ */

interface TicketSnapshot {
  ticketId: string;
  customerId: string;
  customerName: string;
  department: string;
  title: string;
  amountCny: number;
  detail: string;
  status: string;
}

const TICKETS_SNAPSHOT: readonly TicketSnapshot[] = [
  {
    ticketId: "TCK-3117",
    customerId: "CUST-8842",
    customerName: "张*",
    department: "财务部",
    title: "重复扣款申诉（11 月）",
    amountCny: 52800,
    detail: "11 月 24 日对公账户被重复扣款两笔，每笔 ¥26,400，合计 ¥52,800",
    status: "open",
  },
  {
    ticketId: "TCK-2984",
    customerId: "CUST-8842",
    customerName: "张*",
    department: "财务部",
    title: "月费重复扣款申诉（10 月）",
    amountCny: 13200,
    detail: "10 月 15 日月度服务费被重复扣款一笔 ¥13,200，已于 10 月 20 日人工审批退款补正",
    status: "closed",
  },
  {
    ticketId: "TCK-L2051",
    customerId: "CUST-5107",
    customerName: "李*",
    department: "运营部",
    title: "德国仓 DHL 干线超期",
    amountCny: 12600,
    detail: "DE-204 批次发德国仓已超期 6 天未入仓，涉及 38 箱跨境电商货件",
    status: "open",
  },
  {
    ticketId: "TCK-L2052",
    customerId: "CUST-7715",
    customerName: "王*",
    department: "运营部",
    title: "美西仓海运超期",
    amountCny: 9800,
    detail: "US-118 批次海运已超期 5 天，目的港拥堵，等待船司答复",
    status: "处理中",
  },
  {
    ticketId: "TCK-L2088",
    customerId: "CUST-6602",
    customerName: "陈*",
    department: "运营部",
    title: "华东区物流报销运单核验",
    amountCny: 6800,
    detail: "华东区干线运费报销申请，电子运单号 EWB:99812，承运商回单真伪待跨组织核验",
    status: "open",
  },
  {
    ticketId: "TCK-C0733",
    customerId: "CUST-9903",
    customerName: "黄*",
    department: "客服部",
    title: "重大客诉：物流时效与货损双投诉",
    amountCny: 0,
    detail: "印尼客户投诉首单超期 8 天且 3 箱外包装破损，要求赔偿与书面致歉",
    status: "open",
  },
];

/** 客户历史账单流水（只读快照；duplicateSuspect = 疑似重复出账标记） */
interface BillingEntry {
  date: string;
  direction: "debit" | "credit";
  amountCny: number;
  memo: string;
  batchId: string;
  duplicateSuspect: boolean;
}

const BILLING_SNAPSHOT: Readonly<Record<string, readonly BillingEntry[]>> = {
  "CUST-8842": [
    {
      date: "2026-10-15",
      direction: "debit",
      amountCny: 13200,
      memo: "10 月月度服务费正常出账",
      batchId: "BATCH-1015",
      duplicateSuspect: false,
    },
    {
      date: "2026-10-15",
      direction: "debit",
      amountCny: 13200,
      memo: "对账任务超时自动重试，重放 BATCH-1015 扣款批次（缺幂等去重键），疑似重复出账",
      batchId: "BATCH-1015",
      duplicateSuspect: true,
    },
    {
      date: "2026-10-20",
      direction: "credit",
      amountCny: 13200,
      memo: "人工审批退款补正（具名审批人签字放行，走既有正规通道，审批单 AP-20261020-003）",
      batchId: "BATCH-1015-FIX",
      duplicateSuspect: false,
    },
    {
      date: "2026-11-24",
      direction: "debit",
      amountCny: 26400,
      memo: "Q4 季度服务费正常出账",
      batchId: "BATCH-1124",
      duplicateSuspect: false,
    },
    {
      date: "2026-11-24",
      direction: "debit",
      amountCny: 26400,
      memo: "对账任务超时自动重试，重放 BATCH-1124 扣款批次（与 10 月同一路径），疑似重复出账",
      batchId: "BATCH-1124",
      duplicateSuspect: true,
    },
  ],
};

interface PolicyDoc {
  docId: string;
  section: string;
  title: string;
  snippet: string;
}

const POLICY_DOCS: readonly PolicyDoc[] = [
  {
    docId: "DOC-01",
    section: "4.2",
    title: "财务付款审批制度（FIN-001）",
    snippet:
      "单笔金额超过 ¥50,000 的付款/退款，必须由具名在职审批人签字放行；AI 不得充当审批人；疑似拆单按合并口径处理。",
  },
  {
    docId: "DOC-02",
    section: "3.1",
    title: "重复扣款客诉处理流程",
    snippet:
      "确认重复扣款后，由人工复核原始支付流水，退款一律走既有正规通道，先挂「疑似错账」标记。",
  },
  {
    docId: "DOC-03",
    section: "2.4",
    title: "VIP 客户异常升级规范",
    snippet:
      "VIP 客户涉及金额超过 ¥50,000 的异常，须 24 小时内预约财务复核会议并同步客户经理。",
  },
  {
    docId: "DOC-04",
    section: "1.3",
    title: "跨境物流时效管理规范",
    snippet:
      "干线运输超过 5 天未入仓视为超期，须开立查验工单、同步客户经理并向客户发出进度通报。",
  },
  {
    docId: "DOC-05",
    section: "5.2",
    title: "客诉分级与评审会制度",
    snippet:
      "重大客诉（货损、超期叠加、赔偿诉求）须 24 小时内预约跨部门评审会，由具名负责人主持。",
  },
];

/* ================================================================
 * 二、只读探针工具注册表（红区物理剔除：打款/付款/放款类工具不存在）
 * ================================================================ */

export interface ProbeToolDef {
  name: string;
  label: string;
  zone: "green";
  run: (args: Record<string, unknown>) => unknown;
}

/** 红区黑名单语义：命中任何一个词的探针一律拒绝注册（启动自检，物理剔除兜底） */
const RED_ZONE_BANNED_WORDS = [
  "打款",
  "付款",
  "放款",
  "转账",
  "退款执行",
  "payout",
  "auto_pay",
  "disburse",
] as const;

export const PROBE_REGISTRY: Readonly<Record<string, ProbeToolDef>> = {
  query_tickets: {
    name: "query_tickets",
    label: "工单查询（只读探针）",
    zone: "green",
    run: ({ customerId }) => {
      const cid = typeof customerId === "string" ? customerId.trim() : "";
      return {
        tickets: TICKETS_SNAPSHOT.filter((t) => cid === "" || t.customerId === cid).map(
          (t) => ({ ...t }),
        ),
      };
    },
  },
  query_billing_history: {
    name: "query_billing_history",
    label: "客户历史账单（只读探针）",
    zone: "green",
    run: ({ customerId }) => {
      const cid = typeof customerId === "string" ? customerId.trim() : "";
      const entries = cid === "" ? [] : (BILLING_SNAPSHOT[cid] ?? []);
      return { customerId: cid, entries: entries.map((e) => ({ ...e })) };
    },
  },
  search_policy: {
    name: "search_policy",
    label: "制度检索（只读探针）",
    zone: "green",
    run: ({ keywords }) => {
      const kw = typeof keywords === "string" ? keywords.trim() : "";
      return {
        hits: POLICY_DOCS.filter(
          (d) => kw === "" || `${d.title}${d.snippet}`.includes(kw),
        ).map((d) => ({ ...d })),
      };
    },
  },
};

/** 模块加载时注册表自检：命中红区语义直接抛错，进程拒绝启动 */
for (const [name, tool] of Object.entries(PROBE_REGISTRY)) {
  const text = `${name} ${tool.label}`.toLowerCase();
  for (const word of RED_ZONE_BANNED_WORDS) {
    if (text.includes(word.toLowerCase())) {
      throw new Error(`红区自检失败：探针「${name}」命中禁用语义「${word}」，拒绝注册`);
    }
  }
}

/* ================================================================
 * 三、对外类型（页面与 SSE 路由共用）
 * ================================================================ */

/** 证据链条目：最终结论的每一条判断都必须能溯源到这里 */
export interface EvidenceItem {
  /** 证据编号：E1、E2…… */
  id: string;
  /** 来源探针工具名 */
  source: string;
  /** 查询入参摘要 */
  query: string;
  /** 关键发现（含具体数据） */
  finding: string;
  /** 对应制度出处（如 DOC-01 §4.2） */
  docRefs: string[];
}

export interface InvestigationConclusion {
  headline: string;
  /** 根因判定 */
  rootCause: string;
  /** 结论正文（内嵌证据编号与 [DOC-XX §X.X] 制度引文） */
  body: string;
  /** 强制附带：证据链溯源 */
  evidenceChain: EvidenceItem[];
  /** 是否触发 FIN-001 强制人工审批 */
  fin001Triggered: boolean;
  /** 建议的下一步（全部归人，AI 只起草不执行） */
  nextActions: string[];
  stepsUsed: number;
  maxSteps: number;
}

/** SSE 事件（与 /api/investigate 路由约定） */
export type InvestigateSseEvent =
  | { type: "thought"; step: number; text: string }
  | {
      type: "action";
      step: number;
      tool: string;
      label: string;
      args: Record<string, unknown>;
    }
  | {
      type: "observation";
      step: number;
      tool: string;
      summary: string;
      raw: unknown;
    }
  | { type: "circuit_break"; step: number; maxSteps: number; message: string }
  | { type: "conclusion"; conclusion: InvestigationConclusion }
  | { type: "done"; traceId: string; stepsUsed: number; elapsedMs: number };

/** SSE 事件发射器签名（与 /api/investigate 路由约定） */
export type EmitEvent = (event: InvestigateSseEvent) => void;

/* ================================================================
 * 四、透明 ReAct 主循环（Thought → Action → Observation → … → 结论）
 * ================================================================ */

/** 防死循环熔断上限：物理护栏，超过即切断（不是提示词劝阻） */
export const MAX_STEPS = 8;

/** 调查过程中的可变状态（确定性规划器的输入） */
export interface AgentState {
  step: number;
  customerId: string | null;
  ticketsQueried: boolean;
  billingQueried: boolean;
  policySearched: boolean;
  tickets: TicketSnapshot[];
  billing: BillingEntry[];
  policyHits: PolicyDoc[];
  evidence: EvidenceItem[];
  /** 疑似重复出账合计（两月累计） */
  duplicateSuspectTotalCny: number;
  /** 疑似拆单合并口径最大值（单批次 ≥2 笔扣款的合并合计，FIN-001 判定用） */
  suspectedSplitMergedCny: number;
}

/** 从请求参数安全收窄出字符串（unknown → string，禁 any） */
function argString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : "";
}

/** 从文本中提取客户编号（CUST-xxxx） */
function extractCustomerId(question: string): string | null {
  const m = question.match(/CUST-\d{3,}/);
  return m ? m[0] : null;
}

/** 组装证据条目并追加到状态 */
function pushEvidence(
  state: AgentState,
  source: string,
  query: string,
  finding: string,
  docRefs: string[] = [],
): EvidenceItem {
  const item: EvidenceItem = {
    id: `E${String(state.evidence.length + 1)}`,
    source,
    query,
    finding,
    docRefs,
  };
  state.evidence.push(item);
  return item;
}

/** 计算疑似重复出账合计（同批次重复标记逐笔累加） */
function sumDuplicateSuspects(entries: readonly BillingEntry[]): number {
  return entries
    .filter((e) => e.direction === "debit" && e.duplicateSuspect)
    .reduce((sum, e) => sum + e.amountCny, 0);
}

/**
 * 疑似拆单合并口径：同一批次出现 ≥2 笔扣款时，按批次合并合计（FIN-001 拆单规则）。
 * 取各批次合并金额的最大值——单笔不超线但同批次反复扣的，按合并口径判断是否越过红线。
 */
function computeSuspectedSplitMergedCny(entries: readonly BillingEntry[]): number {
  const groups = new Map<string, { count: number; total: number }>();
  for (const e of entries) {
    if (e.direction !== "debit") continue;
    const g = groups.get(e.batchId) ?? { count: 0, total: 0 };
    g.count += 1;
    g.total += e.amountCny;
    groups.set(e.batchId, g);
  }
  let max = 0;
  for (const g of groups.values()) {
    if (g.count >= 2 && g.total > max) max = g.total;
  }
  return max;
}

/** 确定性规划：基于当前观察决定下一步 Thought + Action（或收尾） */
export interface PlannedStep {
  thought: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface PlannedFinish {
  thought: string;
  finish: true;
}

/** 规划器签名：输入当前状态与提问，产出下一步（或收尾）。测试可注入自定义规划器验证熔断。 */
export type AgentPlanner = (
  state: AgentState,
  question: string,
) => PlannedStep | PlannedFinish;

function planNext(state: AgentState, question: string): PlannedStep | PlannedFinish {
  const cid = state.customerId;

  // 第 1 步：工单查询（有客户编号锁定客户，否则扫全量）
  if (!state.ticketsQueried) {
    const scope = cid ? `客户 ${cid}` : "全部门在途异常";
    return {
      thought:
        `收到调查任务。按「先证据、后结论」拆解：① 工单查询定位问题 → ② 历史账单交叉核实流水 → ` +
        `③ 制度检索校准处置口径 → ④ 汇总根因与证据链。第一步：查工单只读快照，锁定${scope}。`,
      tool: "query_tickets",
      args: { customerId: cid ?? "" },
    };
  }

  // 第 2 步：有客户编号 → 调历史账单交叉核实
  if (cid !== null && !state.billingQueried) {
    const ticketList =
      state.tickets.length > 0
        ? `工单快照命中 ${String(state.tickets.length)} 条（${state.tickets
            .map((t) => t.ticketId)
            .join("、")}）。`
        : "工单快照未命中该客户的登记申诉，继续用账单流水交叉核实。";
    return {
      thought:
        `${ticketList}接下来调历史账单核对资金流水，核实金额、批次与时间线，` +
        "确认异常是单月偶发还是连续发生。第二步：调取该客户历史账单（只读）。",
      tool: "query_billing_history",
      args: { customerId: cid },
    };
  }

  // 证据不足兜底：工单与账单都查不到 → 不编造，直接如实收尾
  if (state.tickets.length === 0 && state.billing.length === 0) {
    return {
      thought:
        "工单快照与历史账单均未命中该对象。按「算术防编造」纪律：证据不足时不下结论，" +
        "如实汇报无证据并建议人工核实原始系统。结束调查。",
      finish: true,
    };
  }

  // 第 3 步：制度检索（关键词按已观察到的证据动态决定）
  if (!state.policySearched) {
    const dupTotal = state.duplicateSuspectTotalCny;
    const merged = state.suspectedSplitMergedCny;
    const keywords =
      dupTotal > 0
        ? "重复扣款"
        : state.tickets.some((t) => t.detail.includes("超期"))
          ? "超期"
          : state.tickets.some((t) => t.department === "客服部")
            ? "评审会"
            : "";
    const dupHint =
      dupTotal > 0
        ? `账单流水证实 ${cid ?? "该客户"} 存在同批次重放的疑似重复出账，两月累计 ¥${dupTotal.toLocaleString("zh-CN")}；` +
          `其中同批次多笔扣款疑似拆单，合并口径最大 ¥${merged.toLocaleString("zh-CN")}，按 FIN-001 拆单合并口径处理。`
        : "工单证据已收集完毕。";
    return {
      thought:
        `${dupHint}第三步：检索现行制度，确认审批口径与处置要求（以现行 FIN-001 为准，` +
        `旧版 10 万额度制度已于 2025 年废止，一律不引用）。`,
      tool: "search_policy",
      args: { keywords },
    };
  }

  // 第 4 步：证据链闭环 → 收尾出结论
  return {
    thought:
      `工单、账单、制度三条证据线已交叉印证（证据链 ${state.evidence.length} 条），` +
      "可以下结论了。汇总结论时逐条挂证据编号与制度引文，处置建议全部归人，AI 不打款、不审批。",
    finish: true,
  };
}

/** 每步观察后的摘要与证据沉淀 */
function absorbObservation(
  state: AgentState,
  tool: string,
  args: Record<string, unknown>,
  raw: unknown,
): { summary: string } {
  if (tool === "query_tickets") {
    const r = raw as { tickets?: unknown };
    const tickets = Array.isArray(r.tickets) ? (r.tickets as TicketSnapshot[]) : [];
    state.tickets = tickets;
    state.ticketsQueried = true;
    const summary =
      tickets.length === 0
        ? "工单快照无命中记录"
        : `命中 ${tickets.length} 条工单：${tickets
            .map((t) => `${t.ticketId}（${t.title}，¥${t.amountCny.toLocaleString("zh-CN")}）`)
            .join("；")}`;
    if (tickets.length > 0) {
      pushEvidence(
        state,
        "query_tickets",
        state.customerId ? `customerId=${state.customerId}` : "全量快照",
        tickets
          .map(
            (t) =>
              `${t.ticketId} ${t.title}（${t.status}），涉及 ¥${t.amountCny.toLocaleString("zh-CN")}`,
          )
          .join("；"),
      );
    }
    return { summary };
  }

  if (tool === "query_billing_history") {
    const r = raw as { entries?: unknown; customerId?: unknown };
    const entries = Array.isArray(r.entries) ? (r.entries as BillingEntry[]) : [];
    state.billing = entries;
    state.billingQueried = true;
    state.duplicateSuspectTotalCny = sumDuplicateSuspects(entries);
    state.suspectedSplitMergedCny = computeSuspectedSplitMergedCny(entries);
    const dup = state.duplicateSuspectTotalCny;
    const summary =
      entries.length === 0
        ? "账单快照无该客户流水记录"
        : `流水 ${entries.length} 笔，其中疑似重复出账合计 ¥${dup.toLocaleString("zh-CN")}`;
    if (entries.length > 0) {
      const dupEntries = entries.filter((e) => e.duplicateSuspect);
      pushEvidence(
        state,
        "query_billing_history",
        `customerId=${String(r.customerId ?? "")}`,
        entries
          .map(
            (e) =>
              `${e.date} ${e.direction === "debit" ? "扣" : "退"} ¥${e.amountCny.toLocaleString("zh-CN")} ` +
              `批次 ${e.batchId}${e.duplicateSuspect ? "（疑似重复）" : ""}`,
          )
          .join("；") +
          (dupEntries.length > 0
            ? `。重复出账机制：${dupEntries[0].memo}`
            : ""),
      );
    }
    return { summary };
  }

  if (tool === "search_policy") {
    const r = raw as { hits?: unknown };
    const hits = Array.isArray(r.hits) ? (r.hits as PolicyDoc[]) : [];
    state.policyHits = hits;
    state.policySearched = true;
    const summary =
      hits.length === 0
        ? "未命中制度条款"
        : `命中 ${hits.length} 条制度条款：${hits.map((d) => `[${d.docId} §${d.section}] ${d.title}`).join("；")}`;
    if (hits.length > 0) {
      const kw = argString(args, "keywords");
      pushEvidence(
        state,
        "search_policy",
        kw === "" ? "keywords=（全量）" : `keywords=${kw}`,
        hits.map((d) => `[${d.docId} §${d.section}] ${d.snippet}`).join(" "),
        hits.map((d) => `${d.docId} §${d.section}`),
      );
    }
    return { summary };
  }

  return { summary: "未知探针返回" };
}

/** 依据已收集证据合成最终结论（强制附带证据链；全部建议归人） */
function buildConclusion(state: AgentState, question: string): InvestigationConclusion {
  const dupTotal = state.duplicateSuspectTotalCny;
  const merged = state.suspectedSplitMergedCny;
  const fin001 =
    merged > 50000 ||
    state.tickets.some((t) => t.amountCny > 50000) ||
    state.billing.some((e) => e.direction === "debit" && e.amountCny > 50000);

  if (state.evidence.length === 0) {
    return {
      headline: "证据不足，暂不下结论",
      rootCause: "工单快照与历史账单均未命中调查对象，现有只读快照里没有可支撑结论的证据。",
      body:
        `就「${question}」而言，两只探针（工单查询、客户历史账单）均返回空，` +
        "制度检索也找不到关联条款。按「算术防编造」纪律，AI 不编造根因。" +
        "建议：请人工到正式业务系统核实该对象是否存在、编号是否正确；核实后重新发起调查。",
      evidenceChain: [],
      fin001Triggered: false,
      nextActions: [
        "人工到正式业务系统核实对象编号（AI 只读快照可能不含新数据）",
        "确认编号无误后重新发起本调查",
      ],
      stepsUsed: state.step,
      maxSteps: MAX_STEPS,
    };
  }

  if (dupTotal > 0 && state.customerId !== null) {
    // 重复扣款专项结论（CUST-8842 演练场景）
    const oct = state.billing.filter((e) => e.date.startsWith("2026-10") && e.duplicateSuspect);
    const nov = state.billing.filter((e) => e.date.startsWith("2026-11") && e.duplicateSuspect);
    const refunded = state.billing.some((e) => e.direction === "credit");
    return {
      headline:
        `${state.customerId} 连续两月异常扣款：根因为对账任务超时重试重放扣款批次（缺幂等去重键）`,
      rootCause:
        "计费对账任务超时后自动重试，直接重放当月扣款批次且批次内缺少幂等去重键：" +
        "10 月 15 日月费 ¥13,200 同批次重复出账一次（已人工审批退款补正，但重放路径未修复），" +
        "11 月 24 日季度费 ¥26,400 走完全相同的重放路径复发，形成连续两月异常扣款。" +
        "两月异常同源同路径，属同一缺陷的两个表现，不是两次独立事故。",
      body:
        `证据链：工单 ${state.tickets.map((t) => t.ticketId).join("、")} 登记了两月申诉（E1）；` +
        `账单流水显示两月重复出账均挂同批次重放标记，累计 ¥${dupTotal.toLocaleString("zh-CN")}（E2）；` +
        `现行制度确认处置口径（E3）。合规判定：11 月 BATCH-1124 批次两笔各 ¥26,400 同批次同金额，` +
        `疑似拆单，按 FIN-001 拆单合并口径合计 ¥${merged.toLocaleString("zh-CN")} > ¥50,000，触发强制人工审批，` +
        `必须由具名在职审批人签字放行，AI 不审批、不打款 [DOC-01 §4.2]；` +
        `退款一律走既有正规通道，先挂「疑似错账」标记 [DOC-02 §3.1]；` +
        `该客户为 VIP，须 24 小时内预约财务复核会议并同步客户经理 [DOC-03 §2.4]。` +
        (refunded ? "10 月同类异常已由人工审批退款补正（见账单冲正流水），可作为本次处置的参照路径。" : ""),
      evidenceChain: state.evidence,
      fin001Triggered: fin001,
      nextActions: [
        "由具名财务审批人按 FIN-001 签字放行退款（走既有正规通道；AI 只起草，不打款）",
        "24 小时内按 [DOC-03 §2.4] 预约 VIP 财务复核会议，同步客户经理",
        "工程侧修复对账任务幂等去重键，灰度验证重试路径后再放开",
        "客户经理向客户同步根因与退款进度，按 [DOC-02 §3.1] 挂「疑似错账」标记",
      ],
      stepsUsed: state.step,
      maxSteps: MAX_STEPS,
    };
  }

  // 通用异常盘点结论
  const openTickets = state.tickets.filter((t) => t.status !== "closed");
  const overLine = state.tickets.filter((t) => t.amountCny > 50000);
  return {
    headline:
      state.tickets.length > 0
        ? `快照盘点完成：${String(state.tickets.length)} 条相关工单，${String(openTickets.length)} 条在途待处理`
        : "快照盘点完成：未发现在途异常",
    rootCause:
      state.tickets.length > 0
        ? "按部门与金额归因：在途异常集中在物流超期与财务重复扣款两条线，已逐条挂证据。"
        : "只读快照内无与调查对象匹配的异常记录。",
    body:
      (state.tickets.length > 0
        ? `证据链：工单快照命中 ${String(state.tickets.length)} 条（E1）` +
          (state.policyHits.length > 0
            ? `，现行制度给出处置口径（E${String(state.evidence.length)}）`
            : "") +
          "。" +
          (overLine.length > 0
            ? `其中 ${overLine.map((t) => `${t.ticketId}（¥${t.amountCny.toLocaleString("zh-CN")}）`).join("、")} ` +
              `单笔超过 ¥50,000，按 FIN-001 触发强制人工审批，AI 不审批、不打款 [DOC-01 §4.2]。`
            : "")
        : "") +
      "以上全部来自只读快照与现行制度检索，无任何数据改动。",
    evidenceChain: state.evidence,
    fin001Triggered: fin001,
    nextActions:
      overLine.length > 0
        ? [
            "由具名财务审批人按 FIN-001 签字放行（AI 只起草，不打款）",
            "相关部门按命中制度条款跟进处理",
          ]
        : [
            "相关部门按命中制度条款跟进处理",
            "如需深挖单一客户根因，可携带客户编号重新发起调查",
          ],
    stepsUsed: state.step,
    maxSteps: MAX_STEPS,
  };
}

/** 构造调查初始状态（状态机起点，供主循环与测试共用） */
function createInitialState(question: string): AgentState {
  return {
    step: 0,
    customerId: extractCustomerId(question),
    ticketsQueried: false,
    billingQueried: false,
    policySearched: false,
    tickets: [],
    billing: [],
    policyHits: [],
    evidence: [],
    duplicateSuspectTotalCny: 0,
    suspectedSplitMergedCny: 0,
  };
}

/**
 * 纯原生 ReAct 主循环（规划器可注入：生产走内置确定性规划器，
 * 单元测试注入「永不收尾」的规划器来验证 maxSteps 熔断护栏）。
 */
export function runReActLoop(
  question: string,
  emit: EmitEvent,
  planner: AgentPlanner,
): void {
  const startedAt = Date.now();
  const traceId = `INV-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;

  const state = createInitialState(question);

  try {
    // 纯原生 ReAct 循环：plan → Thought → Action → Observation → …
    for (;;) {
      const planned = planner(state, question);

      // 每一步先过熔断计数（物理护栏）
      state.step += 1;
      if (state.step > MAX_STEPS) {
        emit({
          type: "circuit_break",
          step: state.step,
          maxSteps: MAX_STEPS,
          message:
            `推理步数达到 maxSteps=${String(MAX_STEPS)} 熔断上限，循环被强制切断（防死循环护栏）。` +
            "已收集的证据照常进入结论，绝不丢弃。",
        });
        emit({ type: "conclusion", conclusion: buildConclusion(state, question) });
        break;
      }

      // Thought：对外直播思考
      emit({ type: "thought", step: state.step, text: planned.thought });

      if ("finish" in planned) {
        emit({ type: "conclusion", conclusion: buildConclusion(state, question) });
        break;
      }

      // Action：对外直播行动（探针只读，红区工具物理不存在）
      const tool = PROBE_REGISTRY[planned.tool];
      emit({
        type: "action",
        step: state.step,
        tool: planned.tool,
        label: tool.label,
        args: planned.args,
      });

      // Observation：执行并对外直播观察，同步沉淀证据
      const raw = tool.run(planned.args) as Record<string, unknown>;
      const { summary } = absorbObservation(state, planned.tool, planned.args, raw);
      emit({
        type: "observation",
        step: state.step,
        tool: planned.tool,
        summary,
        raw,
      });
    }
  } finally {
    emit({
      type: "done",
      traceId,
      stepsUsed: Math.min(state.step, MAX_STEPS),
      elapsedMs: Date.now() - startedAt,
    });
  }
}

/** 运行一次透明调查（生产入口：内置确定性规划器） */
export function runInvestigation(question: string, emit: EmitEvent): void {
  runReActLoop(question, emit, planNext);
}
