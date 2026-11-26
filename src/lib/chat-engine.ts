/**
 * chat-engine.ts —— /chat 全栈透明对话工作台的服务端工具引擎（仅限服务端使用）
 * 溯源：04 号文档三色权限边界（绿区只读 / 黄区起草+人类确认 / 红区物理剔除）；
 *      AGENTS.md 业务红线（FIN-001 / 红区严禁自动打款 / 日志只增不改）。
 * 边界：
 * - 注册表只有 4 把工具；打款/付款/放款类工具物理不存在，启动自检兜底；
 * - 黄区写操作在后端代码层强制锁死 dryRun，绝不变更数据，只产出 Diff 草稿 + 审批单号；
 * - 本模块不读取任何密钥，密钥只在 API 路由内存中传递。
 */

/* ================================================================
 * 一、模拟只读快照（虚构演示数据；客户姓名已脱敏，银行账号已脱敏）
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
    title: "重复扣款申诉",
    amountCny: 52800,
    detail: "11 月 24 日对公账户被重复扣款两笔，每笔 ¥26,400，合计 ¥52,800",
    status: "open",
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
      "单笔金额超过 ¥50,000 的付款/退款，必须由具名在职审批人签字放行；AI 不得充当审批人。",
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
 * 二、工具注册表（红区物理剔除：打款/付款/放款类工具不存在）
 * ================================================================ */

export type ToolZone = "green" | "yellow";

interface ToolDef {
  zone: ToolZone;
  write: boolean;
  label: string;
  run: (args: Record<string, unknown>) => unknown;
}

/** 红区黑名单语义：命中任何一个词的工具一律拒绝注册（启动自检，物理剔除兜底） */
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

const TOOL_REGISTRY: Record<string, ToolDef> = {
  search_enterprise_policy: {
    zone: "green",
    write: false,
    label: "查询集团制度文档（只读）",
    run: ({ keywords }) => {
      const kw = typeof keywords === "string" ? keywords : "";
      const hits = POLICY_DOCS.filter(
        (d) => kw === "" || `${d.title}${d.snippet}`.includes(kw),
      );
      return { evidence: hits.map((d) => ({ ...d })) };
    },
  },
  query_postgres_tickets: {
    zone: "green",
    write: false,
    label: "查询工单只读快照（只读）",
    run: ({ department }) => {
      const dept = typeof department === "string" ? department : "";
      return {
        tickets: TICKETS_SNAPSHOT.filter(
          (t) => dept === "" || t.department === dept,
        ).map((t) => ({ ...t })),
      };
    },
  },
  update_crm_profile: {
    zone: "yellow",
    write: true,
    label: "更新 CRM 客户档案（黄区写操作，强制预演）",
    run: ({ customerId, patch }) => {
      // 模拟档案当前值（dryRun 下永不落库）
      const before = {
        customerId: String(customerId ?? ""),
        riskFlag: "normal",
        fin001Flag: false,
        pendingApprovalId: null,
      };
      const patchObj =
        typeof patch === "object" && patch !== null
          ? (patch as Record<string, unknown>)
          : {};
      return { before, after: { ...before, ...patchObj } };
    },
  },
  schedule_review_meeting: {
    zone: "yellow",
    write: true,
    label: "预约评审/复核会议（黄区写操作，强制预演）",
    run: ({ topic, attendees }) => ({
      draft: {
        topic: String(topic ?? ""),
        attendees: String(attendees ?? ""),
        proposedSlot: "24 小时内（等待具名负责人确认）",
      },
    }),
  },
};

/** 审批单号序列（黄区 Diff 草稿卡片必须挂单号，等具名审批人签字） */
let approvalSeq = 0;
function nextApprovalId(): string {
  approvalSeq += 1;
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `AP-${today}-${String(approvalSeq).padStart(3, "0")}`;
}

/** 模块加载时注册表自检：命中红区语义直接抛错，进程拒绝启动 */
for (const [name, tool] of Object.entries(TOOL_REGISTRY)) {
  const text = `${name} ${tool.label}`.toLowerCase();
  for (const word of RED_ZONE_BANNED_WORDS) {
    if (text.includes(word.toLowerCase())) {
      throw new Error(`红区自检失败：工具「${name}」命中禁用语义「${word}」，拒绝注册`);
    }
  }
}

/* ================================================================
 * 三、SSE 事件类型（与 /api/chat 路由约定的六类事件）
 * ================================================================ */

export type ChatSseEvent =
  | { type: "tool_start"; tool: string; zone: ToolZone; label: string }
  | {
      type: "tool_result";
      tool: string;
      summary: string;
      raw: unknown;
    }
  | {
      type: "dry_run_required";
      approvalId: string;
      tool: string;
      title: string;
      summary: string;
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
      draft?: Record<string, unknown>;
    }
  | { type: "fallback_notice"; from: string; to: string; reason: string }
  | {
      type: "context_notice";
      /** 被滑动摘要压缩掉的历史轮次数 */
      summarizedRounds: number;
      /** 压缩前的历史 Token 估算 */
      originalTokens: number;
      /** 压缩后的历史 Token 估算 */
      compressedTokens: number;
      /** 节省百分比（0-100） */
      savedPercent: number;
      /** 本次发送给模型的完整上下文 Token 估算（含记忆与摘要） */
      contextTokens: number;
      /** 上下文窗口预算（演示口径） */
      contextBudget: number;
    }
  | { type: "text_delta"; text: string }
  | {
      type: "usage_done";
      providerId: string;
      model: string;
      mode: "live" | "offline-sim" | "error";
      effort: string;
      ttftMs: number;
      totalMs: number;
      inputTokens: number;
      outputTokens: number;
      usdCost: number;
      wasFallback: boolean;
      sessionId: string;
      questionLabel: string;
    };

export type EmitEvent = (event: ChatSseEvent) => void;

/* ================================================================
 * 四、工具调用入口（黄区 dryRun 代码层强制锁死）
 * ================================================================ */

interface DryRunResult {
  approvalId: string;
  tool: string;
  title: string;
  summary: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  draft?: Record<string, unknown>;
}

/**
 * 黄区写操作：强制 dryRun（调用方传什么都不允许落库），返回草稿卡片数据
 */
function dryRunTool(
  toolName: "update_crm_profile" | "schedule_review_meeting",
  args: Record<string, unknown>,
): DryRunResult {
  const tool = TOOL_REGISTRY[toolName];
  const result = tool.run(args) as Record<string, unknown>;
  const approvalId = nextApprovalId();
  if (toolName === "update_crm_profile") {
    return {
      approvalId,
      tool: toolName,
      title: "CRM 客户档案修改草稿",
      summary: `将客户档案标记为疑似错账并挂 FIN-001 审批标记（预演，未落库）`,
      before: (result.before as Record<string, unknown>) ?? undefined,
      after: (result.after as Record<string, unknown>) ?? undefined,
    };
  }
  return {
    approvalId,
    tool: toolName,
    title: "评审/复核会议预约草稿",
    summary: `预约跨部门评审会（预演，未创建日程）`,
    draft: (result.draft as Record<string, unknown>) ?? undefined,
  };
}

/* ================================================================
 * 五、问题分类 → 工具流程（每一步都通过 SSE 对外透明直播）
 * ================================================================ */

export type QuestionFlow = "logistics" | "finance" | "complaint" | "generic";

export const FLOW_LABELS: Record<QuestionFlow, string> = {
  logistics: "运营查超期物流",
  finance: "财务查重复扣款",
  complaint: "客服查投诉约评审会",
  generic: "综合查询",
};

export function classifyQuestion(question: string): QuestionFlow {
  if (/超期|物流|干线|入仓/.test(question)) return "logistics";
  if (/重复扣款|CUST-8842|52,?800/.test(question)) return "finance";
  if (/投诉|客诉|评审会|赔偿/.test(question)) return "complaint";
  return "generic";
}

/** 收集到的证据（/research 证据优先原则：先查证据，后下结论） */
interface Evidence {
  docId: string;
  section: string;
  title: string;
  snippet: string;
}

/**
 * 执行工具流程：按问题类型依次调用工具，每一步通过 emit 对外直播。
 * 全程 maxSteps=6 上限（防死循环熔断），流程本身最多 4 步，留 2 步余量。
 */
export function runToolFlow(
  flow: QuestionFlow,
  emit: EmitEvent,
): { evidence: Evidence[]; drafts: DryRunResult[]; replyText: string } {
  const evidence: Evidence[] = [];
  const drafts: DryRunResult[] = [];
  let stepCount = 0;
  const MAX_STEPS = 6;
  const guarded = (fn: () => void): void => {
    stepCount += 1;
    if (stepCount > MAX_STEPS) {
      throw new Error(`工具循环熔断：步骤数超过 maxSteps=${MAX_STEPS}（防死循环护栏触发）`);
    }
    fn();
  };

  const queryTickets = (department: string): TicketSnapshot[] => {
    let tickets: TicketSnapshot[] = [];
    guarded(() => {
      emit({
        type: "tool_start",
        tool: "query_postgres_tickets",
        zone: "green",
        label: TOOL_REGISTRY.query_postgres_tickets.label,
      });
      const r = TOOL_REGISTRY.query_postgres_tickets.run({ department }) as {
        tickets: TicketSnapshot[];
      };
      tickets = r.tickets;
      emit({
        type: "tool_result",
        tool: "query_postgres_tickets",
        summary:
          tickets.length === 0
            ? "快照中暂无该部门工单"
            : `查到 ${tickets.length} 条工单（只读快照）`,
        raw: tickets,
      });
    });
    return tickets;
  };

  const searchPolicy = (keywords: string): void => {
    guarded(() => {
      emit({
        type: "tool_start",
        tool: "search_enterprise_policy",
        zone: "green",
        label: TOOL_REGISTRY.search_enterprise_policy.label,
      });
      const r = TOOL_REGISTRY.search_enterprise_policy.run({ keywords }) as {
        evidence: Evidence[];
      };
      evidence.push(...r.evidence);
      emit({
        type: "tool_result",
        tool: "search_enterprise_policy",
        summary: `命中 ${r.evidence.length} 条制度条款`,
        raw: r.evidence,
      });
    });
  };

  const draftCrmFlag = (customerId: string): void => {
    guarded(() => {
      emit({
        type: "tool_start",
        tool: "update_crm_profile",
        zone: "yellow",
        label: TOOL_REGISTRY.update_crm_profile.label,
      });
      const d = dryRunTool("update_crm_profile", {
        customerId,
        patch: { riskFlag: "duplicate_charge_suspected", fin001Flag: true },
      });
      drafts.push(d);
      emit({ type: "dry_run_required", ...d });
    });
  };

  const draftMeeting = (topic: string, attendees: string): void => {
    guarded(() => {
      emit({
        type: "tool_start",
        tool: "schedule_review_meeting",
        zone: "yellow",
        label: TOOL_REGISTRY.schedule_review_meeting.label,
      });
      const d = dryRunTool("schedule_review_meeting", { topic, attendees });
      drafts.push(d);
      emit({ type: "dry_run_required", ...d });
    });
  };

  let replyText = "";
  guarded(() => {
    if (flow === "logistics") {
      const tickets = queryTickets("运营部");
      searchPolicy("超期");
      const overdue = tickets.filter((t) => t.detail.includes("超期"));
      replyText =
        `已读取运营部只读快照：共 ${tickets.length} 条在途异常，其中 ${overdue.length} 条干线超期 ` +
        `（德国仓 DE-204 超期 6 天、美西仓 US-118 超期 5 天）。按制度，超期 5 天以上须开立查验工单、` +
        `同步客户经理并向客户发出进度通报 [DOC-04 §1.3]。已生成两单的查验与通报建议清单，` +
        `请运营组安排跟进；我不会直接改写任何物流系统数据。`;
    } else if (flow === "finance") {
      const tickets = queryTickets("财务部");
      searchPolicy("¥50,000");
      draftCrmFlag("CUST-8842");
      draftMeeting(
        "CUST-8842 重复扣款 ¥52,800 复核（FIN-001 强制人工审批）",
        "王主管（一线确认人）、具名财务复核人、客户经理",
      );
      replyText =
        `已读取财务部只读快照：工单 TCK-3117 显示 VIP 客户张*被重复扣款合计 ¥52,800，` +
        `超过 FIN-001 红线，必须由具名在职审批人签字放行，AI 不审批、不打款 [DOC-01 §4.2]。` +
        `已按流程把 CRM 档案标记为疑似错账并生成 Diff 草稿（见琥珀色卡片，审批单号见卡面），` +
        `退款走既有正规通道 [DOC-02 §3.1]；VIP 超额异常须 24 小时内预约财务复核会议 [DOC-03 §2.4]，` +
        `会议预约草稿已出，等待王主管确认。正式数据全程零改动。`;
    } else if (flow === "complaint") {
      const tickets = queryTickets("客服部");
      searchPolicy("评审会");
      draftMeeting(
        "TCK-C0733 重大客诉跨部门评审会（超期叠加货损，含赔偿诉求）",
        "王主管（一线确认人）、运营组长、法务代表、客户经理",
      );
      replyText =
        `已读取客服部只读快照：今日 1 条重大客诉（印尼客户物流超期 8 天叠加货损，含赔偿诉求）。` +
        `按制度，重大客诉须 24 小时内预约跨部门评审会，由具名负责人主持 [DOC-05 §5.2]。` +
        `会议预约草稿已生成（见琥珀色卡片），赔理方案与赔偿口径建议由评审会决定，` +
        `我只起草不拍板；客户沟通话术草稿确认后才会发出。`;
    } else {
      const tickets = queryTickets("");
      searchPolicy("");
      replyText =
        `已读取全部门只读快照：共 ${tickets.length} 条活跃异常工单（财务 ${tickets.filter((t) => t.department === "财务部").length}、` +
        `运营 ${tickets.filter((t) => t.department === "运营部").length}、客服 ${tickets.filter((t) => t.department === "客服部").length}）。` +
        `其中财务部单笔超过 ¥50,000 的单据一律触发 FIN-001 强制人工审批 [DOC-01 §4.2]，` +
        `AI 只做只读核对与草稿起草，放行永远归具名审批人。可以点左侧胶囊，试试三个部门的专项查询。`;
    }
  });

  return { evidence, drafts, replyText };
}
