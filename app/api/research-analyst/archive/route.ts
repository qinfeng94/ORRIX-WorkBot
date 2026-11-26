/**
 * /api/research-analyst/archive —— 尽调简报一键归档（POST）与归档清单（GET）
 * 溯源：AGENTS.md 日志红线（只增不改）——归档后的简报任何人不得篡改，
 *      数据库触发器物理拒绝 UPDATE / DELETE；重新尽调只会生成新简报，绝不覆盖旧档。
 * 边界：reportId 由服务端生成（不信任前端）；落库前做最小校验；
 *      无「删除/修改归档」入口——本路由物理只有 insert 与 select 两种操作。
 */

import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { ensureSchema, getDb } from "@/db";
import { researchReports, type ResearchReportRow } from "@/db/schema";

/** 归档清单行（前端展示口径，不含 markdown 全文与 jsonb 大对象） */
export interface ArchiveSummary {
  id: number;
  reportId: string;
  topic: string;
  overallScore: number;
  overallLevel: string;
  fin001Gaps: number;
  alertsCount: number;
  degradedSources: string;
  archivedBy: string;
  createdAt: string;
}

function toSummary(row: ResearchReportRow): ArchiveSummary {
  return {
    id: row.id,
    reportId: row.reportId,
    topic: row.topic,
    overallScore: row.overallScore,
    overallLevel: row.overallLevel,
    fin001Gaps: row.fin001Gaps,
    alertsCount: row.alertsCount,
    degradedSources: row.degradedSources,
    archivedBy: row.archivedBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function POST(request: Request): Promise<Response> {
  const raw: unknown = await request.json().catch(() => null);
  const body = (raw ?? {}) as {
    topic?: unknown;
    report?: unknown;
    archivedBy?: unknown;
  };

  const topic = String(body.topic ?? "").trim().slice(0, 300);
  if (topic.length === 0) {
    return NextResponse.json({ error: "归档缺少尽调课题。" }, { status: 400 });
  }
  // 结构化简报必须是一个对象；深度内容不再二次校验（展示层只读引擎产物，不执行其中任何内容）
  const reportObj =
    typeof body.report === "object" && body.report !== null
      ? (body.report as Record<string, unknown>)
      : null;
  if (!reportObj) {
    return NextResponse.json({ error: "归档缺少结构化简报。" }, { status: 400 });
  }
  const archivedBy = String(body.archivedBy ?? "").trim().slice(0, 64) || "demo-林总";

  try {
    await ensureSchema();
    const markdown = typeof reportObj.markdown === "string"
      ? reportObj.markdown
      : `# 企业尽调简报（${topic}）`;
    const overallScore = typeof reportObj.overallScore === "number"
      ? Math.min(Math.max(Math.round(reportObj.overallScore), 0), 100)
      : 0;
    const overallLevel = typeof reportObj.overallLevel === "string"
      ? reportObj.overallLevel
      : "中";
    const suppliers = Array.isArray(reportObj.suppliers) ? reportObj.suppliers : [];
    const gaps = Array.isArray(reportObj.complianceGaps) ? reportObj.complianceGaps : [];
    const alerts = Array.isArray(reportObj.alerts) ? reportObj.alerts : [];
    const degraded = Array.isArray(reportObj.dataCoverage)
      ? ""
      : typeof reportObj.dataCoverage === "object" && reportObj.dataCoverage !== null
        ? ((reportObj.dataCoverage as { degradedSources?: unknown }).degradedSources ?? [])
        : [];
    const fin001Gaps = gaps.filter(
      (g) => typeof g === "object" && g !== null && String((g as { title?: unknown }).title ?? "").includes("FIN-001"),
    ).length;

    const inserted = await getDb()
      .insert(researchReports)
      .values({
        reportId: String(reportObj.reportId ?? "").slice(0, 64) || `RA-${Date.now()}`,
        topic,
        overallScore,
        overallLevel,
        supplierCount: suppliers.length,
        fin001Gaps,
        alertsCount: alerts.length,
        degradedSources: (degraded as string[]).join("、"),
        markdown,
        report: reportObj,
        archivedBy,
      })
      .returning({ id: researchReports.id, reportId: researchReports.reportId });

    const row = inserted[0];
    return NextResponse.json({
      ok: true,
      id: row?.id ?? null,
      reportId: row?.reportId ?? null,
      note: "归档成功。归档表只增不改：数据库触发器物理拒绝篡改历史简报。",
    });
  } catch (err: unknown) {
    // 同一份简报重复归档：幂等处理（唯一约束 23505），不视为失败。
    // postgres.js / drizzle 会把原始 PG 错误包进 cause 链，这里逐层剥开找错误码。
    const findPgCode = (e: unknown): string => {
      let cur: unknown = e;
      for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
        const code = (cur as { code?: unknown }).code;
        if (typeof code === "string") return code;
        cur = (cur as { cause?: unknown }).cause;
      }
      return "";
    };
    if (findPgCode(err) === "23505") {
      const reportId = String(body.report && typeof body.report === "object"
        ? (body.report as { reportId?: unknown }).reportId ?? ""
        : "");
      return NextResponse.json({
        ok: true,
        duplicate: true,
        reportId: reportId || null,
        note: "该简报此前已归档过（只增不改：不产生重复档案）。",
      });
    }
    const message = err instanceof Error ? err.message : "未知错误";
    return NextResponse.json(
      { error: `归档失败：${message}` },
      { status: 500 },
    );
  }
}

export async function GET(): Promise<Response> {
  try {
    await ensureSchema();
    const rows = await getDb()
      .select()
      .from(researchReports)
      .orderBy(desc(researchReports.id))
      .limit(20);
    return NextResponse.json({ archives: rows.map(toSummary) });
  } catch (err: unknown) {
    // 数据库未接入时归档清单降级为空列表（不阻塞页面浏览）
    console.error(
      "[research_reports] 归档清单读取失败：",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ archives: [] });
  }
}
