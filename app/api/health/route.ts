/**
 * /api/health —— 生产健康检查端点（Day 34 双容器编排健康门禁 + Day 35 90 秒无损回滚验活）
 * 溯源：AGENTS.md 红区（严禁直写业务系统正式数据）——本路由全程只读，零写入、零删除、零建表；
 *      日志红线——响应不含任何 PII / 密钥，仅返回状态、版本与台账行数。
 *
 * 三大体检项（Dockerfile / docker-compose / pull-upgrade.sh 的统一验活口径）：
 *  1) 数据库：连通性 + 延迟 + 不可逆审计台账行数（approval_audit_logs / llm_usage_logs）；
 *     回滚演习对比回滚前后行数，行数只增不减 = 业务数据零损伤（「零删库」证据）；
 *  2) 双模型网关：assertGatewayHealthy 自检（模型注册表非空、默认主模型在册、流式通道可调用）；
 *  3) 物理总电闸：killSwitchStatus 实时读取 WORKBOT_KILL_SWITCH（合闸 = AI 写操作全部锁死，
 *     属运维有意状态，不影响健康判定——只读与审计日志不受影响）。
 *
 * 版本可见性：release.image 优先读环境变量 WORKBOT_IMAGE（容器注入），
 * 其次读 data/day35/deploy-state.json（本地演习由升级/回滚脚本维护，升级后立即可见新版本号）。
 */

import { NextResponse, connection } from "next/server";
import { count } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getDb } from "@/db";
import { approvalAuditLogs, llmUsageLogs } from "@/db/schema";
import {
  assertGatewayHealthy,
  GATEWAY_DEFAULT_PRIMARY,
  MODEL_REGISTRY,
} from "@/lib/workbot/llm-gateway";
import { killSwitchStatus } from "@/lib/security/kill-switch";

/** 只取字符串字段，其余类型一律视为缺失（unknown 收窄，禁 any） */
function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** 读本地部署状态文件；不存在 / 解析失败一律优雅降级为 null，不影响健康判定 */
async function readLocalImage(): Promise<string | null> {
  try {
    const raw = await readFile(
      path.join(process.cwd(), "data", "day35", "deploy-state.json"),
      "utf8",
    );
    const state = JSON.parse(raw) as DeployState;
    return asString(state.currentImage);
  } catch {
    return null;
  }
}

/** 部署状态文件（本地演习模式；仅读不写，写方是升级/回滚脚本） */
interface DeployState {
  currentImage?: unknown;
  previousImage?: unknown;
  rolledBackAt?: unknown;
}

/** 当前应用版本：环境变量 > 本地演习状态文件 > dev-unknown */
async function resolveImage(): Promise<string> {
  return (
    asString(process.env.WORKBOT_IMAGE) ??
    (await readLocalImage()) ??
    "dev-unknown"
  );
}

/** 电闸状态的人话口径：合闸 = 写操作锁死（运维急停），开闸 = 正常运行（红线仍在） */
function killSwitchLabel(effectiveOn: boolean): string {
  return effectiveOn
    ? "合闸：AI 写操作已全部锁死，只读与审计日志不受影响"
    : "开闸：AI 写操作放行，仍受 FIN-001 强制人工审批红线约束";
}

export async function GET(): Promise<Response> {
  // cacheComponents 下用 connection() 显式声明动态渲染：健康检查绝不缓存
  await connection();
  const checkedAt = new Date().toISOString();
  const image = await resolveImage();

  // 体检 1：数据库连通性 + 台账行数（一次往返同时拿到延迟与「零删库」证据）
  const dbStart = performance.now();
  let dbStatus: "ok" | "down" = "ok";
  let dbLatencyMs = 0;
  let approvals: number | null = null;
  let usageLogs: number | null = null;
  let dbError = "";

  try {
    const db = getDb();
    const [approvalRow] = await db
      .select({ value: count() })
      .from(approvalAuditLogs);
    approvals = approvalRow.value;
    const [usageRow] = await db.select({ value: count() }).from(llmUsageLogs);
    usageLogs = usageRow.value;
    dbLatencyMs = Math.round(performance.now() - dbStart);
  } catch (err: unknown) {
    dbStatus = "down";
    dbError = err instanceof Error ? err.message : "未知数据库错误";
  }

  // 体检 2：双模型网关（模型注册表 / 主备档位 / 流式通道，离线高仿真同样可自检）
  let gatewayStatus: "ok" | "down" = "ok";
  let gatewayError = "";
  try {
    assertGatewayHealthy();
  } catch (err: unknown) {
    gatewayStatus = "down";
    gatewayError = err instanceof Error ? err.message : "未知网关错误";
  }

  // 体检 3：物理总电闸（实时读取，零缓存；合闸是运维有意状态，不算降级）
  const ks = killSwitchStatus();

  const overall: "ok" | "degraded" =
    dbStatus === "ok" && gatewayStatus === "ok" ? "ok" : "degraded";

  return NextResponse.json(
    {
      status: overall,
      release: { image },
      checks: {
        db: {
          status: dbStatus,
          latencyMs: dbLatencyMs,
          ...(dbStatus === "down" ? { error: dbError } : {}),
        },
        auditData: {
          status: approvals === null || usageLogs === null ? "unavailable" : "ok",
          approvalAuditLogs: approvals,
          llmUsageLogs: usageLogs,
        },
        llmGateway: {
          status: gatewayStatus,
          providers: Object.keys(MODEL_REGISTRY),
          primary: GATEWAY_DEFAULT_PRIMARY,
          ...(gatewayStatus === "down" ? { error: gatewayError } : {}),
        },
        killSwitch: {
          envVar: ks.envVar,
          envOn: ks.envOn,
          drillOverride: ks.drillOverride,
          effectiveOn: ks.effectiveOn,
          label: killSwitchLabel(ks.effectiveOn),
        },
      },
      checkedAt,
    },
    {
      status: overall === "ok" ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
