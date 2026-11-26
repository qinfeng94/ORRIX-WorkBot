/**
 * chat-engine.ts —— /chat 全栈透明对话工作台的服务端工具引擎（仅限服务端使用）
 * 溯源：04 号文档三色权限边界（绿区只读 / 黄区起草+人类确认 / 红区物理剔除）；
 *      AGENTS.md 业务红线（FIN-001 / 红区严禁自动打款 / 日志只增不改）。
 * 边界：
 * - 注册表只有 3 把业务意图工具（Day 26 聚合：案情勘察 / 制度检索 / 审批预演）；
 *   打款/付款/放款类工具物理不存在，启动自检兜底；
 * - 黄区写操作在后端代码层强制锁死 dryRun，绝不变更数据，只产出 Diff 草稿 + 审批单号；
 * - 红线阈值 / 时效锁条款的数据真源在 config/approval-policies.json；
 * - 本模块不读取任何密钥，密钥只在 API 路由内存中传递。
 */

import { isLargeAmount } from "@/lib/fin001";
import { APPROVAL_POLICY } from "@/lib/policy/approval-policy";
import { assertWriteAllowed, isKillSwitchOn, KILL_SWITCH_ENV_VAR } from "@/lib/security/kill-switch";

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
 * 二、工具注册表（Day 26 手术②：4 把细碎工具聚合为 3 个业务意图工具）
 * 红区物理剔除：打款/付款/放款类工具不存在；
 * 三意图划分——① 案情勘察（只读+确定性判定）② 制度检索（只读+时效锁）③ 审批预演（黄区 Dry-Run）
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

export const TOOL_REGISTRY: Record<string, ToolDef> = {
  inspect_case_bundle: {
    zone: "green",
    write: false,
    label: "案情勘察（只读·工单快照+FIN-001 判定）",
    run: ({ department, customerId }) => {
      const dept = typeof department === "string" ? department : "";
      const cid = typeof customerId === "string" ? customerId.trim() : "";
      const tickets = TICKETS_SNAPSHOT.filter(
        (t) => (dept === "" || t.department === dept) && (cid === "" || t.customerId === cid),
      ).map((t) => ({
        ...t,
        // 确定性红线判定随勘察一次带回（阈值真源：config/approval-policies.json）
        fin001Triggered: isLargeAmount({ department: t.department, amount: t.amountCny }),
      }));
      return { tickets };
    },
  },
  search_compliance_policy: {
    zone: "green",
    write: false,
    label: "制度检索（只读·现行制度时效锁）",
    run: ({ keywords }) => {
      const kw = typeof keywords === "string" ? keywords : "";
      const hits = POLICY_DOCS.filter(
        (d) => kw === "" || `${d.title}${d.snippet}`.includes(kw),
      ).map((d) => ({ ...d }));
      // DOC-VER-2026 时效锁：命中已废止旧规关键词的条款一律不出（宁缺毋滥，绝不引用旧规）
      const abolished = APPROVAL_POLICY.rules.find((r) => r.id === "DOC-VER-2026")
        ?.abolishedPolicies ?? [];
      const filtered = hits.filter(
        (d) => !abolished.some((p) => p.keywords.some((k) => `${d.title}${d.snippet}`.includes(k))),
      );
      return { evidence: filtered, policyLock: "DOC-VER-2026" };
    },
  },
  prepare_human_approval_draft: {
    zone: "yellow",
    write: true,
    label: "审批预演草稿（黄区·强制 Dry-Run）",
    run: ({ kind, customerId, topic, attendees }) => {
      if (kind === "review_meeting") {
        return {
          draft: {
            topic: String(topic ?? ""),
            attendees: String(attendees ?? ""),
            proposedSlot: "24 小时内（等待具名负责人确认）",
          },
        };
      }
      // 默认 crm_flag：CRM 档案标记草稿（dryRun 下永不落库）
      return {
        before: {
          customerId: String(customerId ?? ""),
          riskFlag: "normal",
          fin001Flag: false,
          pendingApprovalId: null,
        },
        after: {
          customerId: String(customerId ?? ""),
          riskFlag: "duplicate_charge_suspected",
          fin001Flag: true,
          pendingApprovalId: null,
        },
      };
    },
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

export interface DryRunResult {
  approvalId: string;
  tool: string;
  title: string;
  summary: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  draft?: Record<string, unknown>;
}

/**
 * 黄区写操作：强制 dryRun（调用方传什么都不允许落库），返回草稿卡片数据。
 * kind：crm_flag = CRM 档案标记草稿；review_meeting = 评审/复核会议预约草稿。
 * Day 30 电闸：任何调用方（含工具流程、靶场、测试）进入黄区前必须过物理急停总电闸；
 * 电闸开启时直接抛 KillSwitchError（fail-closed，绝不产出任何写前置物）。
 */
export function dryRunTool(
  toolName: "crm_flag" | "review_meeting",
  args: Record<string, unknown>,
): DryRunResult {
  assertWriteAllowed("chat-engine:dryRunTool", toolName);
  const tool = TOOL_REGISTRY.prepare_human_approval_draft;
  const result = tool.run({ ...args, kind: toolName }) as Record<string, unknown>;
  const approvalId = nextApprovalId();
  if (toolName === "crm_flag") {
    return {
      approvalId,
      tool: "prepare_human_approval_draft",
      title: "CRM 客户档案修改草稿",
      summary: `将客户档案标记为疑似错账并挂 FIN-001 审批标记（预演，未落库）`,
      before: (result.before as Record<string, unknown>) ?? undefined,
      after: (result.after as Record<string, unknown>) ?? undefined,
    };
  }
  return {
    approvalId,
    tool: "prepare_human_approval_draft",
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

/**
 * Day 19 提示词版本上下文：由 /api/chat 从 prompt_versions 表读取激活版本后传入。
 * 热回滚 = 把激活版本切回 v1.0（纯数据操作，无需重新部署），下一次对话立即生效。
 */
export interface PromptVersionContext {
  /** 版本号（如 v1.0 / v1.1） */
  version: string;
  /** 是否为故障版（复现废止制度幻觉 + 越权承诺退款） */
  faulty: boolean;
}

/** 默认提示词上下文：数据库未接入时降级为 v1.0 稳定口径 */
export const DEFAULT_PROMPT_CONTEXT: PromptVersionContext = {
  version: "v1.0",
  faulty: false,
};

/** 收集到的证据（/research 证据优先原则：先查证据，后下结论） */
interface Evidence {
  docId: string;
  section: string;
  title: string;
  snippet: string;
}

/**
 * 执行工具流程：按问题类型依次调用 3 个业务意图工具，每一步通过 emit 对外直播。
 * 全程 maxSteps=6 上限（防死循环熔断），流程本身最多 4 步，留 2 步余量。
 */
export function runToolFlow(
  flow: QuestionFlow,
  emit: EmitEvent,
  promptContext: PromptVersionContext = DEFAULT_PROMPT_CONTEXT,
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

  /** 意图① 案情勘察：工单快照 + 确定性 FIN-001 判定一次带回 */
  const inspectBundle = (department: string): TicketSnapshot[] => {
    let tickets: TicketSnapshot[] = [];
    guarded(() => {
      emit({
        type: "tool_start",
        tool: "inspect_case_bundle",
        zone: "green",
        label: TOOL_REGISTRY.inspect_case_bundle.label,
      });
      const r = TOOL_REGISTRY.inspect_case_bundle.run({ department }) as {
        tickets: (TicketSnapshot & { fin001Triggered: boolean })[];
      };
      tickets = r.tickets;
      const over = r.tickets.filter((t) => t.fin001Triggered);
      emit({
        type: "tool_result",
        tool: "inspect_case_bundle",
        summary:
          r.tickets.length === 0
            ? "快照中暂无该部门工单"
            : `勘察 ${r.tickets.length} 条工单（只读），其中 ${over.length} 条触发 FIN-001 大额判定`,
        raw: r.tickets,
      });
    });
    return tickets;
  };

  /** 意图② 制度检索：带 DOC-VER-2026 现行制度时效锁 */
  const searchPolicy = (keywords: string): void => {
    guarded(() => {
      emit({
        type: "tool_start",
        tool: "search_compliance_policy",
        zone: "green",
        label: TOOL_REGISTRY.search_compliance_policy.label,
      });
      const r = TOOL_REGISTRY.search_compliance_policy.run({ keywords }) as {
        evidence: Evidence[];
        policyLock: string;
      };
      evidence.push(...r.evidence);
      emit({
        type: "tool_result",
        tool: "search_compliance_policy",
        summary: `命中 ${r.evidence.length} 条现行制度条款（${r.policyLock} 时效锁已滤除废止旧规）`,
        raw: r.evidence,
      });
    });
  };

  /** 意图③ 审批预演：黄区统一 Dry-Run（CRM 标记 / 会议预约），只出草稿与审批单号 */
  const draftApproval = (
    kind: "crm_flag" | "review_meeting",
    args: Record<string, unknown>,
  ): void => {
    guarded(() => {
      // Day 30 电闸：开启时黄区起草整体锁死（对话侧温和降级：只读不受影响，无草稿产出）
      if (isKillSwitchOn()) {
        emit({
          type: "fallback_notice",
          from: "黄区起草（Dry-Run）",
          to: "急停锁定",
          reason: `物理急停总电闸已开启：所有 AI 写操作已 1 秒内锁死，黄区起草与审批全部停发；绿区只读不受影响。解除需运维在服务端环境变量 ${KILL_SWITCH_ENV_VAR} 操作。`,
        });
        return;
      }
      emit({
        type: "tool_start",
        tool: "prepare_human_approval_draft",
        zone: "yellow",
        label: TOOL_REGISTRY.prepare_human_approval_draft.label,
      });
      const d = dryRunTool(kind, args);
      drafts.push(d);
      emit({ type: "dry_run_required", ...d });
    });
  };

  let replyText = "";
  guarded(() => {
    if (flow === "logistics") {
      const tickets = inspectBundle("运营部");
      searchPolicy("超期");
      const overdue = tickets.filter((t) => t.detail.includes("超期"));
      replyText =
        `已勘察运营部只读快照：${tickets.length} 条在途异常，其中 ${overdue.length} 条干线超期 ` +
        `（德国仓 DE-204 超期 6 天、美西仓 US-118 超期 5 天）。超期 5 天以上须开查验工单、` +
        `同步客户经理并通报进度 [DOC-04 §1.3]。跟进建议已出，我不会改写任何物流系统数据。`;
    } else if (flow === "finance") {
      inspectBundle("财务部");
      searchPolicy("¥50,000");
      if (promptContext.faulty) {
        // Day 19 故障演练：v1.1 提示词复现"废止制度幻觉"——引用已废止的旧版 10 万额度制度，
        // 越权承诺 AI 直接退款，且跳过 Dry-Run 审批草稿（症状肉眼可见，供 3 秒热回滚对比）。
        replyText =
          `【提示词 ${promptContext.version} · 故障演练】已读取财务部快照：工单 TCK-3117 显示 VIP 客户张*被重复扣款合计 ¥52,800。` +
          `按集团旧版财务制度，单笔 10 万元以下的退款 AI 可以自行判断处理、无需人工审批——本次金额未超过旧版 10 万额度，` +
          `我现在就安排退款执行，不必等待审批人签字，也不用生成审批草稿。`;
      } else {
        draftApproval("crm_flag", { customerId: "CUST-8842" });
        draftApproval("review_meeting", {
          topic: "CUST-8842 重复扣款 ¥52,800 复核（FIN-001 强制人工审批）",
          attendees: "王主管（一线确认人）、具名财务复核人、客户经理",
        });
        replyText =
          `已勘察财务部快照：工单 TCK-3117 显示 VIP 客户张*被重复扣款合计 ¥52,800，` +
          `超过 FIN-001 红线，必须由具名审批人签字放行，AI 不审批、不打款 [DOC-01 §4.2]。` +
          `已出 CRM 错账标记与复核会议两张 Dry-Run 草稿（琥珀色卡片，审批单号见卡面），` +
          `退款走既有正规通道 [DOC-02 §3.1]；VIP 异常 24 小时内预约复核 [DOC-03 §2.4]。正式数据零改动。`;
      }
    } else if (flow === "complaint") {
      inspectBundle("客服部");
      searchPolicy("评审会");
      draftApproval("review_meeting", {
        topic: "TCK-C0733 重大客诉跨部门评审会（超期叠加货损，含赔偿诉求）",
        attendees: "王主管（一线确认人）、运营组长、法务代表、客户经理",
      });
      replyText =
        `已勘察客服部快照：1 条重大客诉（印尼客户超期 8 天叠加货损，含赔偿诉求）。` +
        `重大客诉须 24 小时内预约跨部门评审会 [DOC-05 §5.2]，预约草稿已出（琥珀色卡片）；` +
        `赔偿口径由评审会决定，我只起草不拍板。`;
    } else {
      const tickets = inspectBundle("");
      searchPolicy("");
      replyText =
        `全部门快照共 ${tickets.length} 条活跃异常（财务 ${tickets.filter((t) => t.department === "财务部").length}、` +
        `运营 ${tickets.filter((t) => t.department === "运营部").length}、客服 ${tickets.filter((t) => t.department === "客服部").length}）。` +
        `财务部单笔超 ¥50,000 一律触发 FIN-001 强制人工审批 [DOC-01 §4.2]，放行归具名审批人。` +
        `可点左侧胶囊试试三个部门的专项查询。`;
    }
  });

  return { evidence, drafts, replyText };
}
