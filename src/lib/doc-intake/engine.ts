/**
 * doc-intake/engine.ts —— Day 31 「docintake」内室引擎（ADR-004 门面契约）
 * 分治纪律：8,500 行全量数据只进确定性代码引擎（扫描/聚合/异常筛选），
 *          大模型只见「摘要 + Top5 异常 + 条款状态清单」的精准上下文；
 *          传统直塞 vs 分治的 Token 对比实时出站（内置样本节省 >95%）。
 * 红线：FIN-001 判定走 fin001.ts 真源；删除线条款标「已删除·禁止引用」防幻觉；
 *      外部文件内容一律包 <untrusted_document_content>；绝不输出任何打款动作。
 */

import { callLlm, MODEL_REGISTRY } from "@/lib/workbot/llm-gateway";
import { registerFlowEngine } from "@/lib/workbot/facade";
import type { EmitWorkbotEvent, WorkbotEngine, WorkbotRequest } from "@/lib/workbot/types";

import { buildContractDocx } from "./contract-doc";
import { generateReconRows, reconRowsToCsv } from "./generator";
import { detectArchiveKind, parseContractDocx, parseCsvRecon, parseXlsxRecon } from "./intake-parsers";
import { buildDistilledContext, buildTokenCompare, scanReconTable } from "./table-engine";
import type { AnomalyItem, ContractParseResult, DocIntakeStepPayload, ReconRow, TableScanReport, TokenCompare } from "./types";

const DEFAULT_QUESTION = "解读对账大表异常与合同修订要点";
const SCAN_CHUNK = 500;
const SCAN_PACE_MS = 10;

let registered = false;

/** 路由加载时调用（幂等；热更新竞态下重复注册视为已就绪） */
export function ensureDocIntakeFlow(): void {
  if (registered) return;
  try {
    registerDocIntake();
  } catch (err) {
    if (!(err instanceof Error && /已注册|already/.test(err.message))) throw err;
  }
  registered = true;
}

function registerDocIntake(): void {
  registerFlowEngine("docintake", runDocIntakeEngine);
}

function emitStep(emit: EmitWorkbotEvent, stepRef: { n: number }, payload: DocIntakeStepPayload): void {
  stepRef.n += 1;
  emit({ type: "step", kind: "observation", step: stepRef.n, payload });
}

function formatYuan(amount: number): string {
  return `¥${amount.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/* ---------------- 材料准备（内置样本 or 上传文件） ---------------- */

interface IntakeMaterials {
  tableRows: ReconRow[] | null;
  tableLabel: string;
  corruptRows: number;
  contractBytes: Uint8Array | null;
  contractLabel: string;
}

function prepareMaterials(req: WorkbotRequest, emit: EmitWorkbotEvent): IntakeMaterials {
  const refs = req.refs ?? {};
  const isUpload = refs.source === "upload";
  const materials: IntakeMaterials = {
    tableRows: null,
    tableLabel: "",
    corruptRows: 0,
    contractBytes: null,
    contractLabel: "",
  };

  // 内置样本：一键生成器确定性产出
  if (!isUpload) {
    materials.tableRows = generateReconRows();
    materials.tableLabel = `内置仿真样本（8,500 行 · 3 笔超 5 万 + 2 组重复扣款已预埋）`;
    materials.contractBytes = buildContractDocx();
    materials.contractLabel = "内置修订版合同样本（V2.1 · 含删除线与批注）";
    return materials;
  }

  // 上传 CSV 对账大表
  if (refs.csvText && refs.csvText.trim() !== "") {
    try {
      const parsed = parseCsvRecon(refs.csvText);
      materials.tableRows = parsed.rows;
      materials.corruptRows = parsed.corruptRows;
      materials.tableLabel = `上传文件 ${refs.fileName ?? "对账大表.csv"}（解析 ${parsed.rows.length} 行，坏行 ${parsed.corruptRows}）`;
    } catch (err) {
      emit({ type: "notice", level: "fallback", text: `对账大表解析失败，已跳过表格阶段：${err instanceof Error ? err.message : "未知错误"}` });
    }
  }

  // 上传 zip 系文档（docx 合同 / xlsx 大表）
  if (refs.archiveBase64 && refs.archiveBase64.trim() !== "") {
    try {
      const bytes = new Uint8Array(Buffer.from(refs.archiveBase64, "base64"));
      const kind = detectArchiveKind(bytes);
      if (kind === "docx") {
        materials.contractBytes = bytes;
        materials.contractLabel = `上传合同 ${refs.fileName ?? "合同.docx"}（修订痕迹解析）`;
      } else if (kind === "xlsx" && !materials.tableRows) {
        const parsed = parseXlsxRecon(bytes);
        materials.tableRows = parsed.rows;
        materials.corruptRows = parsed.corruptRows;
        materials.tableLabel = `上传文件 ${refs.fileName ?? "对账大表.xlsx"}（解析 ${parsed.rows.length} 行，坏行 ${parsed.corruptRows}）`;
      }
    } catch (err) {
      emit({ type: "notice", level: "fallback", text: `上传文档解析失败：${err instanceof Error ? err.message : "未知错误"}` });
    }
  }

  return materials;
}

/* ---------------- 离线高仿真解读文案（全部从真实解析结果出发，零编造） ---------------- */

export interface OfflineInterpretationInput {
  question: string;
  summary: TableScanReport | null;
  anomalies: readonly AnomalyItem[];
  contract: ContractParseResult | null;
  compare: TokenCompare;
  sourceLabel: string;
}

export function buildOfflineInterpretation(input: OfflineInterpretationInput): string {
  const lines: string[] = ["【分治解读】以下结论全部来自确定性引擎的实测聚合结果，未引用任何清单外数据。"];

  if (input.summary) {
    const topDept = input.summary.byDepartment[0];
    const topMonth = input.summary.byMonth[0];
    lines.push(
      `一、对账大表（${input.sourceLabel}）：全量 ${input.summary.rowCount.toLocaleString("zh-CN")} 行扫描完成，金额合计 ${formatYuan(input.summary.totalAmountCny)}，不可解析行 ${input.summary.corruptRows}（宁缺毋滥、绝不编造）。按部门聚合金额最高为「${topDept?.key ?? "—"}」${formatYuan(topDept?.amountCny ?? 0)}（${topDept?.count ?? 0} 笔）；按月份最高为「${topMonth?.key ?? "—"}」${formatYuan(topMonth?.amountCny ?? 0)}。`,
    );
  }

  const fin001Items = input.anomalies.filter((a) => a.fin001Required);
  const dupItems = input.anomalies.filter((a) => !a.fin001Required);
  lines.push(`二、异常清单（Top ${input.anomalies.length}，全部转人工处理）：`);
  for (const a of fin001Items) {
    lines.push(`· [FIN-001] ${a.detail}`);
  }
  lines.push(`以上 ${fin001Items.length} 笔单笔金额均「超过」¥50,000 强制人工审批门槛，必须由具名在职审批人放行；AI 只读、起草、标记，任何情况下不充当审批人。`);
  for (const a of dupItems) {
    lines.push(`· [重复扣款] ${a.detail}`);
  }

  if (input.contract) {
    const effective = input.contract.clauses.filter((c) => c.status === "effective");
    const amended = input.contract.clauses.filter((c) => c.status === "amended");
    const deleted = input.contract.clauses.filter((c) => c.status === "deleted");
    lines.push(`三、修订版合同《${input.contract.title}》——删除线 ≠ 生效：`);
    lines.push(`现行生效条款 ${effective.length} 条：${effective.map((c) => `第${c.id}条（${c.title}）`).join("、")}。`);
    for (const c of amended) {
      lines.push(`已修订条款 第${c.id}条：删除线内容「${c.deletedText}」不再生效；现行生效口径为「${c.effectiveText}」。`);
    }
    if (deleted.length > 0) {
      lines.push(
        `已删除条款 ${deleted.length} 条：${deleted.map((c) => `第${c.id}条「${c.deletedText.slice(0, 40)}…」`).join("、")}——整条废除，一律不得引用；若其中含自动扣款类表述，即违反「放行永远归人」红区红线，必须拒绝执行并上报。`,
      );
    }
    lines.push(`解析器共识别修订批注 ${input.contract.commentCount} 条，批注内容已随条款一并留痕。`);
  }

  lines.push(
    `四、架构收益：传统直塞约 ${input.compare.naive.inputTokens.toLocaleString("zh-CN")} tokens（${input.compare.naiveRecords.toLocaleString("zh-CN")} 条记录），分治后仅 ${input.compare.distilled.inputTokens.toLocaleString("zh-CN")} tokens 送审（${input.compare.distilledRecords} 条记录），节省 ${input.compare.savingsPct.toFixed(1)}%，估算输入成本 ${input.compare.naive.estCostUsd.toFixed(4)} → ${input.compare.distilled.estCostUsd.toFixed(6)} 美元。确定性引擎先行，大模型只在精准提炼后的小上下文里做解读——更快、更省、幻觉更少。`,
  );
  lines.push(`（针对您的关注点「${input.question}」，以上已按 FIN-001 现行口径与只增不改审计红线作答。）`);

  return lines.join("\n");
}

/* ---------------- 引擎主流程 ---------------- */

const runDocIntakeEngine: WorkbotEngine = async (req, emit, ctx) => {
  const startedAt = Date.now();
  const stepRef = { n: 0 };
  const question = req.question.trim() || DEFAULT_QUESTION;

  const materials = prepareMaterials(req, emit);

  /* 阶段 ①：确定性引擎全量扫描 */
  let summary: TableScanReport | null = null;
  let anomalies: AnomalyItem[] = [];

  if (materials.tableRows && materials.tableRows.length > 0) {
    emit({ type: "phase", label: "① 确定性引擎 · 全量扫描（不经过大模型）" });
    emit({ type: "notice", level: "info", text: `已拦截「整表直塞」：${materials.tableRows.length.toLocaleString("zh-CN")} 行原文只进确定性代码引擎，绝不进入大模型上下文。` });

    const scanStart = Date.now();
    const { report, anomalies: found } = scanReconTable(materials.tableRows);
    summary = { ...report, corruptRows: materials.corruptRows };
    anomalies = found;

    let anomaliesSoFar = 0;
    for (let i = 0; i < materials.tableRows.length; i += SCAN_CHUNK) {
      const scannedSoFar = Math.min(i + SCAN_CHUNK, materials.tableRows.length);
      anomaliesSoFar = anomalies.filter((a) => Math.min(...a.rowNos) <= scannedSoFar).length;
      emitStep(emit, stepRef, {
        stage: "scan_progress",
        scanned: scannedSoFar,
        total: materials.tableRows.length,
        anomaliesSoFar,
        elapsedMs: Date.now() - scanStart,
      });
      await new Promise((resolve) => setTimeout(resolve, SCAN_PACE_MS));
    }

    emitStep(emit, stepRef, { stage: "scan_done", report: summary, elapsedMs: Date.now() - scanStart });
    emitStep(emit, stepRef, { stage: "aggregation", byDepartment: summary.byDepartment, byMonth: summary.byMonth });
    emitStep(emit, stepRef, { stage: "anomalies", anomalies });

    let approvalSeq = 0;
    for (const anomaly of anomalies) {
      if (!anomaly.fin001Required) continue;
      approvalSeq += 1;
      emit({
        type: "card",
        card: {
          kind: "approval",
          approvalId: `AP-DOC31-${String(approvalSeq).padStart(3, "0")}`,
          title: `FIN-001 强制人工审批 · ${anomaly.title}（${formatYuan(anomaly.amountCny)}）`,
          status: "pending",
        },
      });
    }
    emit({
      type: "notice",
      level: "warn",
      text: `筛出 ${anomalies.length} 条异常，其中 ${fin001Count(anomalies)} 笔触发 FIN-001：仅允许具名人工审批，页面不提供任何打款按钮。`,
    });
  } else {
    emit({ type: "notice", level: "info", text: "本次未接入对账大表，跳过表格分治阶段。" });
  }

  /* 阶段 ②：修订版合同解析（删除线 ≠ 生效） */
  let contract: ContractParseResult | null = null;
  if (materials.contractBytes) {
    emit({ type: "phase", label: "② 修订版合同解析（区分已删除 / 现行生效条款）" });
    try {
      contract = parseContractDocx(materials.contractBytes);
      emitStep(emit, stepRef, { stage: "clauses", contract, sourceLabel: materials.contractLabel });
      if (contract.deletedCount > 0 || contract.amendedCount > 0) {
        emit({
          type: "notice",
          level: "warn",
          text: `检测到 ${contract.deletedCount} 条整段删除 + ${contract.amendedCount} 条已修订条款：删除线内容已标「已删除·禁止引用」，AI 绝不把删掉的霸王条款当现行条款。`,
        });
      }
    } catch (err) {
      emit({ type: "notice", level: "fallback", text: `合同解析失败：${err instanceof Error ? err.message : "未知错误"}` });
    }
  }

  /* 阶段 ③：AI 精准解读（仅摘要 + Top5 异常送审）+ Token 对比 */
  emit({ type: "phase", label: "③ AI 精准解读（分治：只送摘要 + Top5 异常）" });

  const distilled = buildDistilledContext({
    summary,
    anomalies,
    clauses: contract?.clauses ?? [],
    contractTitle: contract?.title ?? "（未接入合同）",
    question,
    sourceLabel: materials.tableLabel || materials.contractLabel || "内置样本",
  });

  const naiveParts: string[] = [];
  if (materials.tableRows) naiveParts.push(reconRowsToCsv(materials.tableRows));
  if (contract) {
    naiveParts.push(
      [contract.title, ...contract.clauses.map((c) => `${c.effectiveText}\n${c.deletedText}`.trim()), ...contract.clauses.map((c) => c.comment)]
        .filter((t) => t !== "")
        .join("\n"),
    );
  }
  const naiveRecords = (materials.tableRows?.length ?? 0) + (contract?.clauses.length ?? 0);
  const distilledRecords = (summary ? 1 : 0) + anomalies.length + (contract?.clauses.length ?? 0);
  const compare = buildTokenCompare(naiveParts.join("\n"), distilled, naiveRecords, distilledRecords, MODEL_REGISTRY.claude.priceInPerM);

  emitStep(emit, stepRef, { stage: "distilled_context", text: distilled, chars: distilled.length });
  emitStep(emit, stepRef, { stage: "token_compare", compare });

  const offlineAnswer = buildOfflineInterpretation({
    question,
    summary,
    anomalies,
    contract,
    compare,
    sourceLabel: materials.tableLabel || materials.contractLabel || "内置样本",
  });

  try {
    const result = await callLlm({
      primary: "claude",
      messages: [{ role: "user", content: distilled }],
      onToken: (chunk) => emit({ type: "text_delta", text: chunk }),
      offlineReply: offlineAnswer,
    });
    emit({ type: "usage", meta: ctx.meta, ttftMs: result.ttftMs, costUsd: result.costUsd });
    emit({
      type: "notice",
      level: "info",
      text: `解读完成（${result.offlineSim ? "离线高仿真" : "真实 API"} · TTFT ${result.ttftMs}ms · $${result.costUsd.toFixed(6)}），全程仅 ${distilled.length.toLocaleString("zh-CN")} 字符上下文送审，总耗时 ${Date.now() - startedAt}ms。`,
    });
  } catch (err) {
    emit({ type: "notice", level: "fallback", text: `大模型解读不可用，已降级为确定性摘要输出：${err instanceof Error ? err.message : "未知错误"}` });
    emit({ type: "text_delta", text: offlineAnswer });
  }
};

function fin001Count(anomalies: readonly AnomalyItem[]): number {
  return anomalies.filter((a) => a.fin001Required).length;
}
