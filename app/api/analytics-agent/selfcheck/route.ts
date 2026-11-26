/**
 * /api/analytics-agent/selfcheck —— 五重安全死锁护栏自检（Day 39）
 * 用 6 条攻击/合法样本逐条过 validateSecureSql（纯校验器，不执行），
 * 并汇报第⑤重连接层只读机制的实际生效形态（只读角色 or 降级兜底）。
 * 纪律：自检只证明防线工作方式，绝不把攻击样本送进数据库执行。
 */

import { NextResponse, connection } from "next/server";

import { getReadOnlyMechanism, validateSecureSql } from "@/lib/analytics/secure-sql";
import { ANALYTICS_TENANT_ID } from "@/lib/analytics/planner";
import type { SelfcheckResult, SelfcheckSample } from "@/lib/analytics/types";

export const maxDuration = 60;

interface AttackCase {
  name: string;
  sql: string;
  expect: string;
  scoped: boolean;
}

const ATTACK_CASES: readonly AttackCase[] = [
  {
    name: "攻击① 整表删除（写动词裸奔）",
    sql: "DROP TABLE intake_requests",
    expect: "第①重：非 SELECT 开头，直接拒绝",
    scoped: false,
  },
  {
    name: "攻击② 分号串接偷删数据",
    sql:
      "SELECT ticket_no FROM intake_requests; DELETE FROM intake_requests WHERE ticket_no = 'T-2026-1101'",
    expect: "第②重：多语句分号 + 写动词，整条作废",
    scoped: true,
  },
  {
    name: "攻击③ 越权看全租户大额单",
    sql: "SELECT ticket_no, amount FROM intake_requests WHERE amount > 50000",
    expect: "第③重：触碰租户表却无 tenant_id 条件，fail-closed",
    scoped: true,
  },
  {
    name: "攻击④ 巨型 LIMIT 拖库",
    sql:
      "SELECT department, SUM(amount) AS total FROM intake_requests WHERE tenant_id = $1 GROUP BY department LIMIT 999999",
    expect: "第④重：LIMIT 超上限，强制钳制为 100",
    scoped: true,
  },
  {
    name: "攻击⑤ pg_sleep 挂死连接",
    sql: "SELECT pg_sleep(10)",
    expect: "第①重：危险函数黑名单（逃逸向量）",
    scoped: false,
  },
  {
    name: "合法样本：部门超线统计（模板真实 SQL）",
    sql:
      "SELECT department, COUNT(*) AS ticket_count, SUM(amount) AS intercept_amount FROM intake_requests WHERE tenant_id = $1 AND amount > $2 GROUP BY department ORDER BY intercept_amount DESC",
    expect: "五层全过，允许进入只读执行",
    scoped: true,
  },
];

function verdictText(ok: boolean, blockedLayer: number | null, detail: string, clamped: boolean): string {
  if (!ok) return `❌ 第 ${String(blockedLayer ?? "?")} 重拦截：${detail}`;
  if (clamped) return `⚠ 放行但已被第④重钳制：${detail}`;
  return "✅ 五层全过，允许进入只读执行";
}

export async function POST(_req: Request): Promise<Response> {
  await connection();

  const samples: SelfcheckSample[] = ATTACK_CASES.map((c) => {
    const v = validateSecureSql(c.sql, { tenantId: ANALYTICS_TENANT_ID, scoped: c.scoped });
    const blocked = v.audits.find((a) => a.verdict === "blocked");
    const clamped = v.audits.some((a) => a.verdict === "clamped");
    return {
      name: c.name,
      sql: c.sql,
      expect: c.expect,
      ok: v.ok,
      blockedLayer: v.blockedLayer,
      audits: v.audits,
      finalSql: v.finalSql,
      verdictText: verdictText(v.ok, v.blockedLayer, blocked ? blocked.detail : "", clamped),
    };
  });

  let mechanism = "数据库未接入（未配置 DATABASE_URL）：连接层防线处于待命状态，接入后自动生效";
  let roleActive = false;
  try {
    const m = await getReadOnlyMechanism();
    mechanism = m.mechanism;
    roleActive = m.roleActive;
  } catch {
    // 保持降级文案：自检核心（校验器）不依赖数据库
  }

  const result: SelfcheckResult = { samples, mechanism, roleActive };
  return NextResponse.json(result);
}
