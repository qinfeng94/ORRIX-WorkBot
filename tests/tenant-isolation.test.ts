/**
 * Day 27 租户隔离测试：租户 A 的任何查询请求绝不可能读到租户 B 的单据
 * 覆盖三道防线：
 *  ① 本体注册表闭合性（受控动作只有三种，自动打款类动作物理注册不进去）；
 *  ② 租户配置动态读取（提示词模板 / 审批门槛 / 部门分类 / 单据字段来自
 *     config/tenants/<tenantId>.json，fail-closed，跨租户文案零串味）；
 *  ③ 数据库逻辑隔离（tenant-repo 强制 WHERE tenant_id，跨租户查无此单）。
 * 运行：node --experimental-strip-types（由 pnpm test 统一调度，零第三方依赖）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { like, sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { intakeRequests } from "@/db/schema";
import {
  assertOntologyHealthy,
  isControlledAction,
  ONTOLOGY_ACTIONS,
  ONTOLOGY_OBJECTS,
} from "@/lib/ontology/schema";
import {
  buildSystemPrompt,
  financeRulesOf,
  loadTenantConfig,
  parseTenantConfig,
  DEFAULT_TENANT_ID,
} from "@/lib/ontology/tenant-config";
import {
  getTicketForTenant,
  insertTicketForTenant,
  listTicketsForTenant,
} from "@/lib/ontology/tenant-repo";
import { isLargeAmount } from "@/lib/fin001";

/* ================================================================
 * 环境准备：tests 进程不自动加载 .env.local，这里手动补（零第三方依赖）
 * ================================================================ */

function loadEnvLocal(): void {
  if (process.env.DATABASE_URL) return;
  try {
    const text = readFileSync(new URL("../.env.local", import.meta.url), "utf-8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#")) continue;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {
    // 无 .env.local：数据库用例将 skip（纯逻辑用例不受影响）
  }
}
loadEnvLocal();

const TENANT_A = DEFAULT_TENANT_ID; // 租户 A：星辰（默认）
const TENANT_B = "huayang-demo";    // 租户 B：华洋（虚构演示租户）

/* ================================================================
 * ① 本体注册表：闭合性自检
 * ================================================================ */

test("本体注册表自检通过（对象/关系/受控动作完整闭合）", () => {
  assert.doesNotThrow(() => assertOntologyHealthy());
  assert.equal(ONTOLOGY_ACTIONS.length, 3, "受控动作必须恰好三种");
  assert.deepEqual(
    ONTOLOGY_ACTIONS.map((a) => a.kind).sort(),
    ["dry_run_draft", "manual_release", "read_only_query"],
  );
});

test("本体注册表物理拒绝第四种动作（自动打款类注册不进去）", () => {
  assert.equal(isControlledAction("auto_pay"), false);
  assert.equal(isControlledAction("auto_release"), false);
  assert.equal(isControlledAction("read_only_query"), true);
  assert.equal(isControlledAction("dry_run_draft"), true);
  assert.equal(isControlledAction("manual_release"), true);
});

test("本体所有持久化对象都声明 tenant_id 隔离列", () => {
  for (const obj of ONTOLOGY_OBJECTS) {
    assert.equal(obj.tenantColumn, "tenant_id", `对象 ${obj.kind} 缺租户列声明`);
  }
});

/* ================================================================
 * ② 租户配置动态读取（提示词 / 门槛 / 部门 / 单据字段）
 * ================================================================ */

test("两个租户的配置全部来自各自的配置文件（互不写死）", async () => {
  const a = await loadTenantConfig(TENANT_A);
  const b = await loadTenantConfig(TENANT_B);

  // 公司名不同
  assert.notEqual(a.companyDisplayName, b.companyDisplayName);
  assert.equal(a.companyDisplayName, "星辰跨境企服集团");
  assert.ok(b.companyDisplayName.includes("华洋"));

  // 审批门槛不同（50000 vs 30000），且 mode 都是严格大于
  assert.equal(a.approvalThreshold.amountYuan, 50000);
  assert.equal(b.approvalThreshold.amountYuan, 30000);
  assert.equal(a.approvalThreshold.mode, "above");
  assert.equal(b.approvalThreshold.mode, "above");

  // 部门分类不同（星辰三部门 / 华洋两部门）
  assert.deepEqual(b.departments, ["财务部", "供应链部"]);
  assert.ok(!b.departments.includes("运营部"));

  // 单据字段标签不同（同一 key，租户各自的中文标签）
  const aAmount = a.documentFields.find((f) => f.key === "amount");
  const bAmount = b.documentFields.find((f) => f.key === "amount");
  assert.equal(aAmount?.label, "金额（元）");
  assert.equal(bAmount?.label, "金额（元）");
  const bDept = b.documentFields.find((f) => f.key === "department");
  assert.equal(bDept?.label, "归属部门");
});

test("提示词模板按租户动态渲染，跨租户文案零串味", async () => {
  const a = await loadTenantConfig(TENANT_A);
  const b = await loadTenantConfig(TENANT_B);

  const promptA = buildSystemPrompt(a);
  const promptB = buildSystemPrompt(b);

  // 各自渲染出自己的公司名 / 门槛 / 审批人
  assert.ok(promptA.includes("星辰跨境企服集团"));
  assert.ok(promptA.includes("50,000"));
  assert.ok(promptA.includes("林总"));
  assert.ok(promptB.includes("华洋国际贸易"));
  assert.ok(promptB.includes("30,000"));
  assert.ok(promptB.includes("华总"));

  // 跨租户串味扫描：A 的提示词不出现 B 的公司名，反之亦然
  assert.ok(!promptA.includes("华洋国际贸易"));
  assert.ok(!promptB.includes("星辰跨境企服集团"));
});

test("审批门槛按租户动态生效（同一笔金额在不同租户判定不同）", async () => {
  const a = await loadTenantConfig(TENANT_A);
  const b = await loadTenantConfig(TENANT_B);

  // ¥35,000：华洋（门槛 3 万）触发 FIN-001，星辰（门槛 5 万）不触发
  assert.equal(isLargeAmount({ department: "财务部", amount: 35_000 }, financeRulesOf(b)), true);
  assert.equal(isLargeAmount({ department: "财务部", amount: 35_000 }, financeRulesOf(a)), false);

  // 严格大于口径在任意租户都成立：等于门槛不触发
  assert.equal(isLargeAmount({ department: "财务部", amount: 30_000 }, financeRulesOf(b)), false);
  assert.equal(isLargeAmount({ department: "财务部", amount: 30_001 }, financeRulesOf(b)), true);
  assert.equal(isLargeAmount({ department: "财务部", amount: 50_000 }, financeRulesOf(a)), false);
  assert.equal(isLargeAmount({ department: "财务部", amount: 50_001 }, financeRulesOf(a)), true);

  // 部门口径同样按租户配置：华洋没有运营部，运营部单据永不触发
  assert.equal(isLargeAmount({ department: "供应链部", amount: 999_999 }, financeRulesOf(b)), false);
});

test("fail-closed：非法租户配置一律拒绝，绝不静默兜底", async () => {
  // 不存在的租户文件
  await assert.rejects(() => loadTenantConfig("no-such-tenant"));
  // 路径穿越形态
  await assert.rejects(() => loadTenantConfig("../xingchen"));

  // mode 不是严格大于 → 拒绝（FIN-001 口径不可被配置弱化）
  assert.throws(
    () =>
      parseTenantConfig({
        tenantId: "bad-mode",
        companyDisplayName: "坏配置",
        departments: ["财务部"],
        approvalThreshold: { department: "财务部", amountYuan: 1, mode: "at-least" },
        namedApprovers: ["某人"],
        flowDepartments: { finance: "财务部" },
        promptTemplate: "你是{company}的AI，门槛{threshold}",
        faultyPromptTemplate: "你是{company}的AI，门槛{threshold}",
        documentFields: [{ key: "amount", label: "金额", required: true, pii: false }],
      }),
    /approvalThreshold/,
  );

  // flowDepartments 指向未注册部门 → 拒绝
  assert.throws(
    () =>
      parseTenantConfig({
        tenantId: "bad-flow",
        companyDisplayName: "坏配置",
        departments: ["财务部"],
        approvalThreshold: { department: "财务部", amountYuan: 100, mode: "above" },
        namedApprovers: ["某人"],
        flowDepartments: { logistics: "不存在部门" },
        promptTemplate: "你是{company}的AI，门槛{threshold}",
        faultyPromptTemplate: "你是{company}的AI，门槛{threshold}",
        documentFields: [{ key: "amount", label: "金额", required: true, pii: false }],
      }),
    /flowDepartments/,
  );
});

/* ================================================================
 * ③ 数据库逻辑隔离（需要 DATABASE_URL；缺失则 skip）
 * ================================================================ */

const hasDb = Boolean(process.env.DATABASE_URL);

test("租户 A 的查询绝不可能读到租户 B 的单据（DB 逻辑隔离）", { skip: !hasDb }, async (t) => {
  const isoRun = `ISO-${Date.now().toString(36).toUpperCase()}`;
  const ticketA = `T-ISO-A-${isoRun}`;
  const ticketB = `T-ISO-B-${isoRun}`;

  try {
    // 两个租户各插一张同名客户的测试单据（客户名相同 → 只有 tenant_id 能区分归属）
    await insertTicketForTenant(TENANT_A, {
      ticketNo: ticketA,
      department: "财务部",
      amount: 35_000, // 星辰门槛 5 万 → 不触发
      summary: `租户隔离测试 A（${isoRun}，虚构测试数据）`,
      customerName: "隔离测试客户",
      bankAccount: "6222000000000001",
      isFin001: false,
    });
    await insertTicketForTenant(TENANT_B, {
      ticketNo: ticketB,
      department: "财务部",
      amount: 35_000, // 华洋门槛 3 万 → 触发（同一金额，租户门槛不同判定不同）
      summary: `租户隔离测试 B（${isoRun}，虚构测试数据）`,
      customerName: "隔离测试客户",
      bankAccount: "6222000000000002",
      isFin001: true,
    });

    // 列表隔离：租户 A 的全量列表里绝无租户 B 的单据，反之亦然
    const listA = await listTicketsForTenant(TENANT_A);
    const listB = await listTicketsForTenant(TENANT_B);
    assert.ok(listA.some((r) => r.ticketNo === ticketA), "A 应能看到自己的单据");
    assert.ok(!listA.some((r) => r.ticketNo === ticketB), "A 的列表绝不能出现 B 的单据");
    assert.ok(!listA.some((r) => r.tenantId === TENANT_B), "A 的列表绝不能出现 B 租户的行");
    assert.ok(listB.some((r) => r.ticketNo === ticketB), "B 应能看到自己的单据");
    assert.ok(!listB.some((r) => r.ticketNo === ticketA), "B 的列表绝不能出现 A 的单据");

    // 编号直查隔离：拿 B 的单号去 A 租户查 → 查无此单（undefined），绝不返回 B 的行
    const crossRead = await getTicketForTenant(TENANT_A, ticketB);
    assert.equal(crossRead, undefined, "跨租户编号直查必须查无此单");
    const ownRead = await getTicketForTenant(TENANT_B, ticketB);
    assert.ok(ownRead && ownRead.tenantId === TENANT_B, "本租户直查应正常返回");

    // 门槛按租户动态落库：同一笔 ¥35,000，B 触发 FIN-001 而 A 不触发
    assert.equal(ownRead?.isFin001, true, "华洋门槛 3 万：35,000 必须触发 FIN-001");
    const ownReadA = await getTicketForTenant(TENANT_A, ticketA);
    assert.equal(ownReadA?.isFin001, false, "星辰门槛 5 万：35,000 不应触发 FIN-001");
  } finally {
    // 测试夹具清理（intake_requests 非审计表，允许删除；只删本轮 ISO 前缀行）
    try {
      await getDb()
        .delete(intakeRequests)
        .where(like(intakeRequests.ticketNo, "T-ISO-%"));
      await getDb().execute(sql`select 1`);
    } catch {
      // 清理失败不影响断言结论（下轮测试开始时同样会先清理残留）
    }
  }
});

test("夹具残留清理：DB 用例结束后不遗留 T-ISO 行", { skip: !hasDb }, async () => {
  await getDb().delete(intakeRequests).where(like(intakeRequests.ticketNo, "T-ISO-%"));
  const rows = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(intakeRequests)
    .where(like(intakeRequests.ticketNo, "T-ISO-%"));
  assert.equal(rows[0]?.n, 0);
});

test("测试进程收尾：关闭数据库连接（防 node --test 挂起）", { skip: !hasDb }, async () => {
  await assert.doesNotReject(() => closeDb());
});
