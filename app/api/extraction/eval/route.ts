/**
 * /api/extraction/eval —— Day 17 · 18 档脏单据评测 SSE 接口（仅服务端，POST）
 * 溯源：AGENTS.md FIN-001（单笔超 ¥50,000 强制人工审批，判定走 src/lib/fin001.ts 单一真源）；
 *      代码红线 4（备注栏指令只上报不执行——extractor.scanUntrusted 物理隔离）。
 * 职责：服务端逐档跑「抽取 → 注入扫描 → 纯代码算术复核 → FIN-001 判定」，与期望逐维比对，
 *      按档 SSE 直播结果，最后推报表（红绿通过率 + 各维度命中数）。
 * 事件序列：run_start → doc_start → doc_result（×18）→ report_done
 * 边界：全流程确定性纯代码（零 LLM、零写库、零打款能力），评测台只读不写任何业务系统。
 */

import { NextResponse } from "next/server";
import { DIRTY_DOCS } from "@/lib/extraction/dirty-docs";
import { runAllDocs, runDoc, type DocResult, type EvalReport } from "@/lib/extraction/eval";
import { DOC_TYPE_LABELS } from "@/lib/extraction/schemas";

/** 单档间隔（毫秒）：让前端进度有直播感，全程约 2 秒 */
const DOC_GAP_MS = 110;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(request: Request): Promise<Response> {
  // 评测台只接受空请求体（跑全量 18 档），任何附带数据直接拒绝——不给注入留入口
  const text = await request.text().catch(() => "");
  if (text.trim().length > 0) {
    return NextResponse.json({ error: "评测台不接受自定义请求体，请直接点击「一键跑完 18 档评测」。" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller): Promise<void> {
      const send = (event: string, payload: unknown): void => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
      };
      try {
        send("run_start", { total: DIRTY_DOCS.length });

        // 逐档直播：runDoc 纯确定性，每档之间小停顿形成进度直播感
        const results: DocResult[] = [];
        for (let i = 0; i < DIRTY_DOCS.length; i += 1) {
          const doc = DIRTY_DOCS[i];
          if (!doc) continue;
          send("doc_start", { index: i, docId: doc.id, docName: doc.name, docTypeLabel: DOC_TYPE_LABELS[doc.docType] });
          await sleep(DOC_GAP_MS);
          const result = runDoc(doc);
          results.push(result);
          send("doc_result", { index: i, result });
        }

        // 汇总报表（复用 runAllDocs 的口径逻辑，避免重复实现漂移）
        const { report } = runAllDocs();
        const finalReport: EvalReport = report;
        send("report_done", { report: finalReport, results });
      } catch (err: unknown) {
        send("run_error", { message: err instanceof Error ? err.message : "评测流水线异常" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
