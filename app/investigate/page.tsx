"use client";

/**
 * /investigate —— Day 11 零框架透明自主调查工作台
 * 溯源：AGENTS.md 业务红线（只读调查、结论强制证据链、无任何打款按钮）；
 *      纯原生 ReAct 循环（Thought → Action → Observation）全程时间轴可视化，
 *      AI 的每一步推理实时可见，绝不黑盒。
 */

import { useCallback, useRef, useState } from "react";
import type { InvestigateSseEvent } from "@/lib/ai/react-agent";

/* ---------------- 时间轴步骤状态 ---------------- */

type StepKind = "thought" | "action" | "observation" | "circuit_break";

interface TimelineStep {
  id: string;
  kind: StepKind;
  step: number;
  /** thought 文本 / circuit_break 说明 */
  text: string;
  /** action / observation 的探针信息 */
  tool?: string;
  label?: string;
  args?: Record<string, unknown>;
  summary?: string;
  raw?: unknown;
}

interface ConclusionState {
  headline: string;
  rootCause: string;
  body: string;
  evidenceChain: { id: string; source: string; query: string; finding: string; docRefs: string[] }[];
  fin001Triggered: boolean;
  nextActions: string[];
  stepsUsed: number;
  maxSteps: number;
}

interface InvestigationRun {
  id: string;
  question: string;
  steps: TimelineStep[];
  conclusion: ConclusionState | null;
  done: boolean;
  traceId: string;
  elapsedMs: number;
}

/** 一键演练任务（CUST-8842 连续两月异常扣款根因深挖） */
const DRILL_QUESTION = "深挖 CUST-8842 连续两月异常扣款根因";

/* ---------------- 时间轴单卡渲染 ---------------- */

function StepCard({ s }: { s: TimelineStep }): React.ReactElement {
  if (s.kind === "thought") {
    return (
      <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3">
        <p className="mb-1 flex items-center gap-2 text-xs font-bold text-indigo-700">
          <span className="grid h-5 w-5 place-items-center rounded-full bg-indigo-600 text-[10px] text-white">
            想
          </span>
          Thought · 第 {String(s.step)} 步思考
        </p>
        <p className="text-sm leading-6 text-indigo-900">{s.text}</p>
      </div>
    );
  }

  if (s.kind === "action") {
    return (
      <div className="rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3">
        <p className="mb-1 flex items-center gap-2 text-xs font-bold text-emerald-700">
          <span className="grid h-5 w-5 place-items-center rounded-full bg-emerald-600 text-[10px] text-white">
            动
          </span>
          Action · 第 {String(s.step)} 步行动
          <span className="rounded-md bg-emerald-600 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white">
            🟢 只读
          </span>
        </p>
        <p className="text-sm text-emerald-900">
          调用探针 <span className="font-mono font-semibold">{s.tool}</span>
          {s.label ? `（${s.label}）` : ""}
        </p>
        {s.args && (
          <pre className="mt-1.5 rounded bg-emerald-100/70 p-2 font-mono text-xs leading-4 text-emerald-900">
            {JSON.stringify(s.args, null, 2)}
          </pre>
        )}
      </div>
    );
  }

  if (s.kind === "observation") {
    return (
      <div className="rounded-xl border border-zinc-300 bg-white px-4 py-3">
        <p className="mb-1 flex items-center gap-2 text-xs font-bold text-zinc-600">
          <span className="grid h-5 w-5 place-items-center rounded-full bg-zinc-700 text-[10px] text-white">
            察
          </span>
          Observation · 第 {String(s.step)} 步观察
          <span className="font-mono font-normal text-zinc-400">{s.tool}</span>
        </p>
        <p className="text-sm leading-6 text-zinc-800">{s.summary}</p>
        {s.raw !== undefined && (
          <details className="mt-1.5">
            <summary className="cursor-pointer text-xs text-sky-700 hover:underline">
              展开原始返回
            </summary>
            <pre className="mt-1 max-h-56 overflow-auto rounded bg-zinc-50 p-2 font-mono text-xs leading-4 text-zinc-600">
              {JSON.stringify(s.raw, null, 2)}
            </pre>
          </details>
        )}
      </div>
    );
  }

  // circuit_break：熔断红卡
  return (
    <div className="rounded-xl border-2 border-red-400 bg-red-50 px-4 py-3">
      <p className="mb-1 flex items-center gap-2 text-xs font-bold text-red-700">
        <span className="grid h-5 w-5 place-items-center rounded-full bg-red-600 text-[10px] text-white">
          断
        </span>
        熔断触发
      </p>
      <p className="text-sm leading-6 text-red-900">{s.text}</p>
    </div>
  );
}

/* ---------------- 主组件 ---------------- */

export default function InvestigatePage() {
  const [input, setInput] = useState("");
  const [runs, setRuns] = useState<InvestigationRun[]>([]);
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  /** 发起一次调查：SSE 逐事件解析，实时渲染时间轴 */
  const investigate = useCallback(
    async (question: string): Promise<void> => {
      const q = question.trim();
      if (q.length === 0 || streaming) return;

      const runId = crypto.randomUUID();
      const blank: InvestigationRun = {
        id: runId,
        question: q,
        steps: [],
        conclusion: null,
        done: false,
        traceId: "",
        elapsedMs: 0,
      };
      setRuns((prev) => [...prev, blank]);
      setInput("");
      setStreaming(true);

      const patch = (fn: (r: InvestigationRun) => InvestigationRun): void => {
        setRuns((prev) => prev.map((r) => (r.id === runId ? fn(r) : r)));
      };
      const addStep = (step: TimelineStep): void => {
        patch((r) => ({ ...r, steps: [...r.steps, step] }));
      };

      try {
        const res = await fetch("/api/investigate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: q }),
        });
        if (!res.ok || !res.body) {
          const errText = await res.text().catch(() => "");
          throw new Error(errText || `接口返回 ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            let evt: InvestigateSseEvent;
            try {
              evt = JSON.parse(line.slice(5).trim()) as InvestigateSseEvent;
            } catch {
              continue;
            }

            switch (evt.type) {
              case "thought": {
                addStep({
                  id: crypto.randomUUID(),
                  kind: "thought",
                  step: evt.step,
                  text: evt.text,
                });
                break;
              }
              case "action": {
                addStep({
                  id: crypto.randomUUID(),
                  kind: "action",
                  step: evt.step,
                  text: "",
                  tool: evt.tool,
                  label: evt.label,
                  args: evt.args,
                });
                break;
              }
              case "observation": {
                addStep({
                  id: crypto.randomUUID(),
                  kind: "observation",
                  step: evt.step,
                  text: "",
                  tool: evt.tool,
                  summary: evt.summary,
                  raw: evt.raw,
                });
                break;
              }
              case "circuit_break": {
                addStep({
                  id: crypto.randomUUID(),
                  kind: "circuit_break",
                  step: evt.step,
                  text: evt.message,
                });
                break;
              }
              case "conclusion": {
                const ev = evt; // const 收窄：闭包内保持事件类型
                patch((r) => ({ ...r, conclusion: ev.conclusion }));
                break;
              }
              case "done": {
                const ev = evt; // const 收窄：闭包内保持事件类型
                patch((r) => ({
                  ...r,
                  done: true,
                  traceId: ev.traceId,
                  elapsedMs: ev.elapsedMs,
                }));
                break;
              }
            }
          }
        }
        patch((r) => ({ ...r, done: true }));
      } catch (err: unknown) {
        patch((r) => ({
          ...r,
          done: true,
          conclusion: {
            headline: "调查请求失败",
            rootCause: err instanceof Error ? err.message : "未知错误",
            body: "调查接口调用失败，已如实上报，不会静默吞错。请稍后重试。",
            evidenceChain: [],
            fin001Triggered: false,
            nextActions: ["检查开发服务器状态后重试"],
            stepsUsed: 0,
            maxSteps: 8,
          },
        }));
      } finally {
        setStreaming(false);
        // 调查完成后贴底滚动，让结论卡进入视野
        window.setTimeout(() => {
          if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          }
        }, 50);
      }
    },
    [streaming],
  );

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col bg-zinc-50">
      {/* 顶部：标题 + 一键演练 */}
      <div className="border-b border-zinc-200 bg-white px-4 py-3 sm:px-6">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-3">
          <div className="min-w-0">
            <h1 className="text-base font-bold text-zinc-900">
              🔍 自主调查引擎
              <span className="ml-2 rounded-md bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-500">
                纯原生 ReAct · 零框架零黑盒
              </span>
            </h1>
            <p className="mt-0.5 text-xs text-zinc-500">
              思考 → 行动 → 观察，每一步全程透明直播；结论强制附证据链；maxSteps = 8 物理熔断防死循环。
            </p>
          </div>
          <button
            onClick={() => void investigate(DRILL_QUESTION)}
            disabled={streaming}
            className="ml-auto rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 disabled:opacity-40"
          >
            🎯 一键演练：{DRILL_QUESTION}
          </button>
        </div>
      </div>

      {/* 调查区：时间轴流 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        <div className="mx-auto max-w-5xl space-y-8">
          {runs.length === 0 && (
            <div className="mt-16 text-center text-sm text-zinc-400">
              <p className="text-4xl">🕵️</p>
              <p className="mt-3">
                点右上「一键演练」看 AI 自主调查 CUST-8842 连续两月异常扣款的根因；
                或在下方输入自定义调查任务。
              </p>
              <p className="mt-1 text-xs">
                引擎只挂 3 把绿区只读探针（工单查询 / 客户历史账单 / 制度检索），全程零数据改动。
              </p>
            </div>
          )}

          {runs.map((run) => (
            <div key={run.id} className="space-y-3">
              {/* 调查任务卡 */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-semibold text-white">
                  调查任务
                </span>
                <span className="text-sm text-zinc-700">{run.question}</span>
                {run.done && (
                  <span className="ml-auto font-mono text-xs text-zinc-400">
                    {run.traceId} · {String(run.steps.length)} 个推理事件 ·{" "}
                    {String(run.elapsedMs)}ms
                  </span>
                )}
              </div>

              {/* 时间轴：竖线串联想/动/察三色卡 */}
              <div className="relative space-y-2.5 border-l-2 border-zinc-200 pl-5">
                {run.steps.map((s) => (
                  <div key={s.id} className="relative">
                    <span className="absolute -left-[26px] top-5 h-2.5 w-2.5 rounded-full border-2 border-white shadow ring-1 ring-zinc-300" />
                    <StepCard s={s} />
                  </div>
                ))}
              </div>

              {/* 最终结论卡：强制附证据链溯源 */}
              {run.conclusion && (
                <div
                  className={`rounded-2xl border-2 p-5 ${
                    run.conclusion.fin001Triggered
                      ? "border-amber-400 bg-amber-50/60 ring-1 ring-amber-200"
                      : "border-zinc-300 bg-white"
                  }`}
                >
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <p className="text-base font-bold text-zinc-900">
                      🧾 调查结论
                    </p>
                    {run.conclusion.fin001Triggered && (
                      <span className="rounded-md bg-amber-500 px-2 py-0.5 text-xs font-bold text-white">
                        FIN-001 强制人工审批
                      </span>
                    )}
                    <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-600">
                      步数 {String(run.conclusion.stepsUsed)}/{String(run.conclusion.maxSteps)}（熔断上限）
                    </span>
                  </div>

                  <p className="text-sm font-semibold leading-6 text-zinc-900">
                    {run.conclusion.headline}
                  </p>

                  <div className="mt-3 rounded-xl border border-zinc-200 bg-white px-4 py-3">
                    <p className="text-xs font-bold text-zinc-500">根因判定</p>
                    <p className="mt-1 text-sm leading-6 text-zinc-800">
                      {run.conclusion.rootCause}
                    </p>
                  </div>

                  <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-zinc-700">
                    {run.conclusion.body}
                  </p>

                  {/* 证据链溯源（强制区块） */}
                  <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50/70 px-4 py-3">
                    <p className="mb-2 text-xs font-bold text-sky-800">
                      🔗 证据链溯源（结论的每一条判断都可回溯到这里）
                    </p>
                    {run.conclusion.evidenceChain.length === 0 ? (
                      <p className="text-xs text-zinc-500">无证据（证据不足时 AI 不下结论）。</p>
                    ) : (
                      <ol className="space-y-2">
                        {run.conclusion.evidenceChain.map((e) => (
                          <li
                            key={e.id}
                            className="rounded-lg border border-sky-200 bg-white px-3 py-2 text-xs leading-5"
                          >
                            <p className="font-mono font-bold text-sky-700">
                              {e.id} · {e.source}
                            </p>
                            <p className="mt-0.5 text-zinc-500">查询：{e.query}</p>
                            <p className="mt-0.5 text-zinc-700">发现：{e.finding}</p>
                            {e.docRefs.length > 0 && (
                              <p className="mt-0.5 font-semibold text-emerald-700">
                                制度出处：{e.docRefs.join("、")}
                              </p>
                            )}
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>

                  {/* 下一步建议（全部归人） */}
                  {run.conclusion.nextActions.length > 0 && (
                    <div className="mt-3">
                      <p className="mb-1.5 text-xs font-bold text-zinc-500">
                        建议下一步（全部由人执行，AI 只起草不打款）
                      </p>
                      <ul className="list-inside list-decimal space-y-1 text-sm leading-6 text-zinc-700">
                        {run.conclusion.nextActions.map((a, i) => (
                          <li key={`${a}-${String(i)}`}>{a}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 底部：输入区 */}
      <div className="border-t border-zinc-200 bg-white px-4 py-3 sm:px-6">
        <div className="mx-auto flex w-full max-w-5xl items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void investigate(input);
              }
            }}
            rows={2}
            placeholder='输入调查任务，如「查一下 CUST-5107 的物流超期情况」，Enter 发送…'
            className="min-h-[52px] flex-1 resize-none rounded-xl border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
          />
          <button
            onClick={() => void investigate(input)}
            disabled={input.trim().length === 0 || streaming}
            className="h-[52px] rounded-xl bg-zinc-900 px-5 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 disabled:opacity-40"
          >
            {streaming ? "调查中…" : "发起调查"}
          </button>
        </div>
        <p className="mx-auto mt-1.5 w-full max-w-5xl text-xs leading-5 text-zinc-400">
          透明度承诺：推理循环纯原生实现（无任何 Agent 框架），Thought / Action / Observation
          每一步实时可见；证据不足时 AI 明确说「证据不足」，绝不编造；全站无自动打款。
        </p>
      </div>
    </div>
  );
}
