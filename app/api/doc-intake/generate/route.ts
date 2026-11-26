/**
 * /api/doc-intake/generate —— 一键生成器下载端点
 * GET ?file=csv | xlsx | docx → 确定性产出对应样本文件（全部虚构演示数据）。
 * 溯源：AGENTS.md「测试数据必须用虚构信息」；ADR-004（本路由只做文件装配，不调任何引擎）。
 */

import { NextResponse, connection } from "next/server";

import { buildContractDocx } from "@/lib/doc-intake/contract-doc";
import { buildReconXlsx, generateReconRows, reconRowsToCsv } from "@/lib/doc-intake/generator";

export const maxDuration = 60;

function fileResponse(bytes: Uint8Array, contentType: string, fileName: string): Response {
  const body = bytes.slice().buffer as ArrayBuffer;
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(req: Request): Promise<Response> {
  await connection();
  const file = new URL(req.url).searchParams.get("file") ?? "csv";

  if (file === "csv") {
    const csv = reconRowsToCsv(generateReconRows());
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="xingchen-recon-8500.csv"',
        "Cache-Control": "no-store",
      },
    });
  }
  if (file === "xlsx") {
    return fileResponse(
      buildReconXlsx(generateReconRows()),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "xingchen-recon-8500.xlsx",
    );
  }
  if (file === "docx") {
    return fileResponse(
      buildContractDocx(),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "xingchen-contract-revised.docx",
    );
  }
  return NextResponse.json({ error: "未知文件类型，仅支持 csv / xlsx / docx" }, { status: 400 });
}
