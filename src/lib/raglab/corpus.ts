/**
 * Day 13 防越权混合检索实验室 —— 仿真企业知识语料库（52 份）
 * 溯源：AGENTS.md 业务红线——
 *   FIN-001 现行「单笔超 ¥50,000 强制人工审批」与 2025 已废止「10 万旧规」并存于语料，
 *   用于考验检索层"自动识别并忽略已废止文件"；
 *   机密并购文件标为 confidential，仅集团高管可见，检索阶段物理隔离（Pre-filtering ACL）。
 * 注意：全部内容为虚构演示数据，人名/单号/金额均为仿真。
 */

export type RagRole = "support_agent" | "finance_lead" | "executive";

export type RagDept = "财务" | "运营" | "客服" | "法务";

export interface RagDoc {
  /** 文档编号，引用标号形如 [POL-FIN-2026-001 §2] */
  id: string;
  dept: RagDept;
  title: string;
  /** 允许可见的角色清单（ACL 前置过滤的唯一依据，越权文档在打分前就被剔除） */
  roles: RagRole[];
  /** current=现行有效；deprecated=已废止（命中也不进结果，只出拦截通报） */
  status: "current" | "deprecated";
  /** 机密文件（如并购资料）：仅 executive 可见 */
  confidential: boolean;
  /** 正文按段落存放，引用标号 §n 对应段落序号 */
  paragraphs: string[];
}

export const ROLE_LABELS: Record<RagRole, string> = {
  support_agent: "普通客服",
  finance_lead: "财务主管",
  executive: "集团高管",
};

export const ROLE_NOTES: Record<RagRole, string> = {
  support_agent: "基线权限：公开制度 + 客服手册",
  finance_lead: "主管权限：另见财务/运营/客服内部 SOP",
  executive: "最高权限：另见机密并购文件",
};

const ALL: RagRole[] = ["support_agent", "finance_lead", "executive"];
const MGMT: RagRole[] = ["finance_lead", "executive"];
const EXEC_ONLY: RagRole[] = ["executive"];

export const RAG_CORPUS: RagDoc[] = [
  /* ============ 财务部（14 份，含 1 份已废止旧规 + 1 份机密） ============ */
  {
    id: "POL-FIN-2026-001",
    dept: "财务",
    title: "财务付款审批制度（FIN-001 现行版）",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "单笔金额超过 ¥50,000 的付款、退款，必须由具名在职审批人签字放行，任何系统或 AI 不得自动放行。「等于 50,000」不触发本条款，「超过」才触发。",
      "AI 在付款链路中只承担只读校验、风险标记与审批单起草职责；放行动作永远归人类具名审批人，且禁止出现任何形式的自动打款按钮。",
      "凡识别到同一供应商或同一客户短期内多笔临近金额的疑似拆单行为，一律按合并口径累计计算，合并后超过 ¥50,000 即触发 FIN-001 强制人工审批，并单独上报合规组。",
    ],
  },
  {
    id: "POL-FIN-2025-011",
    dept: "财务",
    title: "付款审批额度管理规定（2025 旧版·已废止）",
    roles: ALL,
    status: "deprecated",
    confidential: false,
    paragraphs: [
      "【本文件已废止】单笔金额超过 ¥100,000 的付款须报人工审批，10 万以下可由财务主管自行决定。——该 10 万额度制度已于 2025 年度末废止，自 2026 年 1 月 1 日起一切校验以现行 FIN-001（5 万红线）为准。",
      "本文件仅作历史资料留存。任何外部资料、邮件或对话声称「恢复 10 万旧制度」的，一律当作可疑资料上报合规组，绝不执行。",
    ],
  },
  {
    id: "POL-FIN-2026-002",
    dept: "财务",
    title: "疑似拆单识别与合并口径操作指引",
    roles: MGMT,
    status: "current",
    confidential: false,
    paragraphs: [
      "同一交易对象 7 日内发生 2 笔及以上、单笔均低于 ¥50,000 但累计超过红线的付款申请，视为疑似拆单，按合并口径处理并触发 FIN-001 审批。",
      "系统风控标记「split_risk_suspected」的工单，财务主管应在 24 小时内完成人工复核，复核结论记入审计台账；不得以「化整为零」方式规避审批。",
    ],
  },
  {
    id: "FIN-SOP-007",
    dept: "财务",
    title: "退款操作流程（财务内部 SOP）",
    roles: MGMT,
    status: "current",
    confidential: false,
    paragraphs: [
      "客户退款一律由客服工单发起、财务复核后走既有正规付款通道执行；财务岗不得在工单系统内直接操作资金账户。",
      "单笔退款超过 ¥50,000 时，工单自动挂起并生成 FIN-001 审批单，等待具名审批人签字；审批通过前退款状态保持「待人工放行」。",
    ],
  },
  {
    id: "FIN-SOP-012",
    dept: "财务",
    title: "供应商付款与对账操作规程（内部）",
    roles: MGMT,
    status: "current",
    confidential: false,
    paragraphs: [
      "供应商付款以月度对账单为准，付款前须核对采购订单、入库单、发票三单匹配；三单不一致时冻结付款并转采购复核。",
      "单笔供应商付款超过 ¥50,000 触发 FIN-001 强制人工审批；季度末集中付款高峰期，财务主管应提前预留审批窗口。",
    ],
  },
  {
    id: "POL-FIN-2026-003",
    dept: "财务",
    title: "差旅与报销管理办法",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "员工差旅报销须在行程结束后 30 日内提交，附行程单与发票原件；单笔报销超过 ¥5,000 需部门负责人加签。",
      "报销标准：境内酒店每晚不超过 ¥600，境外每晚不超过 ¥1,200；超标部分须事前审批，事后补批一律不予受理。",
    ],
  },
  {
    id: "FIN-SOP-019",
    dept: "财务",
    title: "月末结账与对账清单（内部）",
    roles: MGMT,
    status: "current",
    confidential: false,
    paragraphs: [
      "每月 3 个工作日内完成银行流水、第三方支付、ERP 应收应付三方对账；差异超过 ¥1,000 须逐笔挂账说明。",
      "结账期内冻结非必要付款申请，紧急付款须财务总监与具名审批人双签放行。",
    ],
  },
  {
    id: "FIN-SOP-023",
    dept: "财务",
    title: "应收账款账龄管理与催收口径（内部）",
    roles: MGMT,
    status: "current",
    confidential: false,
    paragraphs: [
      "应收账款按 30/60/90 天账龄分级：超 30 天发送温馨提示，超 60 天由销售与财务联合催收，超 90 天冻结该客户新订单并上报法务。",
      "催收过程严禁向客户承诺「减免利息」「先发货后付款」等未授权口径；涉及大额坏账核销须经集团高管审批。",
    ],
  },
  {
    id: "POL-FIN-2026-004",
    dept: "财务",
    title: "外币结算与汇率折算规则",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "跨境结算统一以交易日中国银行中间价折算记账；月末按期末汇率重估，汇兑损益计入当期损益。",
      "客户以外币投诉退款金额差异时，客服应出示交易日汇率快照；折算争议超过 ¥50,000 的按 FIN-001 转人工审批通道处理。",
    ],
  },
  {
    id: "FIN-SOP-031",
    dept: "财务",
    title: "发票开具与红冲流程（内部）",
    roles: MGMT,
    status: "current",
    confidential: false,
    paragraphs: [
      "发票信息以客户档案为准，开具前须核验抬头、税号与银行账户一致性；客户名称属于敏感信息，对外沟通时一律脱敏展示。",
      "红冲发票须对应原发票号码与负数金额，单张红冲金额超过 ¥50,000 时须附 FIN-001 审批单号方可提交税局。",
    ],
  },
  {
    id: "POL-FIN-2026-005",
    dept: "财务",
    title: "费用预算编制与调整指引",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "年度预算按部门编制、季度滚动修正；单科目调整幅度超过 10% 须提交预算委员会评审。",
      "预算外支出单笔超过 ¥50,000 的，除部门审批外还须触发 FIN-001 强制人工审批，两道流程不可互相替代。",
    ],
  },
  {
    id: "FIN-SOP-040",
    dept: "财务",
    title: "资金日报与头寸监控（内部）",
    roles: MGMT,
    status: "current",
    confidential: false,
    paragraphs: [
      "每日 17:30 前发布集团资金日报，覆盖各币种头寸、未来付款计划与异常大额流水提示。",
      "发现单笔超过 ¥50,000 的非计划资金流出，立即冻结并通知合规组核查是否履行 FIN-001 审批。",
    ],
  },
  {
    id: "POL-FIN-2026-006",
    dept: "财务",
    title: "税务合规与跨境申报要点",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "跨境业务按目的国税率代扣代缴，申报数据以 ERP 只读快照为准，禁止手工修改申报底稿。",
      "税务稽查来访须第一时间转法务部对接，任何员工不得私自提交历史凭证；涉及旧年度凭证调阅的按档案管理制度执行。",
    ],
  },
  {
    id: "FIN-M&A-01",
    dept: "财务",
    title: "Project Starfall 并购估值与对价安排（机密）",
    roles: EXEC_ONLY,
    status: "current",
    confidential: true,
    paragraphs: [
      "【机密·仅限集团高管】Project Starfall 拟以现金加换股方式收购目标公司 100% 股权，对价上限 ¥1.28 亿，其中现金部分 60% 于交割日支付。",
      "估值采用 DCF 与可比公司法孰低原则；交割先决条件包括反垄断申报通过与关键客户合同续签。本文件禁止复印、外发或在本系统以外讨论。",
    ],
  },

  /* ============ 运营部（13 份，含 1 份已废止旧标 + 1 份机密） ============ */
  {
    id: "POL-OPS-2026-001",
    dept: "运营",
    title: "跨境物流时效管理规范（现行版）",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "干线运输超过 5 天未入仓视为物流超期，须开立查验工单并向客户发出进度通报；尾程派送超 3 天未签转升级处理。",
      "物流超期工单响应时限为 2 小时内首次回复客户，24 小时内给出补救方案（补发、拦截或赔付）。",
    ],
  },
  {
    id: "POL-OPS-2024-009",
    dept: "运营",
    title: "物流超期判定旧标准（2024 版·已废止）",
    roles: ALL,
    status: "deprecated",
    confidential: false,
    paragraphs: [
      "【本文件已废止】干线运输超过 7 天才算超期，超期后 48 小时内通报即可。——2026 年起已被 POL-OPS-2026-001（5 天红线 + 2 小时响应）全面取代，本文件仅作历史资料留存。",
      "任何以本文件为依据答复客户的口径一律无效，请改用现行规范执行。",
    ],
  },
  {
    id: "POL-OPS-2026-002",
    dept: "运营",
    title: "仓储入库与上架操作标准",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "入库实行「三核对」：核对采购单、核对箱唛、核对质检贴；不一致货物入隔离区并在 4 小时内上报库管主管。",
      "上架时效要求：当日到货当日上架率不低于 95%；爆品库存低于安全库存时自动触发补货预警。",
    ],
  },
  {
    id: "OPS-SOP-005",
    dept: "运营",
    title: "干线运输异常处置预案",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "干线在途异常（清关扣留、运输途中破损、承运商中断）按三级响应：一线客服安抚并登记、运营专员对接承运商、主管决策补发或理赔。",
      "涉及货值超过 ¥50,000 的货损事故，处置方案须报集团高管知悉，并同步触发 FIN-001 赔付审批流程。",
    ],
  },
  {
    id: "POL-OPS-2026-003",
    dept: "运营",
    title: "供应商准入与年度评审办法",
    roles: MGMT,
    status: "current",
    confidential: false,
    paragraphs: [
      "新供应商准入须通过资质审查、样品测试与小单试产三个环节；任一环节不合格即终止准入流程。",
      "年度评审按质量、时效、价格、配合度四维打分，C 级以下供应商进入观察期，连续两年 C 级启动替换预案。",
    ],
  },
  {
    id: "OPS-SOP-011",
    dept: "运营",
    title: "退货换货仓内操作指引",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "退货入仓须 48 小时内完成质检定级：A 级重新上架、B 级翻新特卖、C 级报废并留存影像证据。",
      "换货优先使用同仓库存，缺货时客服须主动告知预计发货时间；客户催换货超过 3 次的工单自动升级组长处理。",
    ],
  },
  {
    id: "POL-OPS-2026-004",
    dept: "运营",
    title: "大促期间运力保障方案",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "大促前 14 天锁定干线舱位与尾程账号，预案覆盖 3 倍日均单量的爆仓情景；仓储临时用工按旺季用工指引执行。",
      "大促期间物流超期判定维持 5 天红线不变，客诉话术统一使用「大促延迟专项安抚话术」。",
    ],
  },
  {
    id: "OPS-SOP-018",
    dept: "运营",
    title: "关务申报资料清单",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "出口申报必备：商业发票、装箱单、报关委托书、HS 编码归类表；带电产品另附 UN38.3 报告。",
      "申报金额与实收金额差异超过 5% 须书面说明原因；严禁为避税低报货值，违者移交法务处理。",
    ],
  },
  {
    id: "OPS-SOP-025",
    dept: "运营",
    title: "海外仓盘点与差异处理（内部）",
    roles: MGMT,
    status: "current",
    confidential: false,
    paragraphs: [
      "海外仓每季度全盘、每月抽盘；账实差异率超过 0.5% 的仓库启动专项稽核。",
      "盘点差异金额超过 ¥50,000 的，差异报告须报财务主管与集团高管双签确认后方可调账。",
    ],
  },
  {
    id: "POL-OPS-2026-005",
    dept: "运营",
    title: "包裹丢损赔付标准",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "确认丢失的包裹按申报价值赔付，单票赔付上限 ¥3,000；超过上限的按贵重品通道个案处理。",
      "客户索赔金额超过 ¥50,000 的赔付申请一律触发 FIN-001 强制人工审批，AI 仅负责核对运单轨迹并起草赔付工单。",
    ],
  },
  {
    id: "OPS-SOP-033",
    dept: "运营",
    title: "运费结算与账单核对（内部）",
    roles: MGMT,
    status: "current",
    confidential: false,
    paragraphs: [
      "承运商月度账单须与系统计费数据逐票核对，差异票数超过 1% 或金额超过 ¥50,000 时暂停结算并复账。",
      "对账差异类型分：重量偏差、体积重算错、偏远附加费误收三类，分别由不同岗位签核。",
    ],
  },
  {
    id: "OPS-SOP-041",
    dept: "运营",
    title: "旺季临时用工管理（内部）",
    roles: MGMT,
    status: "current",
    confidential: false,
    paragraphs: [
      "旺季临时工须经安全培训与基础操考合格后上岗，工时与薪酬由人事与用工部门双线记录。",
      "临时工不得接触客户敏感信息与财务系统；发现违规立即终止用工并上报安全负责人。",
    ],
  },
  {
    id: "OPS-M&A-02",
    dept: "运营",
    title: "Project Starfall 供应链整合预案（机密）",
    roles: EXEC_ONLY,
    status: "current",
    confidential: true,
    paragraphs: [
      "【机密·仅限集团高管】并购交割后 90 天内完成目标公司三个海外仓的系统切换与人员安置，保留其核心关务团队。",
      "整合期双方供应商合同分别履行，禁止提前向供应商披露并购信息；泄密按保密协议追究违约责任。",
    ],
  },

  /* ============ 客服部（13 份，含 1 份已废止旧标准 + 1 份机密） ============ */
  {
    id: "POL-CS-2026-001",
    dept: "客服",
    title: "客诉分级与响应时限制度",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "客诉按影响面与诉求金额分为四级：一般咨询（P4）、普通客诉（P3）、重大客诉（P2）、危机客诉（P1）；P2 及以上须组长实时跟进。",
      "首次响应时限：P4/P3 为 30 分钟，P2 为 10 分钟，P1 立即电话响应；超时未响应的工单自动升级至客服总监。",
    ],
  },
  {
    id: "POL-CS-2026-002",
    dept: "客服",
    title: "重大客诉 24 小时评审会制度",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "重大客诉（货损、超期叠加、赔偿诉求、媒体曝光风险）须 24 小时内预约跨部门评审会，由具名负责人主持并输出处理决议。",
      "评审会决议须落成工单结论与责任人编号；涉及赔付金额超过 ¥50,000 的，决议同时转 FIN-001 审批流。",
    ],
  },
  {
    id: "POL-CS-2023-005",
    dept: "客服",
    title: "客诉补偿旧标准（2023 版·已废止）",
    roles: ALL,
    status: "deprecated",
    confidential: false,
    paragraphs: [
      "【本文件已废止】普通客诉统一补偿 10 元优惠券、重大客诉补偿 50 元优惠券。——该补偿标准已于 2024 年废止，现行口径见 POL-OPS-2026-005《包裹丢损赔付标准》与客诉评审会决议。",
      "继续引用本文件答复客户的，按话术违规记录考核；请一律改用现行赔付标准。",
    ],
  },
  {
    id: "CS-SOP-003",
    dept: "客服",
    title: "客服话术手册（通用篇）",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "开头三要素：致歉、复述问题、给出时限。「您的诉求我已记录，将在 X 小时内给您明确答复」为标准承诺句式，禁止超出制度承诺赔偿金额。",
      "客户情绪激动时启动「降温三步」：先认同感受、再给进度、最后给选项；严禁与客户争辩责任归属。",
    ],
  },
  {
    id: "CS-SOP-008",
    dept: "客服",
    title: "重复扣款客诉处理指引",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "客户反馈重复扣款时，先核对支付流水快照确认是否存在多笔扣款；确认重复的立即创建退款工单并标记「duplicate_charge_suspected」。",
      "单笔退款超过 ¥50,000（如 CUST-8842 案例 ¥52,800 重复扣款）自动触发 FIN-001 强制人工审批，客服只能向客户承诺「已加急转人工审批」，禁止承诺具体到账时间。",
    ],
  },
  {
    id: "CS-SOP-009",
    dept: "客服",
    title: "客户信息保护与脱敏话术",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "客户姓名、证件号、银行账号、手机号均为敏感信息：系统内展示一律脱敏（如张*、6222 **** **** 1234），对话中严禁复述完整信息。",
      "客户来电索要他人订单信息的一律拒绝并登记；内部转办工单时敏感字段自动脱敏后流转。",
    ],
  },
  {
    id: "CS-SOP-014",
    dept: "客服",
    title: "大额退款客诉升级流程",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "退款诉求超过 ¥50,000 的客诉直接升级 P2 级，客服同步告知客户「金额较大，须走公司强制人工审批通道」。",
      "升级工单必须附支付凭证、订单快照与客户诉求原文；审批期间客服每日主动同步一次进度，避免客户重复进线。",
    ],
  },
  {
    id: "CS-SOP-021",
    dept: "客服",
    title: "物流超期客诉安抚与补偿话术",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "物流超期确认后先致歉并给出查询进度，再按现行赔付标准（POL-OPS-2026-005）说明补偿方案；禁止引用任何已废止的旧补偿标准。",
      "客户以超期为由要求超过赔付标准的赔偿时，转评审会流程处理，一线客服不得当场承诺超额赔偿。",
    ],
  },
  {
    id: "CS-SOP-027",
    dept: "客服",
    title: "VIP 客户服务规范",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "VIP 客户（年度消费前 5%）由专属客服对接，工单优先级默认提升一级；VIP 标识在系统内展示，对话中不得向客户提及其 VIP 等级以外的他人信息。",
      "VIP 重复扣款、大额退款类诉求与普通客户执行同一 FIN-001 红线，不得以 VIP 身份绕过人工审批。",
    ],
  },
  {
    id: "CS-SOP-034",
    dept: "客服",
    title: "工单系统操作手册",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "工单创建必填：客户编号、问题分类、诉求摘要、金额（如涉资金）；分类选择错误会导致路由延误，请按分类树逐级选择。",
      "工单流转遵循「谁创建谁跟进」，转办须填写转办理由；结案前必须回访确认客户认可处理结果。",
    ],
  },
  {
    id: "CS-SOP-038",
    dept: "客服",
    title: "客服绩效考核指标说明（内部）",
    roles: MGMT,
    status: "current",
    confidential: false,
    paragraphs: [
      "考核四维：响应时效（30%）、解决率（30%）、客户满意度（25%）、制度遵从（15%）；话术违规与越权承诺一票扣减制度遵从分。",
      "季度排名前 10% 评优、后 5% 安排辅导；考核数据以工单系统只读快照为准，不接受人工修正申请。",
    ],
  },
  {
    id: "CS-SOP-042",
    dept: "客服",
    title: "舆情与媒体问询应对预案（内部）",
    roles: MGMT,
    status: "current",
    confidential: false,
    paragraphs: [
      "任何媒体问询一律转品牌公关部统一回应，一线员工不得擅自接受采访或透露处理细节。",
      "发现社交平台涉公司负面舆情 30 分钟内上报客服总监与品牌部；涉并购传闻的舆情直接升级集团高管处理。",
    ],
  },
  {
    id: "CS-M&A-03",
    dept: "客服",
    title: "并购过渡期客户沟通口径（机密）",
    roles: EXEC_ONLY,
    status: "current",
    confidential: true,
    paragraphs: [
      "【机密·仅限集团高管】并购公告日前，客服面对客户问询一律回答「暂无可以分享的信息」；公告日后启用过渡期 Q&A 口径包。",
      "过渡期品牌切换分三阶段：双品牌并行、主副品牌、统一品牌；投诉工单在过渡期内沿用现行服务承诺不变。",
    ],
  },

  /* ============ 法务部（12 份，含 2 份机密） ============ */
  {
    id: "POL-LGL-2026-001",
    dept: "法务",
    title: "合同审批权限与用印管理",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "合同按标的金额分级审批：¥50,000 以下部门负责人审批；超过 ¥50,000 须法务评审并经具名高管签字，与 FIN-001 财务审批并行不悖。",
      "用印实行登记制，公章外带须两名专员同行并全程记录；电子章使用范围仅限标准模板合同。",
    ],
  },
  {
    id: "POL-LGL-2026-002",
    dept: "法务",
    title: "客户个人信息处理合规指引",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "客户个人信息采集遵循最小必要原则；展示与日志环节一律脱敏，完整字段仅限授权岗位在受控系统内查看。",
      "客户行使删除权时，运营与客服须在 15 个工作日内完成数据清理并留痕；备份介质中的数据按保留策略到期自动销毁。",
    ],
  },
  {
    id: "POL-LGL-2026-003",
    dept: "法务",
    title: "跨境电商消费者权益保护要点",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "七日无理由退货适用于一般商品，定制类与鲜活类除外；退货运费责任按平台规则与商品页标注执行。",
      "赔付承诺以现行赔付标准为准，客服不得作出「假一赔十」等制度外承诺；涉嫌欺诈投诉 48 小时内由法务介入评估。",
    ],
  },
  {
    id: "LGL-SOP-004",
    dept: "法务",
    title: "合同模板适用与评审流程（内部）",
    roles: MGMT,
    status: "current",
    confidential: false,
    paragraphs: [
      "对外合同优先使用标准模板库；偏离模板核心条款（付款、违约、管辖）的须走法务逐条评审。",
      "评审意见分「通过 / 修改后通过 / 否决」三档，否决意见不可由业务部门自行推翻，须上合规委员会复议。",
    ],
  },
  {
    id: "LGL-SOP-010",
    dept: "法务",
    title: "知识产权与品牌保护指引",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "上架商品须完成知识产权筛查，疑似侵权商品立即下架并冻结库存；权利人投诉 24 小时内响应。",
      "公司商标被海外抢注的，由法务委托当地代理提出异议；费用支出超过 ¥50,000 的按 FIN-001 走人工审批。",
    ],
  },
  {
    id: "POL-LGL-2026-006",
    dept: "法务",
    title: "数据出境安全评估要点",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "向境外传输客户个人信息前须完成数据出境评估备案；禁止通过个人邮箱、聊天工具传输含个人信息的表格。",
      "技术团队跨境调试涉及生产数据时，一律使用脱敏副本；违者按数据安全制度问责。",
    ],
  },
  {
    id: "LGL-SOP-015",
    dept: "法务",
    title: "劳动用工合规手册（内部）",
    roles: MGMT,
    status: "current",
    confidential: false,
    paragraphs: [
      "用工模式分正式、外包、实习三类，均须签订书面协议；试用期解除须留存考核证据。",
      "加班审批实行事前申请制；劳动争议工单由 HR 与法务双线处理，和解金额超过 ¥50,000 须经集团高管批准。",
    ],
  },
  {
    id: "LGL-SOP-020",
    dept: "法务",
    title: "供应商合同风险清单（内部）",
    roles: MGMT,
    status: "current",
    confidential: false,
    paragraphs: [
      "供应商合同十大高频风险：无违约上限、付款条件模糊、单方解约权失衡、知识产权归属缺失、保密期过短、管辖不利、质保金缺失、竞业缺失、数据条款缺失、发票条款冲突。",
      "含风险条款的合同须在风险清单上逐项签核；风险条款导致单笔敞口超过 ¥50,000 的升级法务负责人审批。",
    ],
  },
  {
    id: "POL-LGL-2026-007",
    dept: "法务",
    title: "反商业贿赂与廉洁制度",
    roles: ALL,
    status: "current",
    confidential: false,
    paragraphs: [
      "员工不得收受供应商现金、有价证券与超标准宴请；无法拒收的礼品 3 日内上交合规组登记处理。",
      "采购、物流、财务岗位实行关键岗位轮岗与亲属回避；举报通道匿名受理，打击报复零容忍。",
    ],
  },
  {
    id: "LGL-SOP-029",
    dept: "法务",
    title: "诉讼与仲裁应对流程（内部）",
    roles: MGMT,
    status: "current",
    confidential: false,
    paragraphs: [
      "收到法院传票或仲裁通知后 24 小时内转法务部，业务部门同步封存相关证据与系统快照，禁止删改任何记录。",
      "和解金额超过 ¥50,000 的案件，和解协议须具名高管签署后生效；诉讼策略文件仅限承办团队查阅。",
    ],
  },
  {
    id: "LGL-M&A-04",
    dept: "法务",
    title: "Project Starfall 尽职调查报告摘要（机密）",
    roles: EXEC_ONLY,
    status: "current",
    confidential: true,
    paragraphs: [
      "【机密·仅限集团高管】尽调发现目标公司两处瑕疵：一笔或有诉讼（预计敞口 ¥800 万以内）与部分仓库土地租赁未备案；均已纳入对价调整条款。",
      "尽调团队名单、访谈纪要与底稿存放于独立数据室，访问权限仅限并购委员会成员，本系统内仅高管角色可检索。",
    ],
  },
  {
    id: "LGL-M&A-05",
    dept: "法务",
    title: "并购整合保密协议与信息隔离墙（机密）",
    roles: EXEC_ONLY,
    status: "current",
    confidential: true,
    paragraphs: [
      "【机密·仅限集团高管】所有参与并购人员签署专项保密协议；知悉范围执行最小化与名单制，跨名单传递信息须经合规组批准。",
      "内幕信息知悉窗口期内，相关人员禁行二级市场交易；信息隔离墙运行记录每月报并购委员会审计。",
    ],
  },
];

/** 语料规模常量（供统计与测试断言） */
export const CORPUS_TOTAL = RAG_CORPUS.length;
export const DEPRECATED_COUNT = RAG_CORPUS.filter((d) => d.status === "deprecated").length;
export const CONFIDENTIAL_COUNT = RAG_CORPUS.filter((d) => d.confidential).length;
