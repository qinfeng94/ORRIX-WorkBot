/**
 * adoption-ops —— Day 38 灰度采用监控台核心引擎（离线高仿真，零第三方依赖）
 *
 * 职责：
 *  1) 四硬指标快照（平均审单周期 / 人工返工率 / 绕行回 Excel 逃逸率 / 真实拦截止损额）——
 *     老板看板只认业务结果指标，Token 消耗、调用次数等过程虚荣指标物理不进本模块；
 *  2) 三阶段信任阶梯（Shadow 影子 → Assisted 辅助 → Supervised 全员扩量）状态计算；
 *  3) 20 单影子模式对拍：老员工历史结果 vs WorkBot 后台静默结果，一致率 + 分歧复盘；
 *  4) 对拍台账 data/day38/shadow_comparisons.jsonl 只增不改（无修改/删除通道）。
 *
 * 红线：影子对拍全程只读工单池快照，WorkBot 结果绝不推送给业务人员；
 *       无任何打款 / 写业务系统正式数据动作；示例单据均为虚构演示数据。
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/* ================= 一、四硬指标（老板看板） ================= */

export interface HardMetric {
  key: "auditCycleDays" | "reworkRate" | "bypassRate" | "interceptedLoss";
  label: string;
  unit: string;
  /** 朝哪个方向变化代表变好 */
  goodDirection: "down" | "up";
  /** 纯人工基线（试点前 30 天） */
  baseline: number;
  /** 试点首周危机值 */
  crisis: number;
  /** 抢救后当前值 */
  current: number;
  note: string;
}

export const HARD_METRICS: HardMetric[] = [
  {
    key: "auditCycleDays",
    label: "平均审单周期",
    unit: "天/单",
    goodDirection: "down",
    baseline: 3.8,
    crisis: 4.6,
    current: 1.6,
    note: "从工单进池到放行归档的平均时长（只读工单池统计口径）",
  },
  {
    key: "reworkRate",
    label: "人工返工率",
    unit: "%",
    goodDirection: "down",
    baseline: 8,
    crisis: 38,
    current: 12.5,
    note: "AI 草稿被人推翻重做 / 判单结论被打回重审的工单占比",
  },
  {
    key: "bypassRate",
    label: "绕行回 Excel 逃逸率",
    unit: "%",
    goodDirection: "down",
    baseline: 12,
    crisis: 45,
    current: 18,
    note: "本该在 WorkBot 处理却偷偷回 Excel 手工台账的单量占比（通道埋点实测，不是问卷）",
  },
  {
    key: "interceptedLoss",
    label: "真实拦截止损额",
    unit: "元",
    goodDirection: "up",
    baseline: 0,
    crisis: 0,
    current: 286400,
    note: "累计拦下的算术错误 / 疑似拆单 / 废止制度单据对应金额，均经人工复核确认真实风险",
  },
];

/** 抢救周 D1~D7 逐日趋势（返工率 / 绕行率，%） */
export interface RescueTrendPoint {
  day: string;
  reworkRate: number;
  bypassRate: number;
}

export const RESCUE_TREND: RescueTrendPoint[] = [
  { day: "D1", reworkRate: 34, bypassRate: 42 },
  { day: "D2", reworkRate: 29, bypassRate: 38 },
  { day: "D3", reworkRate: 24, bypassRate: 33 },
  { day: "D4", reworkRate: 19, bypassRate: 29 },
  { day: "D5", reworkRate: 16, bypassRate: 24 },
  { day: "D6", reworkRate: 14, bypassRate: 21 },
  { day: "D7", reworkRate: 12.5, bypassRate: 18 },
];

/* ================= 二、三阶段信任阶梯 ================= */

export type StageKey = "shadow" | "assisted" | "supervised";
export type StageStatus = "done" | "active" | "locked";

export interface LadderStageDef {
  key: StageKey;
  name: string;
  subtitle: string;
  entryCriteria: string[];
  dailyActions: string[];
  exitCriteria: string[];
  rollbackTriggers: string[];
  promotionTarget: string | null;
}

export const LADDER_STAGES: LadderStageDef[] = [
  {
    key: "shadow",
    name: "Shadow 影子模式",
    subtitle: "WorkBot 后台静默对拍，员工无感，零风险积累信任证据",
    entryCriteria: ["试点危机回退后自动入场", "对拍只读工单池快照，结果绝不推送给业务"],
    dailyActions: [
      "每日后台静默跑当日全量单据判定",
      "分歧自动三分类：人错机对 / 机错人对 / 双错",
      "分歧复盘会每日 15 分钟（王主管主持）",
    ],
    exitCriteria: [
      "连续 2 轮 20 单影子对拍一致率 ≥ 90%",
      "机错人对类分歧已回流为知识卡并复验通过",
      "人错机对类分歧已固化进复训清单",
    ],
    rollbackTriggers: ["影子结果外泄误导业务判单 → 立即暂停对拍通道并复盘"],
    promotionTarget: "Assisted 辅助模式",
  },
  {
    key: "assisted",
    name: "Assisted 辅助模式",
    subtitle: "5 人灰度：WorkBot 出草稿 + 证据卡，人点确认才生效（黄区起草）",
    entryCriteria: ["Shadow 晋级硬门槛全满足", "财务王主管 + 客服陈主管双人签字放行"],
    dailyActions: [
      "5 名灰度用户每日用草稿+确认流处理真实工单",
      "所有黄区写操作强制 dryRun:true 预演，只出 Diff 草稿卡",
      "逃逸率埋点每日盯防，谁绕回 Excel 当天 1v1 访谈",
    ],
    exitCriteria: [
      "灰度满 2 周：返工率 ≤ 10% 且绕行率 ≤ 10%",
      "红线事故 0 起（FIN-001 越权 / 未授权放行）",
      "灰度用户净推荐值 ≥ +30",
    ],
    rollbackTriggers: [
      "任一灰度用户绕行率回升 > 25%",
      "返工率连续 3 日 > 20%",
      "任何红线事故（零容忍）",
    ],
    promotionTarget: "Supervised 全员扩量",
  },
  {
    key: "supervised",
    name: "Supervised 全员扩量",
    subtitle: "全员开放 + 抽查监督：扩量不等于放手",
    entryCriteria: ["Assisted 晋级硬门槛全满足", "林总 / 王主管 / 陈总三人签字"],
    dailyActions: [
      "全员开放草稿+确认流，FIN-001 大额恒走人工审批",
      "每周随机抽查 5% 已放行工单复核",
      "双周复盘：四硬指标对照看板汇报管理层",
    ],
    exitCriteria: ["稳态运营阶段，无晋级目标，持续监督"],
    rollbackTriggers: [
      "周抽查错误率 > 5% → 回退 Assisted 缩回灰度组",
      "任何自动打款类越权迹象 → 5 秒物理 Kill Switch 切断",
    ],
    promotionTarget: null,
  },
];

/* ================= 三、20 单影子对拍数据集（确定性，虚构演示） ================= */

export type AuditVerdict = "通过" | "打回" | "转人工审批";
export type DivergenceWinner = "human" | "bot";

export interface ShadowCase {
  id: string;
  kind: "发票审核" | "付款申请" | "退款工单";
  vendor: string;
  amount: number;
  summary: string;
  humanVerdict: AuditVerdict;
  humanReason: string;
  humanMinutes: number;
  botVerdict: AuditVerdict;
  botReason: string;
  botSeconds: number;
  /** 第 1 轮（知识回流前）是否与老员工一致 */
  round1Match: boolean;
  /** 第 1 轮分歧时谁对（一致则为 null） */
  round1Winner: DivergenceWinner | null;
}

/** 供应商别名知识卡（抢救方案 D4 产物）：机错人对类分歧回流的实例 */
const ALIAS_KNOWLEDGE = {
  caseId: "SH-3811",
  vendor: "蓝湾物业",
  aliasOf: "蓝湾保洁（2026-06 更名，税号不变）",
  verdictAfter: "通过" as AuditVerdict,
  reasonAfter:
    "命中供应商别名索引知识卡：蓝湾物业 = 蓝湾保洁（2026-06 更名，税号一致），抬头不一致属登记滞后，放行并提示供应商主数据更新",
};

const SHADOW_CASES: ShadowCase[] = [
  { id: "SH-3801", kind: "发票审核", vendor: "华彩文具", amount: 4280, summary: "货单票齐全，金额与合同一致", humanVerdict: "通过", humanReason: "单据齐全，放行", humanMinutes: 9, botVerdict: "通过", botReason: "三单匹配一致，关键字段完整", botSeconds: 38, round1Match: true, round1Winner: null },
  { id: "SH-3802", kind: "发票审核", vendor: "蓝湾物业", amount: 36000, summary: "申报总额 36,000，但 数量×单价=35,280，差 720 元", humanVerdict: "打回", humanReason: "算术对不上，退回重开", humanMinutes: 14, botVerdict: "打回", botReason: "Σ 数量×单价=35,280 ≠ 申报总额 36,000，算术校验不通过", botSeconds: 36, round1Match: true, round1Winner: null },
  { id: "SH-3803", kind: "付款申请", vendor: "恒达钢材", amount: 86000, summary: "单笔 86,000 元，超过 FIN-001 红线", humanVerdict: "转人工审批", humanReason: "超 5 万，必须具名审批人签字", humanMinutes: 11, botVerdict: "转人工审批", botReason: "金额 > ¥50,000 触发 FIN-001 强制人工审批（严格大于，AI 不当审批人）", botSeconds: 40, round1Match: true, round1Winner: null },
  { id: "SH-3804", kind: "发票审核", vendor: "远航印刷", amount: 50000, summary: "恰好 50,000 元整的边界单", humanVerdict: "通过", humanReason: "正好 5 万不算超，按规矩放行", humanMinutes: 12, botVerdict: "通过", botReason: "等于 ¥50,000 不触发 FIN-001（只有严格大于才触发）", botSeconds: 37, round1Match: true, round1Winner: null },
  { id: "SH-3805", kind: "付款申请", vendor: "恒达钢材", amount: 59400, summary: "同日同供应商 3 笔 × 19,800，合计 59,400", humanVerdict: "通过", humanReason: "逐笔各 19,800 都没超 5 万，放行", humanMinutes: 10, botVerdict: "转人工审批", botReason: "合并口径 59,400 > ¥50,000 且同日同供应商疑似拆单，按 FIN-001 合并处理并上报", botSeconds: 45, round1Match: false, round1Winner: "bot" },
  { id: "SH-3806", kind: "退款工单", vendor: "千慧咨询", amount: 12000, summary: "附件引用《付款管理办法（2019 旧版）》10 万额度条款", humanVerdict: "通过", humanReason: "引用了制度条文，看着挺正规", humanMinutes: 13, botVerdict: "打回", botReason: "引用已废止 2019 旧版 10 万额度制度——旧规只当资料上报，按现行 FIN-001 口径处理", botSeconds: 42, round1Match: false, round1Winner: "bot" },
  { id: "SH-3807", kind: "发票审核", vendor: "宏图广告", amount: 15600, summary: "发票税号与供应商登记主体不符", humanVerdict: "打回", humanReason: "税号对不上，打回", humanMinutes: 8, botVerdict: "打回", botReason: "发票税号与供应商主数据不一致，打回核实", botSeconds: 39, round1Match: true, round1Winner: null },
  { id: "SH-3808", kind: "发票审核", vendor: "华彩文具", amount: 4280, summary: "与 SH-3801 同发票号重复提交", humanVerdict: "打回", humanReason: "这单之前审过了，重复提交", humanMinutes: 6, botVerdict: "打回", botReason: "发票号与 SH-3801 重复，命中重复申报拦截", botSeconds: 35, round1Match: true, round1Winner: null },
  { id: "SH-3809", kind: "付款申请", vendor: "洋帆进出口", amount: 68500, summary: "USD 折算后 68,500 元，汇率与合同约定一致", humanVerdict: "转人工审批", humanReason: "折算完超 5 万，走审批", humanMinutes: 15, botVerdict: "转人工审批", botReason: "折算金额 68,500 > ¥50,000 触发 FIN-001", botSeconds: 44, round1Match: true, round1Winner: null },
  { id: "SH-3810", kind: "付款申请", vendor: "华中智造", amount: 120000, summary: "超出合同上限 80,000 元", humanVerdict: "打回", humanReason: "合同上限 8 万，这单 12 万，打回", humanMinutes: 16, botVerdict: "打回", botReason: "超出合同上限 ¥80,000，打回并提示业务方重签补充协议", botSeconds: 41, round1Match: true, round1Winner: null },
  { id: "SH-3811", kind: "发票审核", vendor: "蓝湾物业", amount: 9900, summary: "发票抬头「蓝湾物业」与供应商登记名「蓝湾保洁」不一致（2026-06 更名）", humanVerdict: "通过", humanReason: "这家原来叫蓝湾保洁，6 月改的名，我认识，放行", humanMinutes: 7, botVerdict: "打回", botReason: "发票抬头与供应商登记名不一致，打回核实", botSeconds: 38, round1Match: false, round1Winner: "human" },
  { id: "SH-3812", kind: "发票审核", vendor: "迅捷物流", amount: 7200, summary: "发票日期晚于合同终止日 15 天", humanVerdict: "打回", humanReason: "合同都终止了还开票，打回", humanMinutes: 9, botVerdict: "打回", botReason: "发票日期晚于合同有效期，打回", botSeconds: 36, round1Match: true, round1Winner: null },
  { id: "SH-3813", kind: "退款工单", vendor: "千慧咨询", amount: 3500, summary: "退款申请附件缺失", humanVerdict: "打回", humanReason: "附件都没有，退回补件", humanMinutes: 5, botVerdict: "打回", botReason: "必填附件缺失，打回补件", botSeconds: 34, round1Match: true, round1Winner: null },
  { id: "SH-3814", kind: "退款工单", vendor: "客户 李*明（已脱敏）", amount: 6600, summary: "工单正文含客户身份证明文", humanVerdict: "通过", humanReason: "按规范脱敏后正常受理", humanMinutes: 8, botVerdict: "通过", botReason: "PII 已脱敏为 [REDACTED_PII]，工单本身合规受理", botSeconds: 37, round1Match: true, round1Winner: null },
  { id: "SH-3815", kind: "发票审核", vendor: "宏图广告", amount: 8800, summary: "正常单，三单匹配", humanVerdict: "通过", humanReason: "没问题，放行", humanMinutes: 7, botVerdict: "通过", botReason: "三单匹配一致", botSeconds: 35, round1Match: true, round1Winner: null },
  { id: "SH-3816", kind: "付款申请", vendor: "洋帆进出口", amount: 23000, summary: "用旧汇率折算，差异 4.2%", humanVerdict: "打回", humanReason: "汇率不对，按当期汇率重报", humanMinutes: 12, botVerdict: "打回", botReason: "折算汇率与当期牌价差 4.2%，打回重报", botSeconds: 40, round1Match: true, round1Winner: null },
  { id: "SH-3817", kind: "发票审核", vendor: "远航印刷", amount: 21000, summary: "附件清晰齐全，正常单", humanVerdict: "通过", humanReason: "清楚，放行", humanMinutes: 8, botVerdict: "通过", botReason: "关键字段置信度达标，放行", botSeconds: 36, round1Match: true, round1Winner: null },
  { id: "SH-3818", kind: "付款申请", vendor: "华中智造", amount: 46000, summary: "合同内且未超上限", humanVerdict: "通过", humanReason: "没超 5 万也没超合同，放行", humanMinutes: 10, botVerdict: "通过", botReason: "金额 ≤ ¥50,000 且合同内，放行", botSeconds: 37, round1Match: true, round1Winner: null },
  { id: "SH-3819", kind: "退款工单", vendor: "千慧咨询", amount: 18800, summary: "退款理由与合同退款条款冲突", humanVerdict: "打回", humanReason: "合同里没这条退款情形，打回", humanMinutes: 14, botVerdict: "打回", botReason: "退款理由与合同条款冲突，打回", botSeconds: 43, round1Match: true, round1Winner: null },
  { id: "SH-3820", kind: "发票审核", vendor: "迅捷物流", amount: 5800, summary: "正常单", humanVerdict: "通过", humanReason: "放行", humanMinutes: 6, botVerdict: "通过", botReason: "三单匹配一致", botSeconds: 34, round1Match: true, round1Winner: null },
];

/* ================= 四、影子对拍执行（第 1 轮 vs 知识回流后） ================= */

export interface ShadowPairResult {
  id: string;
  kind: ShadowCase["kind"];
  vendor: string;
  amount: number;
  summary: string;
  humanVerdict: AuditVerdict;
  humanReason: string;
  humanMinutes: number;
  botVerdict: AuditVerdict;
  botReason: string;
  botSeconds: number;
  match: boolean;
  winner: DivergenceWinner | null;
  /** 分歧处置建议 */
  disposition: string;
}

export interface ShadowReport {
  runId: string;
  round: number;
  ranAt: string;
  total: number;
  matched: number;
  consistencyRate: number;
  /** 晋级线（0.9） */
  passThreshold: number;
  /** 截至本轮，连续达晋级线的轮数 */
  consecutivePassRounds: number;
  /** 连续 2 轮达标 = Shadow 阶段晋级门槛满足 */
  promotionReady: boolean;
  /** 本轮是否已应用供应商别名知识卡（抢救方案 D4 产物） */
  aliasKnowledgeApplied: boolean;
  /** 本次对拍 WorkBot 比老员工多拦下的争议金额（元） */
  botExtraIntercepted: number;
  humanAvgMinutes: number;
  botAvgSeconds: number;
  pairs: ShadowPairResult[];
  divergences: ShadowPairResult[];
}

export interface ShadowLedgerEntry {
  ts: string;
  event: "shadow_comparison";
  runId: string;
  round: number;
  matched: number;
  total: number;
  /** 0~1 */
  consistencyRate: number;
  aliasKnowledgeApplied: boolean;
  botExtraIntercepted: number;
  divergences: { id: string; winner: DivergenceWinner; amount: number }[];
}

const LEDGER_PATH = join(process.cwd(), "data", "day38", "shadow_comparisons.jsonl");
const PASS_THRESHOLD = 0.9;

/** 读取对拍台账（只增不改；文件不存在或行损坏按 0 条处理，绝不抛错中断） */
async function readShadowLedger(): Promise<ShadowLedgerEntry[]> {
  let raw: string;
  try {
    raw = await readFile(LEDGER_PATH, "utf8");
  } catch {
    return [];
  }
  const entries: ShadowLedgerEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as ShadowLedgerEntry;
      if (parsed.event === "shadow_comparison" && typeof parsed.round === "number") {
        entries.push(parsed);
      }
    } catch {
      /* 损坏行跳过，不影响其余台账 */
    }
  }
  return entries;
}

/** 截至最新一轮，连续一致率 ≥ 90% 的轮数 */
function countConsecutivePass(entries: ShadowLedgerEntry[]): number {
  let streak = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].consistencyRate >= PASS_THRESHOLD) streak += 1;
    else break;
  }
  return streak;
}

function buildDisposition(winner: DivergenceWinner | null, match: boolean): string {
  if (match) return "结论一致，无需复盘";
  if (winner === "bot") return "人错机对 → 固化进复训清单 + 规则复核，本周复训会讲评";
  return "机错人对 → 老员工业务知识回流为知识卡，下一轮对拍生效";
}

/** 执行一轮 20 单影子对拍；round ≥ 2 时应用别名知识卡（D4 抢救产物） */
export async function runShadowComparison(): Promise<ShadowReport> {
  const ledger = await readShadowLedger();
  const round = ledger.length + 1;
  const aliasApplied = round >= 2;

  const pairs: ShadowPairResult[] = SHADOW_CASES.map((c) => {
    const aliasHit = aliasApplied && c.id === ALIAS_KNOWLEDGE.caseId;
    const botVerdict = aliasHit ? ALIAS_KNOWLEDGE.verdictAfter : c.botVerdict;
    const botReason = aliasHit ? ALIAS_KNOWLEDGE.reasonAfter : c.botReason;
    const match = aliasHit ? true : c.round1Match;
    const winner = aliasHit ? null : c.round1Winner;
    return {
      id: c.id,
      kind: c.kind,
      vendor: c.vendor,
      amount: c.amount,
      summary: c.summary,
      humanVerdict: c.humanVerdict,
      humanReason: c.humanReason,
      humanMinutes: c.humanMinutes,
      botVerdict,
      botReason,
      botSeconds: c.botSeconds,
      match,
      winner,
      disposition: buildDisposition(winner, match),
    };
  });

  const divergences = pairs.filter((p) => !p.match);
  const matched = pairs.length - divergences.length;
  const botExtraIntercepted = divergences
    .filter((d) => d.winner === "bot")
    .reduce((sum, d) => sum + d.amount, 0);
  const humanAvgMinutes =
    pairs.reduce((sum, p) => sum + p.humanMinutes, 0) / pairs.length;
  const botAvgSeconds =
    pairs.reduce((sum, p) => sum + p.botSeconds, 0) / pairs.length;

  // 组装台账行（提问/单据原文不落日志，只落单号与结论摘要——PII 防线）
  const entry: ShadowLedgerEntry = {
    ts: new Date().toISOString(),
    event: "shadow_comparison",
    runId: `SHADOW-${String(round).padStart(2, "0")}-${Date.now()}`,
    round,
    matched,
    total: pairs.length,
    consistencyRate: matched / pairs.length,
    aliasKnowledgeApplied: aliasApplied,
    botExtraIntercepted,
    divergences: divergences.map((d) => ({
      id: d.id,
      winner: d.winner ?? "bot",
      amount: d.amount,
    })),
  };

  // 台账只增不改：appendFile 追加，无任何 UPDATE/DELETE 通道
  await mkdir(dirname(LEDGER_PATH), { recursive: true });
  await appendFile(LEDGER_PATH, JSON.stringify(entry) + "\n", "utf8");

  const history = [...ledger, entry];
  return {
    runId: entry.runId,
    round,
    ranAt: entry.ts,
    total: pairs.length,
    matched,
    consistencyRate: entry.consistencyRate,
    passThreshold: PASS_THRESHOLD,
    consecutivePassRounds: countConsecutivePass(history),
    promotionReady: countConsecutivePass(history) >= 2,
    aliasKnowledgeApplied: aliasApplied,
    botExtraIntercepted,
    humanAvgMinutes,
    botAvgSeconds,
    pairs,
    divergences,
  };
}

/* ================= 五、监控台快照 ================= */

export interface LadderStageState extends LadderStageDef {
  status: StageStatus;
  /** 阶段进度 0~100 */
  progressPct: number;
  progressLabel: string;
}

export interface AdoptionSnapshot {
  metrics: HardMetric[];
  trend: RescueTrendPoint[];
  stages: LadderStageState[];
  currentStage: StageKey;
  lastReport: ShadowLedgerEntry | null;
  totalRuns: number;
  consecutivePassRounds: number;
}

export async function getAdoptionSnapshot(): Promise<AdoptionSnapshot> {
  const ledger = await readShadowLedger();
  const last = ledger.length > 0 ? ledger[ledger.length - 1] : null;
  const streak = countConsecutivePass(ledger);
  const shadowDone = streak >= 2;

  const shadowProgressPct =
    last === null ? 0 : Math.min((last.consistencyRate / PASS_THRESHOLD) * 100, 100);
  const stages: LadderStageState[] = LADDER_STAGES.map((s) => {
    if (s.key === "shadow") {
      return {
        ...s,
        status: shadowDone ? "done" : "active",
        progressPct: Math.round(shadowProgressPct),
        progressLabel:
          last === null
            ? "尚未运行对拍——点下方按钮跑第 1 轮"
            : shadowDone
              ? `连续 ${String(streak)} 轮一致率 ≥ 90%，晋级门槛已满足`
              : `最近一轮一致率 ${String(Math.round(last.consistencyRate * 100))}% / 晋级线 90%，连续达标 ${String(streak)}/2 轮`,
      };
    }
    if (s.key === "assisted") {
      return {
        ...s,
        status: shadowDone ? "active" : "locked",
        progressPct: shadowDone ? 5 : 0,
        progressLabel: shadowDone
          ? "晋级门槛已满足，等待王主管 + 陈主管双人签字入场"
          : "上锁——先通过 Shadow 影子模式晋级线",
      };
    }
    return {
      ...s,
      status: "locked" as StageStatus,
      progressPct: 0,
      progressLabel: "上锁——Assisted 辅助模式灰度达标后三人签字入场",
    };
  });

  return {
    metrics: HARD_METRICS,
    trend: RESCUE_TREND,
    stages,
    currentStage: "shadow",
    lastReport: last,
    totalRuns: ledger.length,
    consecutivePassRounds: streak,
  };
}
