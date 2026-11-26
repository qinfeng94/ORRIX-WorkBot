"use client";

/**
 * Day 29 「0 行代码 30 秒上架新租户」三步向导
 * 步骤：选模板 → 填规则（红线 DSL 默认预填模板值，可改）→ 点发布。
 * 服务端 fail-closed：租户 ID 白名单防路径穿越、拒绝覆盖既有租户（409）、
 * 配置经 parseTenantConfig 全量复验后才写 config/tenants/<id>.json。
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { TenantConfig } from "@/lib/ontology/tenant-config";
import { describeRuleDsl, validateRuleDsl } from "@/lib/workbot/rule-dsl";

const PALETTE: ReadonlyArray<{ hex: string; name: string }> = [
  { hex: "#0f766e", name: "医疗青" },
  { hex: "#18181b", name: "经典石墨黑" },
  { hex: "#b45309", name: "琥珀" },
  { hex: "#1d4ed8", name: "品牌蓝" },
  { hex: "#be123c", name: "莓红" },
];

interface FormState {
  tenantId: string;
  companyDisplayName: string;
  departmentsText: string;
  thresholdDepartment: string;
  thresholdAmount: number;
  approversText: string;
  themePrimaryHex: string;
  themePrimaryName: string;
  rulesText: string;
}

function emptyForm(): FormState {
  return {
    tenantId: "",
    companyDisplayName: "",
    departmentsText: "",
    thresholdDepartment: "财务部",
    thresholdAmount: 30000,
    approversText: "",
    themePrimaryHex: PALETTE[0].hex,
    themePrimaryName: PALETTE[0].name,
    rulesText: "[]",
  };
}

/** 选定模板后一键填充（红线 DSL 直接继承模板租户，0 行代码） */
function formFromTemplate(cfg: TenantConfig): FormState {
  const base = emptyForm();
  return {
    ...base,
    departmentsText: cfg.departments.join("、"),
    thresholdDepartment: cfg.approvalThreshold.department,
    thresholdAmount: cfg.approvalThreshold.amountYuan,
    approversText: cfg.namedApprovers.join("、"),
    themePrimaryHex: cfg.theme.primaryHex,
    themePrimaryName: cfg.theme.primaryName,
    rulesText: JSON.stringify(
      cfg.redlineRules.map((r) => ({ id: r.id, label: r.label, action: r.action, rule: r.rule })),
      null,
      2,
    ),
  };
}

/** 红线 JSON 的解析结果（纯数据，渲染期安全） */
type ParsedRules =
  | { ok: true; rules: Array<{ id: string; label: string; action: string; rule: unknown }> }
  | { ok: false; error: string };

/** 纯解析红线 JSON：绝不 setState（渲染期可安全调用），失败返回错误文案 */
function parseRulesPure(rulesText: string): ParsedRules {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rulesText);
  } catch {
    return { ok: false, error: "红线规则 JSON 格式非法，请检查逗号与括号。" };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: false, error: "红线规则至少配置 1 条（也可以从模板直接继承）。" };
  }
  for (const r of parsed) {
    const rec = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
    if (typeof rec.id !== "string" || typeof rec.label !== "string" || typeof rec.action !== "string") {
      return { ok: false, error: "每条红线规则都需要 id / label / action / rule 四个字段。" };
    }
    try {
      validateRuleDsl(rec.rule);
    } catch (err: unknown) {
      return {
        ok: false,
        error: `红线规则「${rec.id}」非法：${err instanceof Error ? err.message : "未知错误"}`,
      };
    }
  }
  return {
    ok: true,
    rules: parsed as Array<{ id: string; label: string; action: string; rule: unknown }>,
  };
}

const inputCls =
  "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none";
const labelCls = "mb-1 block text-xs font-semibold text-zinc-600";

export default function PublishWizard({
  templates,
  onPublished,
}: {
  templates: readonly TenantConfig[];
  onPublished: (tenantId: string) => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [template, setTemplate] = useState<TenantConfig | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((f) => ({ ...f, [key]: value }));
    setError(null);
  };

  /** 渲染期安全的派生值：红线 JSON 实时解析（绝不 setState） */
  const parsedPreview = useMemo(() => parseRulesPure(form.rulesText), [form.rulesText]);

  const departments = form.departmentsText
    .split(/[、,，;；\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const approvers = form.approversText
    .split(/[、,，;；\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const goPreview = (): boolean => {
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(form.tenantId)) {
      setError("租户 ID 只允许 2~64 位小写字母/数字/连字符（不能以连字符开头）。");
      return false;
    }
    if (templates.some((t) => t.tenantId === form.tenantId)) {
      setError(`租户「${form.tenantId}」已上架，请换一个 ID（向导不允许覆盖既有租户）。`);
      return false;
    }
    if (form.companyDisplayName.trim().length === 0) {
      setError("公司显示名必填。");
      return false;
    }
    if (departments.length === 0) {
      setError("至少填写一个部门。");
      return false;
    }
    if (!departments.includes(form.thresholdDepartment)) {
      setError("审批门槛部门必须来自部门清单。");
      return false;
    }
    if (!Number.isInteger(form.thresholdAmount) || form.thresholdAmount <= 0) {
      setError("审批门槛必须是大于 0 的整数（元）。");
      return false;
    }
    if (approvers.length === 0) {
      setError("至少填写一名具名审批人（AI / 匿名 / 值班一律无效）。");
      return false;
    }
    if (!parsedPreview.ok) {
      setError(parsedPreview.error);
      return false;
    }
    setError(null);
    setStep(3);
    return true;
  };

  const publish = async (): Promise<void> => {
    if (!parsedPreview.ok) {
      setError(parsedPreview.error);
      return;
    }
    if (template === null) return;
    setPublishing(true);
    setError(null);
    try {
      const res = await fetch("/api/config-studio/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: form.tenantId,
          companyDisplayName: form.companyDisplayName.trim(),
          departments,
          thresholdDepartment: form.thresholdDepartment,
          thresholdAmount: form.thresholdAmount,
          namedApprovers: approvers,
          themePrimaryHex: form.themePrimaryHex,
          themePrimaryName: form.themePrimaryName,
          templateId: template.tenantId,
          redlineRules: parsedPreview.rules,
        }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (res.status === 201 && typeof body === "object" && body !== null) {
        const ok = (body as Record<string, unknown>).ok === true;
        const tenantId = (body as Record<string, unknown>).tenantId;
        if (ok && typeof tenantId === "string") {
          setStep(1);
          setTemplate(null);
          setForm(emptyForm());
          router.refresh(); // 服务端重新渲染：新租户立刻出现在顶部切换器
          onPublished(tenantId);
          return;
        }
      }
      setError(
        typeof body === "object" && body !== null && typeof (body as Record<string, unknown>).error === "string"
          ? ((body as Record<string, unknown>).error as string)
          : `发布失败（HTTP ${String(res.status)}）。`,
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "网络异常，请重试。");
    } finally {
      setPublishing(false);
    }
  };

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-base font-bold">「0 行代码 30 秒上架新租户」向导</h3>
        <div className="flex items-center gap-1.5 text-xs font-semibold">
          {([1, 2, 3] as const).map((s) => (
            <span
              key={s}
              className={`rounded-full px-2.5 py-1 ${
                step === s ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-500"
              }`}
            >
              {s === 1 ? "选模板" : s === 2 ? "填规则" : "点发布"}
            </span>
          ))}
        </div>
      </div>

      {step === 1 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {templates.map((t) => (
            <button
              key={t.tenantId}
              type="button"
              onClick={() => {
                setTemplate(t);
                setForm(formFromTemplate(t));
                setError(null);
                setStep(2);
              }}
              className="rounded-xl border border-zinc-200 p-3 text-left transition-colors hover:border-zinc-900"
            >
              <div className="flex items-center gap-2">
                <span
                  className="inline-block size-3 rounded-full"
                  style={{ backgroundColor: t.theme.primaryHex }}
                />
                <span className="text-sm font-bold">{t.companyDisplayName}</span>
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                模板 {t.tenantId} · 门槛 ¥{t.approvalThreshold.amountYuan.toLocaleString("zh-CN")} ·{" "}
                {t.redlineRules.length} 条红线
              </p>
            </button>
          ))}
        </div>
      )}

      {step === 2 && template !== null && (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div>
            <label className={labelCls}>租户 ID（小写字母/数字/连字符）</label>
            <input className={inputCls} value={form.tenantId} placeholder="mycompany" onChange={(e) => update("tenantId", e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>公司显示名</label>
            <input className={inputCls} value={form.companyDisplayName} placeholder="某某集团（虚构演示）" onChange={(e) => update("companyDisplayName", e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>部门清单（顿号/逗号分隔）</label>
            <input className={inputCls} value={form.departmentsText} onChange={(e) => update("departmentsText", e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>审批门槛部门</label>
              <select className={inputCls} value={form.thresholdDepartment} onChange={(e) => update("thresholdDepartment", e.target.value)}>
                {departments.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>门槛金额（元，严格超过触发）</label>
              <input
                type="number"
                className={inputCls}
                value={form.thresholdAmount}
                onChange={(e) => update("thresholdAmount", Number(e.target.value))}
              />
            </div>
          </div>
          <div>
            <label className={labelCls}>具名审批人（顿号分隔）</label>
            <input className={inputCls} value={form.approversText} onChange={(e) => update("approversText", e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>主题色</label>
            <div className="flex flex-wrap gap-1.5">
              {PALETTE.map((c) => (
                <button
                  key={c.hex}
                  type="button"
                  onClick={() => {
                    update("themePrimaryHex", c.hex);
                    update("themePrimaryName", c.name);
                  }}
                  className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                    form.themePrimaryHex === c.hex ? "border-zinc-900 text-zinc-900" : "border-zinc-300 text-zinc-500"
                  }`}
                >
                  <span className="mr-1 inline-block size-2.5 rounded-full align-middle" style={{ backgroundColor: c.hex }} />
                  {c.name}
                </button>
              ))}
            </div>
          </div>
          <div className="md:col-span-2">
            <label className={labelCls}>红线规则 DSL（模板已预填，可改；服务端 fail-closed 校验）</label>
            <textarea
              className={`${inputCls} max-h-64 min-h-40 font-mono text-xs`}
              value={form.rulesText}
              onChange={(e) => update("rulesText", e.target.value)}
            />
          </div>
          <div className="flex gap-2 md:col-span-2">
            <button
              type="button"
              onClick={() => {
                setStep(1);
                setTemplate(null);
              }}
              className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold"
            >
              上一步
            </button>
            <button
              type="button"
              onClick={goPreview}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white"
            >
              去预览
            </button>
          </div>
        </div>
      )}

      {step === 3 && !parsedPreview.ok && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          红线规则 JSON 非法，请返回修改：{parsedPreview.error}
        </p>
      )}

      {step === 3 && parsedPreview.ok && (
        <div className="mt-3 space-y-2 rounded-xl bg-zinc-50 p-3 text-sm">
          <p>
            <b>{form.companyDisplayName}</b>（{form.tenantId}）· 主题色
            <span className="mx-1 inline-block size-3 rounded-full align-middle" style={{ backgroundColor: form.themePrimaryHex }} />
            {form.themePrimaryName}
          </p>
          <p>部门：{departments.join("、")}</p>
          <p>
            审批红线：{form.thresholdDepartment} 单笔严格超过 ¥
            {form.thresholdAmount.toLocaleString("zh-CN")} → 具名审批人（{approvers.join("、")}）签字放行；
            「等于门槛」不触发，AI 永不审批。
          </p>
          <ul className="space-y-1">
            {parsedPreview.rules.map((r) => (
              <li key={r.id} className="text-xs text-zinc-600">
                <span className="mr-1 font-mono">{r.id}</span>
                {r.label} — <span className="font-mono text-zinc-400">{describeRuleDsl(validateRuleDsl(r.rule))}</span>
              </li>
            ))}
          </ul>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={() => setStep(2)} className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold">
              返回修改
            </button>
            <button
              type="button"
              onClick={() => void publish()}
              disabled={publishing}
              className="rounded-lg px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
              style={{ backgroundColor: form.themePrimaryHex }}
            >
              {publishing ? "发布中…" : "点发布 · 30 秒上架"}
            </button>
          </div>
        </div>
      )}

      {error !== null && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}
    </section>
  );
}
