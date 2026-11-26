/**
 * WorkBot 核心业务本体（Ontology）· 注册表与自检（Day 27）
 * 溯源：brain/DOMAIN-XINGCHEN.md §三区权限（绿区只读 / 黄区预演 / 红区绝对禁区）；
 *      AGENTS.md 红区红线（严禁自动打款——物理不存在，不是提示词劝阻）。
 * 设计：注册表**闭合**——受控动作只有三种（只读查询 / 黄区预演 / 人工放行），
 *      任何新增动作（如 "auto_pay"）在注册期直接抛错拒绝启动；这是本体层的 Kill Switch。
 */

import type {
  OntologyActionDef,
  OntologyObjectDef,
  OntologyRelationDef,
} from "./types";

/* ================================================================
 * 一、对象注册表：单据 / 实体 / 政策
 * ================================================================ */

export const ONTOLOGY_OBJECTS: readonly OntologyObjectDef[] = [
  /* ---------- 单据（document，持久化） ---------- */
  {
    kind: "ticket",
    category: "document",
    label: "异常工单",
    idField: "ticketNo",
    table: "intake_requests",
    tenantColumn: "tenant_id",
    piiFields: ["customerName", "bankAccount"],
    description: "异常发票与退款工单，WorkBot 的唯一真实数据来源。",
  },
  {
    kind: "scraped_invoice",
    category: "document",
    label: "老 ERP 抓取副本",
    idField: "invoiceNo",
    table: "erp_scraped_invoices",
    tenantColumn: "tenant_id",
    piiFields: [],
    description: "对老 ERP 页面只读 GET 抓取的派生副本，绝不回写老 ERP 正式数据。",
  },
  {
    kind: "workflow_run",
    category: "document",
    label: "审批流运行",
    idField: "runId",
    table: "workflow_runs",
    tenantColumn: "tenant_id",
    piiFields: ["customerName"],
    description: "跨重启持久化审批流（挂起只存数据库行，不占内存）。",
  },

  /* ---------- 实体（entity，概念对象） ---------- */
  {
    kind: "customer",
    category: "entity",
    label: "客户",
    idField: "customerId",
    tenantColumn: "tenant_id",
    piiFields: ["customerName", "bankAccount"],
    description: "客户实体，字段寄居在工单/审批流表上，展示层一律脱敏。",
  },
  {
    kind: "supplier",
    category: "entity",
    label: "供应商",
    idField: "supplierName",
    tenantColumn: "tenant_id",
    piiFields: [],
    description: "供应商实体（虚构演示数据），寄居在抓取副本表。",
  },
  {
    kind: "department",
    category: "entity",
    label: "部门",
    idField: "departmentName",
    tenantColumn: "tenant_id",
    piiFields: [],
    description: "部门实体——部门清单与分类口径从租户配置文件动态读取，禁止写死。",
  },
  {
    kind: "approver",
    category: "entity",
    label: "具名审批人",
    idField: "approverName",
    tenantColumn: "tenant_id",
    piiFields: [],
    description: "具名在职审批人（AI/匿名/部门/值班一律无效），清单来自租户配置。",
  },

  /* ---------- 政策（policy） ---------- */
  {
    kind: "policy_doc",
    category: "policy",
    label: "制度文档",
    idField: "docNo",
    tenantColumn: "tenant_id",
    piiFields: [],
    description: "[DOC-XX §X.X] 引文的对象化；已废止文件在检索池中物理剔除。",
  },
  {
    kind: "prompt_policy",
    category: "policy",
    label: "提示词口径",
    idField: "version",
    tenantColumn: "tenant_id",
    piiFields: [],
    description: "提示词文案真源 = 租户配置文件；prompt_versions 表只留版本开关与演练标记。",
  },
] as const;

/* ================================================================
 * 二、关系注册表
 * ================================================================ */

export const ONTOLOGY_RELATIONS: readonly OntologyRelationDef[] = [
  {
    key: "ticket_belongs_to_customer",
    from: "ticket",
    to: "customer",
    label: "属于",
    cardinality: "n-1",
    description: "一张工单只挂一个客户（客户姓名/银行账号展示层脱敏）。",
  },
  {
    key: "ticket_handled_by_department",
    from: "ticket",
    to: "department",
    label: "归属处理",
    cardinality: "n-1",
    description: "工单归属一个部门；部门清单从租户配置动态读取。",
  },
  {
    key: "ticket_approved_by_approver",
    from: "ticket",
    to: "approver",
    label: "人工放行",
    cardinality: "n-1",
    description: "FIN-001 大额单据必须由具名审批人签字放行，AI 永远不是审批人。",
  },
  {
    key: "ticket_references_policy_doc",
    from: "ticket",
    to: "policy_doc",
    label: "引用依据",
    cardinality: "n-n",
    description: "AI 的每个结论必须引用 [DOC-XX §X.X]，且引文必须存在于已查证据集。",
  },
  {
    key: "scraped_invoice_covers_ticket",
    from: "scraped_invoice",
    to: "ticket",
    label: "佐证",
    cardinality: "n-1",
    description: "老 ERP 抓取副本作为工单核对的只读佐证（同发票号按最新快照覆盖）。",
  },
  {
    key: "workflow_run_reviews_ticket",
    from: "workflow_run",
    to: "ticket",
    label: "复核",
    cardinality: "1-1",
    description: "一次审批流运行复核一张工单（算术校验 + 挂起 + 具名放行）。",
  },
  {
    key: "policy_doc_supersedes_policy_doc",
    from: "policy_doc",
    to: "policy_doc",
    label: "废止",
    cardinality: "n-1",
    description: "废止链：旧版制度被现行制度取代，被废止文件只可当资料上报，绝不执行。",
  },
] as const;

/* ================================================================
 * 三、受控动作注册表：闭合清单，只有三种
 * ================================================================ */

/** 受控动作白名单（注册表闭合的本体级 Kill Switch） */
const ALLOWED_ACTION_KINDS: readonly string[] = [
  "read_only_query",
  "dry_run_draft",
  "manual_release",
];

/** 注册期禁词：命中即抛错拒启动（红区红线——自动打款类动作物理不存在） */
const FORBIDDEN_ACTION_WORDS: readonly string[] = [
  "自动打款",
  "自动付款",
  "自动放款",
  "auto_pay",
  "autopay",
  "auto_release",
  "auto_pay_run",
];

export const ONTOLOGY_ACTIONS: readonly OntologyActionDef[] = [
  {
    kind: "read_only_query",
    zone: "green",
    label: "只读查询",
    rule: "AI 自主执行：只读快照与制度文档检索，产出必须带 [DOC-XX §X.X] 引文。",
    requires: [],
    aiAutonomous: true,
  },
  {
    kind: "dry_run_draft",
    zone: "amber",
    label: "黄区预演",
    rule: "AI 起草 + 人类确认：后端强制 dryRun: true，只出 Diff 草稿卡与审批单号，绝不直接改库。",
    requires: ["human_confirmation"],
    aiAutonomous: false,
  },
  {
    kind: "manual_release",
    zone: "red",
    label: "人工放行",
    rule: "只有具名在职审批人签字才能放行；AI/匿名/部门/值班一律无效；绝不出现 AI 自动打款按钮。",
    requires: ["named_approver", "audit_log"],
    aiAutonomous: false,
  },
] as const;

/* ================================================================
 * 四、启动自检：注册表完整性 + 闭合性 + 禁词扫描
 * ================================================================ */

/** 串行化注册表的机器标识（kind / label / key）做禁词扫描；
 *  说明性文案（description / rule）不参与扫描——「绝不出现 AI 自动打款」这类防御性表述是合法内容。 */
function dumpRegistryText(): string {
  const marks = [
    ...ONTOLOGY_OBJECTS.flatMap((o) => [o.kind, o.label, ...(o.table ? [o.table] : [])]),
    ...ONTOLOGY_RELATIONS.flatMap((r) => [r.key, r.label]),
    ...ONTOLOGY_ACTIONS.flatMap((a) => [a.kind, a.label]),
  ];
  return JSON.stringify(marks);
}

/** 校验一个动作是否为受控动作（供外部工具注册方在挂接前调用） */
export function isControlledAction(kind: string): boolean {
  return ALLOWED_ACTION_KINDS.includes(kind);
}

/** 本体注册表启动自检：任何一条不过都抛错拒绝服务 */
export function assertOntologyHealthy(): void {
  // ① 动作闭合性：注册表里只允许三种受控动作，多了就说明有人试图塞第四种
  for (const action of ONTOLOGY_ACTIONS) {
    if (!ALLOWED_ACTION_KINDS.includes(action.kind)) {
      throw new Error(
        `WorkBot ontology 自检失败：动作 ${action.kind} 不在受控清单（只读查询/黄区预演/人工放行），拒绝注册。`,
      );
    }
    if (action.zone === "amber" || action.zone === "red") {
      if (action.aiAutonomous) {
        throw new Error(
          `WorkBot ontology 自检失败：黄区/红区动作 ${action.kind} 不允许 AI 自主执行。`,
        );
      }
    }
  }
  // ② 人工放行必须有具名审批人前提，且永远不是 AI 自主
  const manualRelease = ONTOLOGY_ACTIONS.find((a) => a.kind === "manual_release");
  if (!manualRelease || manualRelease.aiAutonomous) {
    throw new Error("WorkBot ontology 自检失败：人工放行动作缺失或不允许 AI 自主执行。");
  }
  if (!manualRelease.requires.includes("named_approver")) {
    throw new Error("WorkBot ontology 自检失败：人工放行必须要求具名审批人签字。");
  }
  // ③ 关系完整性：from / to 必须是已注册对象
  const kinds = new Set(ONTOLOGY_OBJECTS.map((o) => o.kind));
  for (const rel of ONTOLOGY_RELATIONS) {
    if (!kinds.has(rel.from) || !kinds.has(rel.to)) {
      throw new Error(
        `WorkBot ontology 自检失败：关系 ${rel.key} 引用了未注册对象（${rel.from} → ${rel.to}）。`,
      );
    }
  }
  // ④ 多租户：所有持久化对象必须声明 tenant_id 隔离列
  for (const obj of ONTOLOGY_OBJECTS) {
    if (obj.tenantColumn !== "tenant_id") {
      throw new Error(
        `WorkBot ontology 自检失败：对象 ${obj.kind} 缺少 tenant_id 隔离列声明（Day 27 多租户红线）。`,
      );
    }
  }
  // ⑤ 红区禁词扫描：整个注册表（含全部中文说明）不得出现自动打款类动作
  const dumped = dumpRegistryText().toLowerCase();
  for (const word of FORBIDDEN_ACTION_WORDS) {
    if (dumped.includes(word.toLowerCase())) {
      throw new Error(
        `WorkBot ontology 自检失败：注册表命中红区禁词「${word}」，拒绝启动。`,
      );
    }
  }
}
