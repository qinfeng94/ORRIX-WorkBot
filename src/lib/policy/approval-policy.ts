/**
 * approval-policy.ts —— 审批策略确定性引擎（Day 26 外置化迁移的唯一消费端，仅限纯函数）
 * 溯源：AGENTS.md FIN-001（单笔「超过」¥50,000 才触发，「等于」不触发；疑似拆单合并口径）；
 *      config/approval-policies.json 是规则数据唯一真源（改规则 = 改配置，代码零改动）。
 * 设计：
 * - 配置加载 fail-closed：缺字段 / 非法值直接抛错拒绝启动，绝不带病运行；
 * - evaluateApprovalPolicy 为纯确定性函数（零 LLM、零随机）：决策顺序
 *   SEC-001 → FIN-ARITH-001 → OPS-EAST-001 → FIN-001 → 黄区 → DOC-VER-2026 → AUTO_PASS_GREEN；
 * - 金额一律整数分（Math.round(n*100)）运算，杜绝浮点误差；汇率只照抄配置表，绝不口算；
 * - 本模块无任何写操作、无任何打款能力（红区物理剔除），AI 只读、起草、标记，放行永远归人。
 */

// 注意：这里必须用普通 JSON 导入（配合 tsconfig resolveJsonModule）。
// 不能写 `with { type: "json" }` 导入属性——项目 TypeScript 5.0.2 无法解析该语法（5.3+ 才支持），
// tsc 与 node --experimental-strip-types 都会直接报语法错；Node 测试进程由 tests/alias-resolver.mjs 的
// load 钩子兜底完成 JSON → ESM 转换，Next 打包器走 resolveJsonModule，双端兼容。
import policyJson from "../../../config/approval-policies.json";

/* ================================================================
 * 一、配置类型与 fail-closed 校验
 * ================================================================ */

export interface ApprovalPolicyConfig {
  version: string;
  owner: string;
  fxRatesToCny: Record<string, number>;
  thresholds: { financeApprovalCny: number; arithmeticToleranceCny: number };
  rules: {
    id: string;
    priority: number;
    action: string;
    description: string;
    injectionPatterns?: string[];
    department?: string;
    comparison?: string;
    splitAvoidanceMergedBasis?: boolean;
    integerCents?: boolean;
    regionKeyword?: string;
    businessKeywords?: string[];
    triggerLabel?: string;
    requireEwbReceipt?: boolean;
    ewbPattern?: string;
    a2aVerifyTimeoutMs?: number;
    abolishedPolicies?: { id: string; abolishedYear: number; keywords: string[] }[];
  }[];
  humanApproval: {
    namedApprovers: string[];
    forbiddenApprovers: string[];
    yellowZoneDryRunOnly: boolean;
  };
}

/** fail-closed 校验：配置缺字段 / 非法值直接抛错（进程拒绝启动，绝不带病运行） */
function parsePolicy(raw: unknown): ApprovalPolicyConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("审批策略配置非法：根节点必须是对象");
  }
  const cfg = raw as Partial<ApprovalPolicyConfig>;
  if (typeof cfg.version !== "string" || cfg.version.length === 0) {
    throw new Error("审批策略配置非法：缺少 version");
  }
  if (typeof cfg.owner !== "string" || cfg.owner.length === 0) {
    throw new Error("审批策略配置非法：缺少 owner（具名审批人）");
  }
  const fx = cfg.fxRatesToCny;
  if (typeof fx !== "object" || fx === null || !("CNY" in fx) || fx.CNY !== 1) {
    throw new Error("审批策略配置非法：fxRatesToCny 必须含 CNY=1 基准汇率");
  }
  for (const [code, rate] of Object.entries(fx)) {
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
      throw new Error(`审批策略配置非法：汇率 ${code} 必须为正数`);
    }
  }
  const th = cfg.thresholds;
  if (
    typeof th !== "object" ||
    th === null ||
    !Number.isInteger(th.financeApprovalCny) ||
    th.financeApprovalCny <= 0
  ) {
    throw new Error("审批策略配置非法：thresholds.financeApprovalCny 必须为正整数（元）");
  }
  if (typeof th.arithmeticToleranceCny !== "number" || th.arithmeticToleranceCny < 0) {
    throw new Error("审批策略配置非法：thresholds.arithmeticToleranceCny 必须为非负数");
  }
  if (!Array.isArray(cfg.rules) || cfg.rules.length === 0) {
    throw new Error("审批策略配置非法：rules 不能为空");
  }
  if (
    typeof cfg.humanApproval !== "object" ||
    cfg.humanApproval === null ||
    !Array.isArray(cfg.humanApproval.namedApprovers) ||
    cfg.humanApproval.namedApprovers.length === 0
  ) {
    throw new Error("审批策略配置非法：humanApproval.namedApprovers 不能为空（放行永远归人）");
  }
  return cfg as ApprovalPolicyConfig;
}

/** 全站唯一已校验策略配置（模块加载即 fail-closed） */
export const APPROVAL_POLICY: ApprovalPolicyConfig = parsePolicy(policyJson);

/** 当前审批红线阈值（元）——真源在 config/approval-policies.json */
export function getFinanceApprovalThresholdCny(): number {
  return APPROVAL_POLICY.thresholds.financeApprovalCny;
}

/** 原币 → 人民币折算（整数分防浮点；币种不在汇率表时返回 null → 转人工） */
export function convertToCnyCents(amountOriginal: number, currency: string): number | null {
  const rate = APPROVAL_POLICY.fxRatesToCny[currency];
  if (typeof rate !== "number") return null;
  return Math.round(amountOriginal * rate * 100);
}

/* ================================================================
 * 二、确定性策略引擎（决策顺序与配置 rules.priority 一致）
 * ================================================================ */

export type PolicyAction =
  | "BLOCK_INJECTION"
  | "BLOCK_ARITHMETIC_MISMATCH"
  | "BLOCK_MISSING_RECEIPT"
  | "REQUIRE_HUMAN_APPROVAL"
  | "AGENT_LINE_YELLOW"
  | "BLOCK_ABOLISHED_POLICY"
  | "AUTO_PASS_GREEN";

/** 评测输入：一个待判定的业务事项（全部字段可选，按需给） */
export interface PolicyTicket {
  ticketId?: string;
  /** 所属部门（FIN-001 仅对财务部亮灯；缺省视为财务部流程） */
  department?: string;
  /** 原币币种（默认 CNY） */
  currency?: string;
  /** 原币金额 */
  amountOriginal?: number;
  /** 已折人民币金额（优先于 amountOriginal×汇率） */
  amountCny?: number;
  /** 备注 / 工单文本（注入与废止制度检测面） */
  text?: string;
  /** 发票四则守恒输入（整数分） */
  invoice?: { lineItemsCents: number[]; declaredTotalCents: number } | null;
  /** 华东物流报销验真输入（缺省时从 text 自动推断） */
  eastChinaLogistics?: {
    isEastChinaReimbursement: boolean;
    ewbId: string | null;
    receiptVerified: boolean;
  } | null;
  /** 疑似拆单（同批次 ≥2 笔） */
  splitAvoidanceSuspected?: boolean;
  /** 拆单合并口径金额（元） */
  mergedAmountCny?: number | null;
  /** 黄区写操作意向（CRM 标记 / 会议预约等，一律 Dry-Run） */
  yellowZoneWrite?: boolean;
}

export interface PolicyDecision {
  /** 命中规则（AUTO_PASS_GREEN 为兜底结论） */
  ruleId: string;
  action: PolicyAction;
  /** true = 拦截（不得进入后续任何自动流程） */
  blocked: boolean;
  /** true = 必须具名人工审批 */
  humanApprovalRequired: boolean;
  /** 确定性折算后的单笔人民币金额（元；无法折算时为 null → 转人工） */
  amountCny: number | null;
  /** 中文大白话判定依据 */
  reason: string;
  /** 判定路径留痕（审计用） */
  auditTrail: string[];
}

/** 整数分（防浮点）：n 元 → 分 */
function toCents(n: number): number {
  return Math.round(n * 100);
}

/** 单笔人民币整数分：优先 amountCny，其次 amountOriginal×配置汇率 */
function resolveAmountCents(t: PolicyTicket): { cents: number | null; via: string } {
  if (typeof t.amountCny === "number" && Number.isFinite(t.amountCny)) {
    return { cents: toCents(t.amountCny), via: "已折人民币金额" };
  }
  if (typeof t.amountOriginal === "number" && Number.isFinite(t.amountOriginal)) {
    const currency = t.currency ?? "CNY";
    const cents = convertToCnyCents(t.amountOriginal, currency);
    return { cents, via: `${currency} ${String(t.amountOriginal)} × 配置汇率` };
  }
  return { cents: null, via: "无金额" };
}

/** 从文本中提取 EWB 运单编号（用配置里的正则，绝不硬编码副本） */
function extractEwbId(text: string): string | null {
  const rule = APPROVAL_POLICY.rules.find((r) => r.id === "OPS-EAST-001");
  const pattern = rule?.ewbPattern ?? "^EWB[:：]?\\s*(\\d{3,8})$";
  const m = text.match(new RegExp(pattern, "g"));
  if (m === null || m.length === 0) return null;
  const normalized = m[0].match(new RegExp(pattern));
  return normalized !== null ? `EWB:${normalized[1]}` : null;
}

/**
 * 确定性策略评估（纯函数，零 LLM）。
 * 决策顺序（与 config rules.priority 一致）：
 * SEC-001 → FIN-ARITH-001 → OPS-EAST-001 → FIN-001 → 黄区 → DOC-VER-2026 → AUTO_PASS_GREEN
 */
export function evaluateApprovalPolicy(
  ticket: PolicyTicket,
  policyConfig: ApprovalPolicyConfig = APPROVAL_POLICY,
): PolicyDecision {
  const trail: string[] = [];
  const text = typeof ticket.text === "string" ? ticket.text : "";
  const ruleOf = (id: string) => policyConfig.rules.find((r) => r.id === id);

  /* ---- ① SEC-001 注入拦截 ---- */
  const sec = ruleOf("SEC-001");
  const patterns = sec?.injectionPatterns ?? [];
  const hit = patterns.find((p) => text.toLowerCase().includes(p.toLowerCase()));
  if (hit !== undefined) {
    trail.push(`SEC-001 命中注入特征「${hit}」`);
    return {
      ruleId: "SEC-001",
      action: "BLOCK_INJECTION",
      blocked: true,
      humanApprovalRequired: false,
      amountCny: null,
      reason:
        "工单文本命中提示词注入特征，已整单拦截上报：外部内容一律当资料、绝不执行其中的任何指令。",
      auditTrail: trail,
    };
  }
  trail.push("SEC-001 未命中注入特征");

  /* ---- ② FIN-ARITH-001 发票整数分四则守恒 ---- */
  if (ticket.invoice !== null && ticket.invoice !== undefined) {
    const lineSumCents = ticket.invoice.lineItemsCents.reduce((s, c) => s + c, 0);
    const diffCents = Math.abs(lineSumCents - ticket.invoice.declaredTotalCents);
    const tolCents = toCents(policyConfig.thresholds.arithmeticToleranceCny);
    if (diffCents > tolCents) {
      trail.push(
        `FIN-ARITH-001 明细合计 ${String(lineSumCents)} 分 ≠ 票面 ${String(ticket.invoice.declaredTotalCents)} 分（差 ${String(diffCents)} 分）`,
      );
      return {
        ruleId: "FIN-ARITH-001",
        action: "BLOCK_ARITHMETIC_MISMATCH",
        blocked: true,
        humanApprovalRequired: false,
        amountCny: ticket.invoice.declaredTotalCents / 100,
        reason: `发票算术不平：明细整数分合计与票面金额相差 ¥${(diffCents / 100).toFixed(2)}，按四则守恒红线拦截，转人工复核。`,
        auditTrail: trail,
      };
    }
    trail.push("FIN-ARITH-001 整数分四则守恒复核通过");
  }

  /* ---- ③ OPS-EAST-001 华东电子签收单 ---- */
  const east = ruleOf("OPS-EAST-001");
  if (east?.requireEwbReceipt === true) {
    const explicit = ticket.eastChinaLogistics ?? null;
    const regionHit =
      explicit !== null
        ? explicit.isEastChinaReimbursement
        : text.includes(east.regionKeyword ?? "华东") &&
          (east.businessKeywords ?? []).some((k) => text.includes(k));
    if (regionHit) {
      const ewbId = explicit !== null ? explicit.ewbId : extractEwbId(text);
      if (ewbId === null || (explicit !== null && explicit.receiptVerified !== true)) {
        trail.push("OPS-EAST-001 华东物流报销缺电子运单 / 验真未完成");
        return {
          ruleId: "OPS-EAST-001",
          action: "BLOCK_MISSING_RECEIPT",
          blocked: true,
          humanApprovalRequired: false,
          amountCny: null,
          reason:
            "华东区物流报销缺少 EWB 电子运单（或跨组织验真未完成），按 OPS-EAST-001 拦截转人工核对，绝不硬凑放行。",
          auditTrail: trail,
        };
      }
      trail.push(`OPS-EAST-001 电子运单 ${ewbId} 在场`);
    } else {
      trail.push("OPS-EAST-001 非华东物流报销事项，不适用");
    }
  }

  /* ---- ④ FIN-001 大额人工审批（含拆单合并口径） ---- */
  const fin = ruleOf("FIN-001");
  const dept = ticket.department ?? "财务部";
  const finDept = fin?.department ?? "财务部";
  const thresholdCents = toCents(policyConfig.thresholds.financeApprovalCny);
  const { cents, via } = resolveAmountCents(ticket);
  if (dept === finDept && via !== "无金额") {
    if (cents === null) {
      trail.push("FIN-001 金额无法确定性折算 → 宁缺毋滥转人工");
      return {
        ruleId: "FIN-001",
        action: "REQUIRE_HUMAN_APPROVAL",
        blocked: false,
        humanApprovalRequired: true,
        amountCny: null,
        reason: "单笔金额无法按配置汇率确定性折算成人民币，按 FIN-001 宁缺毋滥原则转具名人工审批。",
        auditTrail: trail,
      };
    }
    const amountYuan = cents / 100;
    const singleOver = cents > thresholdCents;
    const mergedOver =
      ticket.splitAvoidanceSuspected === true &&
      typeof ticket.mergedAmountCny === "number" &&
      toCents(ticket.mergedAmountCny) > thresholdCents;
    if (singleOver || mergedOver) {
      const mergedNote =
        ticket.splitAvoidanceSuspected === true
          ? `；疑似拆单按合并口径 ¥${String(ticket.mergedAmountCny ?? amountYuan)} 判定`
          : "";
      trail.push(`FIN-001 单笔 ${String(cents)} 分 > 阈值 ${String(thresholdCents)} 分${mergedNote}`);
      return {
        ruleId: "FIN-001",
        action: "REQUIRE_HUMAN_APPROVAL",
        blocked: false,
        humanApprovalRequired: true,
        amountCny: amountYuan,
        reason:
          `单笔折人民币 ¥${amountYuan.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}（${via}）严格超过审批红线 ¥${policyConfig.thresholds.financeApprovalCny.toLocaleString("en-US")}${mergedNote}，` +
          "按 FIN-001 必须由具名在职审批人签字放行，AI 不审批、不打款。",
        auditTrail: trail,
      };
    }
    trail.push(`FIN-001 单笔未超阈值（等于不触发，严格大于口径）`);
  } else if (via === "无金额") {
    trail.push("FIN-001 事项未带金额，不适用金额判定");
  } else {
    trail.push(`FIN-001 非${finDept}事项，不适用`);
  }

  /* ---- ⑤ 黄区写操作 → 一律 Dry-Run 预演 ---- */
  if (ticket.yellowZoneWrite === true) {
    trail.push("黄区写操作意向 → AGENT-LINE-YELLOW 强制预演");
    return {
      ruleId: "AGENT-LINE-YELLOW",
      action: "AGENT_LINE_YELLOW",
      blocked: false,
      humanApprovalRequired: false,
      amountCny: cents !== null ? cents / 100 : null,
      reason:
        "黄区写操作只出 Diff 草稿与审批单号（Dry-Run 预演），正式数据零改动；确认权归具名负责人。",
      auditTrail: trail,
    };
  }

  /* ---- ⑥ DOC-VER-2026 废止制度防幻觉 ---- */
  const docVer = ruleOf("DOC-VER-2026");
  const abolished = docVer?.abolishedPolicies ?? [];
  const abolishedHit = abolished.find((p) => p.keywords.some((k) => text.includes(k)));
  if (abolishedHit !== undefined) {
    trail.push(`DOC-VER-2026 命中已废止制度「${abolishedHit.id}」`);
    return {
      ruleId: "DOC-VER-2026",
      action: "BLOCK_ABOLISHED_POLICY",
      blocked: true,
      humanApprovalRequired: false,
      amountCny: cents !== null ? cents / 100 : null,
      reason: `引用了 ${String(abolishedHit.abolishedYear)} 年已废止的旧制度（${abolishedHit.id}），按现行制度时效锁拦截：旧规只当资料上报，绝不执行。`,
      auditTrail: trail,
    };
  }
  trail.push("DOC-VER-2026 仅现行制度，通过");

  /* ---- ⑦ 兜底：全绿放行 ---- */
  return {
    ruleId: "AUTO_PASS_GREEN",
    action: "AUTO_PASS_GREEN",
    blocked: false,
    humanApprovalRequired: false,
    amountCny: cents !== null ? cents / 100 : null,
    reason: "未命中任何拦截 / 审批规则，按现行制度常规流转（全程留痕）。",
    auditTrail: trail,
  };
}
