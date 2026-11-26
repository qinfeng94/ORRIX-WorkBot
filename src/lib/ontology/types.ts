/**
 * WorkBot 核心业务本体（Ontology）· 类型定义（Day 27）
 * 溯源：AGENTS.md 三区权限（绿区只读 / 黄区预演 / 红区绝对禁区）+ brain/DOMAIN-XINGCHEN.md；
 *      Day 27 多租户：所有持久化对象强制携带 tenant_id（逻辑隔离的物理前提）。
 * 边界：本体只做「对象是什么、怎么关联、允许谁做什么动作」的声明与校验，
 *      绝不声明任何"AI 自动打款 / 自动放款"类动作（注册表闭合，见 schema.ts）。
 */

/* ================================================================
 * 一、对象类型：单据（document）/ 实体（entity）/ 政策（policy）
 * ================================================================ */

/** 本体对象三大类 */
export type OntologyObjectCategory = "document" | "entity" | "policy";

/** 单据对象 kind（持久化，落 WorkBot 自己的表，绝不碰老 ERP 正式数据） */
export type DocumentObjectKind =
  | "ticket"          // 异常工单（intake_requests）
  | "scraped_invoice" // 老 ERP 只读抓取副本（erp_scraped_invoices，派生数据）
  | "workflow_run";   // 跨重启审批流运行（workflow_runs）

/** 实体对象 kind（人或组织的概念对象，字段寄居在单据表上） */
export type EntityObjectKind =
  | "customer"   // 客户（姓名 / 银行账号为 PII，展示层脱敏）
  | "supplier"   // 供应商（虚构演示数据）
  | "department" // 部门（清单从租户配置动态读取，禁止写死）
  | "approver";  // 具名审批人（禁止 AI / 匿名 / 值班）

/** 政策对象 kind */
export type PolicyObjectKind =
  | "policy_doc"    // 制度文档（[DOC-XX §X.X] 引文的对象化）
  | "prompt_policy"; // 提示词口径（文案真源 = 租户配置文件，版本开关 = prompt_versions 表）

/** 本体对象定义 */
export interface OntologyObjectDef {
  /** 对象 kind（如 ticket / customer / policy_doc） */
  kind: string;
  /** 三大类之一 */
  category: OntologyObjectCategory;
  /** 中文名称（面向用户的大白话） */
  label: string;
  /** 业务主键字段名 */
  idField: string;
  /** 持久化表名；undefined = 概念对象（字段寄居在其他表） */
  table?: string;
  /**
   * 租户隔离列名：Day 27 起所有持久化对象强制为 "tenant_id"。
   * 概念对象无表，也必须显式声明 tenantColumn: "tenant_id"（声明隔离意图）。
   */
  tenantColumn: "tenant_id";
  /** PII 字段清单（展示层一律脱敏，如 张* / 6222 **** **** 1234） */
  piiFields: readonly string[];
  /** 一句话说明（大白话） */
  description: string;
}

/* ================================================================
 * 二、关联关系
 * ================================================================ */

/** 关系基数（n-1 表示多个起点对象指向一个终点对象） */
export type OntologyCardinality = "1-1" | "1-n" | "n-1" | "n-n";

/** 本体关系定义 */
export interface OntologyRelationDef {
  /** 关系标识（如 ticket_belongs_to_customer） */
  key: string;
  /** 起点对象 kind */
  from: string;
  /** 终点对象 kind */
  to: string;
  /** 中文关系名（画关系图用） */
  label: string;
  /** 基数 */
  cardinality: OntologyCardinality;
  /** 一句话说明 */
  description: string;
}

/* ================================================================
 * 三、受控动作：注册表闭合，只有三种，其余一律拒绝注册
 * ================================================================ */

/** 三区权限分区 */
export type OntologyZone = "green" | "amber" | "red";

/** 受控动作 kind（闭合清单——本体层物理禁止注册第四种动作） */
export type ControlledActionKind = "read_only_query" | "dry_run_draft" | "manual_release";

/** 受控动作定义 */
export interface OntologyActionDef {
  /** 动作 kind：只允许三种受控动作 */
  kind: ControlledActionKind;
  /** 所在权限区 */
  zone: OntologyZone;
  /** 中文名称 */
  label: string;
  /** 一句话规则（大白话） */
  rule: string;
  /** 放行前提（如 named_approver = 具名在职审批人签字） */
  requires: readonly string[];
  /** AI 可否自主执行：绿区 true，黄区/红区一律 false */
  aiAutonomous: boolean;
}
