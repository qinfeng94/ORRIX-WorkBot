"use client";

/**
 * Day 29 规则实验室 —— 红线规则 DSL 试跑面板（纯客户端求值，零 API 调用）
 * 引擎真源：src/lib/workbot/rule-dsl.ts（非图灵完备，零 eval / new Function）。
 * 说明：本面板只做只读判定演示；星辰 FIN-001 的生产判定真源仍是 fin001.ts，
 *      这里的 DSL 是规则外置化的可视化镜像（ADR-005）。
 */

import { useState } from "react";
import type { TenantConfig } from "@/lib/ontology/tenant-config";
import {
  describeRuleDsl,
  evaluateRuleDsl,
  type RuleEvalResult,
} from "@/lib/workbot/rule-dsl";

/** 预置事实样本（虚构演示数据；切租户试跑可观察跨租户事实天然不串味） */
const SAMPLES: ReadonlyArray<{ label: string; facts: Record<string, unknown> }> = [
  { label: "星辰 · 财务部 ¥52,800 重复扣款", facts: { department: "财务部", amount: 52800, summary: "VIP 客户重复扣款" } },
  { label: "星辰 · 财务部 ¥3,000 小额报销", facts: { department: "财务部", amount: 3000, summary: "常规差旅报销" } },
  { label: "星辰 · 客服部 ¥99,000", facts: { department: "客服部", amount: 99000, summary: "大额客服赔付" } },
  { label: "瑞康 · 冷链偏差 2.5℃", facts: { department: "仓储物流部", tempDeviationC: 2.5, deviceClass: "II" } },
  { label: "瑞康 · 冷链偏差 1.9℃", facts: { department: "仓储物流部", tempDeviationC: 1.9, deviceClass: "II" } },
  { label: "瑞康 · III 类器械采购 ¥120,000", facts: { department: "采购部", deviceClass: "III类", amount: 120000 } },
  { label: "瑞康 · 患者数据流到客服部", facts: { department: "客服部", containsPatientData: true } },
  { label: "瑞康 · 质控部处理患者数据", facts: { department: "质控部", containsPatientData: true } },
];

/** 命中红线动作的中文名 */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  REQUIRE_HUMAN_APPROVAL: "强制人工审批",
  MANUAL_REVIEW: "转人工复核",
  BLOCK_LEAK: "拦截上报（隐私零泄露）",
};

/** 单条规则试跑结果卡 */
function RuleRunCard({
  ruleId,
  label,
  action,
  describe,
  result,
}: {
  ruleId: string;
  label: string;
  action: string;
  describe: string;
  result: RuleEvalResult;
}) {
  const hit = result.matched;
  return (
    <div
      className={`rounded-xl border p-3 text-sm ${
        hit ? "border-amber-400 bg-amber-50" : "border-emerald-200 bg-emerald-50/60"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-zinc-900 px-2 py-0.5 font-mono text-xs text-white">{ruleId}</span>
        <span className="font-semibold">{label}</span>
        {hit && (
          <span className="rounded-md bg-amber-500 px-2 py-0.5 text-xs font-bold text-white">
            命中红线 → {ACTION_LABELS[action] ?? action}
          </span>
        )}
        {!hit && <span className="text-xs font-semibold text-emerald-700">未命中 · 放行</span>}
      </div>
      <p className="mt-1.5 font-mono text-xs text-zinc-500">{describe}</p>
      <ul className="mt-1.5 space-y-0.5">
        {result.leaves.map((leaf, i) => (
          <li key={i} className={`text-xs ${leaf.matched ? "text-amber-700" : "text-zinc-500"}`}>
            {leaf.matched ? "●" : "○"} {leaf.describe} — 实际值：{leaf.actual}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function RuleLab({ cfg }: { cfg: TenantConfig }) {
  const [sampleIdx, setSampleIdx] = useState<number | null>(null);

  const sample = sampleIdx === null ? null : SAMPLES[sampleIdx];
  const results = sample
    ? cfg.redlineRules.map((r) => ({
        rule: r,
        result: evaluateRuleDsl(r.rule, sample.facts),
        describe: describeRuleDsl(r.rule),
      }))
    : [];

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-4">
      <h3 className="text-base font-bold">规则实验室（DSL 试跑）</h3>
      <p className="mt-1 text-xs text-zinc-500">
        非图灵完备规则引擎现场求值：只允许 比较 / 与或 / 区间 / 清单 四类受控判断，
        深度封顶、原型链封死、事实缺失一律 fail-closed 判不放行。
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {SAMPLES.map((s, i) => (
          <button
            key={s.label}
            type="button"
            onClick={() => setSampleIdx(i)}
            className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
              sampleIdx === i
                ? "border-transparent text-white"
                : "border-zinc-300 text-zinc-600 hover:border-zinc-500"
            }`}
            style={sampleIdx === i ? { backgroundColor: cfg.theme.primaryHex } : undefined}
          >
            {s.label}
          </button>
        ))}
      </div>

      {sample === null ? (
        <p className="mt-4 rounded-xl bg-zinc-50 p-4 text-sm text-zinc-500">
          点一个事实样本，立即用当前租户的红线规则试跑。
        </p>
      ) : cfg.redlineRules.length === 0 ? (
        <p className="mt-4 rounded-xl bg-zinc-50 p-4 text-sm text-zinc-500">
          租户「{cfg.companyDisplayName}」未配置红线规则 DSL（仅基础审批门槛生效）。
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-zinc-500">
            样本事实：<span className="font-mono">{JSON.stringify(sample.facts)}</span>
          </p>
          {results.map(({ rule, result, describe }) => (
            <RuleRunCard
              key={rule.id}
              ruleId={rule.id}
              label={rule.label}
              action={rule.action}
              describe={describe}
              result={result}
            />
          ))}
        </div>
      )}
    </section>
  );
}
