/**
 * /api/observability —— Day 19 生产可观测性接口（仅服务端）
 * GET：全链路 Trace 列表（agent_traces + 瀑布 spans）、延迟与成本聚合、
 *      PII 脱敏监控日志（monitor_logs，只增不改）、提示词版本清单。
 * POST：两种动作（均确定性，不经过大模型）：
 *      - activate：切换激活提示词版本（热回滚 = 纯数据操作，无需重新部署，
 *        服务端实测耗时返回 elapsedMs，目标 < 3000ms）
 *      - scrub_test：对任意文本现场跑 scrubPii，验证"绝不明文落库"
 * 溯源：AGENTS.md 日志红线 / 04 号文档 CISO 条款 4；热回滚不触碰任何审计表。
 */

import { NextResponse } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import { ensureSchema, getDb } from "@/db";
import {
  agentSpans,
  agentTraces,
  llmUsageLogs,
  monitorLogs,
  promptVersions,
} from "@/db/schema";
import { scrubPiiDetailed } from "@/lib/pii-scrubber";

/** 3 秒热回滚的时限（毫秒）——超过即视为失败并如实上报 */
const ROLLBACK_DEADLINE_MS = 3000;

interface ObservationPayload {
  traces: {
    traceId: string;
    questionLabel: string;
    status: string;
    reworkCount: number;
    totalDurationMs: number;
    totalCostUsd: string;
    escalateReason: string;
    createdAt: string;
    spans: {
      seq: number;
      role: string;
      attempt: number;
      label: string;
      status: string;
      durationMs: number;
      costUsd: string;
      detail: string;
    }[];
  }[];
  usage: {
    callCount: number;
    avgTtftMs: number;
    maxTtftMs: number;
    avgTotalMs: number;
    totalUsdCost: number;
    fallbackCount: number;
    byProvider: { providerId: string; calls: number; usdCost: number }[];
    recent: {
      providerId: string;
      model: string;
      mode: string;
      ttftMs: number;
      totalMs: number;
      usdCost: string;
      wasFallback: boolean;
      questionLabel: string;
      createdAt: string;
    }[];
  };
  monitors: {
    id: number;
    sessionId: string;
    questionLabel: string;
    promptVersion: string;
    requestText: string;
    responseText: string;
    piiRedactions: number;
    latencyMs: number;
    createdAt: string;
  }[];
  prompts: {
    version: string;
    label: string;
    content: string;
    isFaulty: boolean;
    isActive: boolean;
    activatedAt: string | null;
  }[];
}

export async function GET(): Promise<Response> {
  try {
    await ensureSchema();
    const db = getDb();

    // ① 全链路 Trace：最近 20 条 + 对应瀑布 spans
    const traceRows = await db
      .select()
      .from(agentTraces)
      .orderBy(desc(agentTraces.id))
      .limit(20);
    const traceIds = traceRows.map((t) => t.traceId);
    const spanRows =
      traceIds.length > 0
        ? await db
            .select()
            .from(agentSpans)
            .where(inArray(agentSpans.traceId, traceIds))
            .orderBy(agentSpans.id)
        : [];

    // ② 延迟与成本：最近 50 条用量日志 + 聚合
    const usageRows = await db
      .select()
      .from(llmUsageLogs)
      .orderBy(desc(llmUsageLogs.id))
      .limit(50);
    const callCount = usageRows.length;
    const avgTtftMs =
      callCount > 0
        ? Math.round(
            usageRows.reduce((s, r) => s + r.ttftMs, 0) / callCount,
          )
        : 0;
    const maxTtftMs =
      callCount > 0 ? Math.max(...usageRows.map((r) => r.ttftMs)) : 0;
    const avgTotalMs =
      callCount > 0
        ? Math.round(
            usageRows.reduce((s, r) => s + r.totalMs, 0) / callCount,
          )
        : 0;
    const totalUsdCost = usageRows.reduce(
      (s, r) => s + Number(r.usdCost || 0),
      0,
    );
    const fallbackCount = usageRows.filter((r) => r.wasFallback).length;
    const providerMap = new Map<string, { calls: number; usdCost: number }>();
    for (const r of usageRows) {
      const prev = providerMap.get(r.providerId) ?? { calls: 0, usdCost: 0 };
      providerMap.set(r.providerId, {
        calls: prev.calls + 1,
        usdCost: prev.usdCost + Number(r.usdCost || 0),
      });
    }

    // ③ PII 脱敏监控日志（只增不改；正文已在写入前脱敏）
    const monitorRows = await db
      .select()
      .from(monitorLogs)
      .orderBy(desc(monitorLogs.id))
      .limit(12);

    // ④ 提示词版本清单
    const promptRows = await db
      .select()
      .from(promptVersions)
      .orderBy(promptVersions.id);

    const payload: ObservationPayload = {
      traces: traceRows.map((t) => ({
        traceId: t.traceId,
        questionLabel: t.questionLabel,
        status: t.status,
        reworkCount: t.reworkCount,
        totalDurationMs: t.totalDurationMs,
        totalCostUsd: t.totalCostUsd,
        escalateReason: t.escalateReason,
        createdAt: t.createdAt.toISOString(),
        spans: spanRows
          .filter((s) => s.traceId === t.traceId)
          .map((s) => ({
            seq: s.seq,
            role: s.role,
            attempt: s.attempt,
            label: s.label,
            status: s.status,
            durationMs: s.durationMs,
            costUsd: s.costUsd,
            detail: s.detail,
          })),
      })),
      usage: {
        callCount,
        avgTtftMs,
        maxTtftMs,
        avgTotalMs,
        totalUsdCost: Math.round(totalUsdCost * 10000) / 10000,
        fallbackCount,
        byProvider: [...providerMap.entries()].map(([providerId, v]) => ({
          providerId,
          calls: v.calls,
          usdCost: Math.round(v.usdCost * 10000) / 10000,
        })),
        recent: usageRows.slice(0, 10).map((r) => ({
          providerId: r.providerId,
          model: r.model,
          mode: r.mode,
          ttftMs: r.ttftMs,
          totalMs: r.totalMs,
          usdCost: r.usdCost,
          wasFallback: r.wasFallback,
          questionLabel: r.questionLabel,
          createdAt: r.createdAt.toISOString(),
        })),
      },
      monitors: monitorRows.map((m) => ({
        id: m.id,
        sessionId: m.sessionId,
        questionLabel: m.questionLabel,
        promptVersion: m.promptVersion,
        requestText: m.requestText,
        responseText: m.responseText,
        piiRedactions: m.piiRedactions,
        latencyMs: m.latencyMs,
        createdAt: m.createdAt.toISOString(),
      })),
      prompts: promptRows.map((p) => ({
        version: p.version,
        label: p.label,
        content: p.content,
        isFaulty: p.isFaulty,
        isActive: p.isActive,
        activatedAt: p.activatedAt ? p.activatedAt.toISOString() : null,
      })),
    };
    return NextResponse.json(payload);
  } catch (err: unknown) {
    return NextResponse.json(
      {
        error: "观测数据读取失败（数据库未接入或结构异常）。",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  const raw: unknown = await request.json().catch(() => null);
  const body = (raw ?? {}) as { action?: unknown; version?: unknown; text?: unknown };
  const action = String(body.action ?? "");

  if (action === "activate") {
    const targetVersion = String(body.version ?? "").trim();
    if (targetVersion.length === 0) {
      return NextResponse.json(
        { error: "缺少目标版本号。" },
        { status: 400 },
      );
    }
    const startedAt = Date.now();
    try {
      await ensureSchema();
      const db = getDb();
      // 目标版本必须真实存在（不凭空造版本）
      const target = await db
        .select()
        .from(promptVersions)
        .where(eq(promptVersions.version, targetVersion))
        .limit(1);
      if (!target[0]) {
        return NextResponse.json(
          { error: `版本 ${targetVersion} 不存在，无法切换。` },
          { status: 404 },
        );
      }
      if (target[0].isActive) {
        return NextResponse.json(
          {
            ok: true,
            version: targetVersion,
            elapsedMs: 0,
            message: `当前已激活 ${targetVersion}，无需切换。`,
          },
        );
      }
      // 热回滚 = 纯数据操作：先全量下线，再激活目标版本（提示词配置表允许 UPDATE，历史版本行永不删除）
      await db
        .update(promptVersions)
        .set({ isActive: false })
        .where(eq(promptVersions.isActive, true));
      await db
        .update(promptVersions)
        .set({ isActive: true, activatedAt: new Date() })
        .where(eq(promptVersions.version, targetVersion));
      const elapsedMs = Date.now() - startedAt;
      return NextResponse.json({
        ok: true,
        version: targetVersion,
        elapsedMs,
        withinDeadline: elapsedMs < ROLLBACK_DEADLINE_MS,
        message:
          elapsedMs < ROLLBACK_DEADLINE_MS
            ? `热回滚完成：${elapsedMs}ms（3 秒内），下一次对话立即生效，无需重新部署。`
            : `切换完成但耗时 ${elapsedMs}ms，超过 3 秒时限，请检查数据库延迟。`,
      });
    } catch (err: unknown) {
      return NextResponse.json(
        {
          error: "版本切换失败。",
          detail: err instanceof Error ? err.message : String(err),
        },
        { status: 500 },
      );
    }
  }

  if (action === "scrub_test") {
    const text = String(body.text ?? "");
    if (text.trim().length === 0) {
      return NextResponse.json({ error: "请输入要脱敏的文本。" }, { status: 400 });
    }
    const result = scrubPiiDetailed(text.slice(0, 2000));
    return NextResponse.json({
      ok: true,
      scrubbed: result.text,
      stats: result.stats,
    });
  }

  return NextResponse.json(
    { error: "未知动作，仅支持 activate / scrub_test。" },
    { status: 400 },
  );
}
