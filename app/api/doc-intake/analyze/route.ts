/**
 * /api/doc-intake/analyze —— 分治解析 SSE 端点（Day 31）
 * 纪律（ADR-004）：路由只做参数装配，一律 streamWorkbot 门面出站；
 * 上传材料经 refs 透传给 docintake 内室引擎，引擎负责解析与分治提炼。
 * 大小护栏：CSV ≤ 2MB、zip 系文档 base64 ≤ 6MB（约 4.5MB 原始）。
 */

import { NextResponse, connection } from "next/server";

import { ensureDocIntakeFlow } from "@/lib/doc-intake/engine";
import type { DocIntakeAnalyzeBody } from "@/lib/doc-intake/types";
import { streamWorkbot } from "@/lib/workbot/facade";

export const maxDuration = 120;

const CSV_MAX_CHARS = 2_000_000;
const ARCHIVE_BASE64_MAX_CHARS = 6_000_000;

export async function POST(req: Request): Promise<Response> {
  await connection();
  ensureDocIntakeFlow();

  const body = (await req.json()) as DocIntakeAnalyzeBody;
  if ((body.csvText?.length ?? 0) > CSV_MAX_CHARS) {
    return NextResponse.json({ error: "CSV 超过 2MB 上限，请拆分后分批接入" }, { status: 413 });
  }
  if ((body.archiveBase64?.length ?? 0) > ARCHIVE_BASE64_MAX_CHARS) {
    return NextResponse.json({ error: "文档超过 4.5MB 上限，请压缩后重试" }, { status: 413 });
  }

  const refs: Record<string, string> = { source: body.source === "upload" ? "upload" : "builtin" };
  if (body.csvText) refs.csvText = body.csvText;
  if (body.archiveBase64) refs.archiveBase64 = body.archiveBase64;
  if (body.fileName) refs.fileName = body.fileName;

  return streamWorkbot({
    flow: "docintake",
    question: (body.question ?? "").trim() || "解读对账大表异常与合同修订要点",
    refs,
  });
}
