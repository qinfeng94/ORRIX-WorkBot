"use client";

/**
 * Day 29 零代码多租户配置工作台（客户端主体）
 * 顶部租户一键切换器 → 全站主题色 / 部门标签 / 审批红线立刻无缝切换；
 * 下方规则实验室（DSL 试跑）+「0 行代码 30 秒上架」向导。
 */

import { useEffect, useMemo, useState } from "react";
import type { TenantConfig } from "@/lib/ontology/tenant-config";
import PublishWizard from "./publish-wizard";
import RuleLab from "./rule-lab";
import ByokConsole from "./byok-console";

/** 红线动作中文映射 */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  REQUIRE_HUMAN_APPROVAL: "强制人工审批",
  MANUAL_REVIEW: "转人工复核",
  BLOCK_LEAK: "拦截上报（隐私零泄露）",
};

/** 拉取全部已上架租户配置（纯 fetch 函数，首屏与发布后刷新共用） */
async function fetchTenants(): Promise<readonly TenantConfig[]> {
  const res = await fetch("/api/config-studio/tenants", { cache: "no-store" });
  const data: unknown = await res.json();
  const list = (data as { tenants?: unknown }).tenants;
  if (!Array.isArray(list)) {
    throw new Error("租户清单响应格式非法。");
  }
  return list as TenantConfig[];
}

export default function ConfigStudioClient() {
  const [tenants, setTenants] = useState<readonly TenantConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string>("xingchen");
  const [showJson, setShowJson] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // React 19 set-state-in-effect：setState 一律发生在 await 之后（async IIFE + alive 标志）
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await fetchTenants();
        if (!alive) return;
        setTenants(list);
        setLoadError(null);
      } catch (err: unknown) {
        if (!alive) return;
        setLoadError(err instanceof Error ? err.message : "租户配置加载失败。");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  /** 发布成功：刷新租户清单并切到新租户 */
  const handlePublished = (tenantId: string): void => {
    setActiveId(tenantId);
    setReloadKey((k) => k + 1);
  };

  // 当前租户（发布后清单刷新，activeId 命中即无缝切换）
  const cfg = useMemo(
    () => tenants.find((t) => t.tenantId === activeId) ?? tenants[0],
    [tenants, activeId],
  );

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-zinc-100 text-sm text-zinc-500">
        正在加载租户配置…
      </div>
    );
  }
  if (loadError !== null || cfg === undefined) {
    return (
      <div className="grid min-h-screen place-items-center bg-zinc-100 px-6 text-center">
        <div className="max-w-md rounded-2xl border border-red-200 bg-white p-6">
          <p className="text-sm font-bold text-red-700">租户配置加载失败</p>
          <p className="mt-1 text-xs text-zinc-500">{loadError ?? "未找到任何租户配置。"}</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen bg-zinc-100 px-4 py-6"
      style={{ "--tenant-primary": cfg.theme.primaryHex } as React.CSSProperties}
    >
      <div className="mx-auto max-w-5xl space-y-4">
        {/* 页头 */}
        <header className="rounded-2xl border border-zinc-200 bg-white p-4">
          <h1 className="text-xl font-bold">配置工作台 · 零代码多租户规则引擎</h1>
          <p className="mt-1 text-sm text-zinc-500">
            红线规则 = 受控 DSL 数据（非图灵完备，全链路零 eval / new Function），
            改配置不改代码；发布即落 <span className="font-mono">config/tenants/&lt;tenantId&gt;.json</span>，
            服务端 fail-closed 校验后上架。
          </p>
          <p className="mt-1 text-xs text-amber-700">
            红区提示：本工作台只发布租户配置文件，绝不触碰业务数据与老 ERP；星辰租户 FIN-001 的生产判定真源仍是 fin001.ts。
          </p>
        </header>

        {/* 租户一键切换器 */}
        <section className="rounded-2xl border border-zinc-200 bg-white p-4">
          <h2 className="text-base font-bold">租户一键切换器</h2>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {tenants.map((t) => {
              const active = t.tenantId === cfg.tenantId;
              return (
                <button
                  key={t.tenantId}
                  type="button"
                  onClick={() => setActiveId(t.tenantId)}
                  className={`rounded-xl border-2 p-3 text-left transition-all ${
                    active ? "shadow-md" : "border-zinc-200 hover:border-zinc-400"
                  }`}
                  style={active ? { borderColor: t.theme.primaryHex } : undefined}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-block size-3.5 rounded-full ring-2 ring-white"
                      style={{ backgroundColor: t.theme.primaryHex }}
                    />
                    <span className="text-sm font-bold leading-tight">{t.companyDisplayName}</span>
                  </div>
                  <p className="mt-1.5 text-xs text-zinc-500">
                    门槛 ¥{t.approvalThreshold.amountYuan.toLocaleString("zh-CN")}（严格超过触发）·{" "}
                    {t.departments.length} 个部门 · {t.redlineRules.length} 条红线 DSL
                  </p>
                  {active && (
                    <p className="mt-1 text-xs font-bold" style={{ color: t.theme.primaryHex }}>
                      当前生效 · {t.theme.primaryName}
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        </section>

        {/* 当前租户概览（主题色 / 部门标签 / 审批红线随切换无缝变化） */}
        <section
          className="rounded-2xl border-2 bg-white p-4 transition-colors"
          style={{ borderColor: cfg.theme.primaryHex }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-bold">{cfg.companyDisplayName}</h2>
            <span
              className="rounded-full px-3 py-1 text-xs font-bold text-white"
              style={{ backgroundColor: cfg.theme.primaryHex }}
            >
              主题色 · {cfg.theme.primaryName}
            </span>
          </div>

          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div className="rounded-xl bg-zinc-50 p-3">
              <h3 className="text-sm font-bold">审批红线（金额门槛）</h3>
              <p className="mt-1.5 text-sm">
                {cfg.approvalThreshold.department} 单笔<b>严格超过</b> ¥
                <span className="text-lg font-bold">
                  {cfg.approvalThreshold.amountYuan.toLocaleString("zh-CN")}
                </span>{" "}
                → 具名审批人签字放行
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                具名审批人：{cfg.namedApprovers.join("、")}；「等于门槛」不触发，AI 永不充当审批人。
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {cfg.departments.map((d) => (
                  <span
                    key={d}
                    className="rounded-full px-2.5 py-0.5 text-xs font-semibold"
                    style={{ backgroundColor: `${cfg.theme.primaryHex}1a`, color: cfg.theme.primaryHex }}
                  >
                    {d}
                  </span>
                ))}
              </div>
            </div>

            <div className="rounded-xl bg-zinc-50 p-3">
              <h3 className="text-sm font-bold">红线规则 DSL 清单</h3>
              {cfg.redlineRules.length === 0 ? (
                <p className="mt-1.5 text-xs text-zinc-500">该租户未配置红线 DSL（仅金额门槛生效）。</p>
              ) : (
                <ul className="mt-1.5 space-y-1.5">
                  {cfg.redlineRules.map((r) => (
                    <li key={r.id} className="text-xs">
                      <span className="mr-1.5 rounded-md bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-white">
                        {r.id}
                      </span>
                      <b>{r.label}</b>
                      <span className="ml-1.5 rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">
                        {ACTION_LABELS[r.action] ?? r.action}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* JSON 源码开关 */}
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setShowJson((v) => !v)}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-semibold text-zinc-600"
            >
              {showJson ? "收起" : "查看"}租户配置 JSON 源码
            </button>
            {showJson && (
              <pre className="mt-2 max-h-80 overflow-auto rounded-xl bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-100">
                {JSON.stringify(cfg, null, 2)}
              </pre>
            )}
          </div>
        </section>

        <RuleLab cfg={cfg} />

        <ByokConsole />

        <PublishWizard templates={tenants} onPublished={handlePublished} />

        <footer className="pb-4 text-center text-xs text-zinc-400">
          Day 29 · 非图灵完备规则 DSL（比较 / 与或 / 区间 / 清单）· 深度封顶 · 原型链封死 · fail-closed ·
          全部演示数据均为虚构
        </footer>
      </div>
    </div>
  );
}
