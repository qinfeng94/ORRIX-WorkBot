"use client";

/**
 * 顶部 56px 磨砂指挥栏（Apple Keynote 浅色系）
 * 左：Logo + 多租户热切胶囊 ｜ 中：⌘K Spotlight ｜ 右：双模型容灾灯 + 四级 RBAC 切换器 + 物理 Kill Switch
 * 红线提示：Kill Switch 为切断指示态（演练语义），不承接任何放行/打款动作；审批永远归具名审批人。
 */

import Link from "next/link";
import { useState } from "react";
import { RBAC_ROLE_LABELS, RBAC_ROLE_ORDER, RBAC_ACTION_LABELS } from "@/lib/security/rbac";
import { TENANTS, currentTenantMeta, useTenant } from "./TenantContext";
import type { TenantId } from "./TenantContext";

interface TopBarProps {
  readonly onOpenMobileNav: () => void;
  /** 桌面端侧边坞折叠/展开 */
  readonly onToggleSidebar: () => void;
  readonly onOpenSpotlight: () => void;
  /** Kill Switch 指示态（由 AppShell 持有，用于全局红条横幅） */
  readonly killEngaged: boolean;
  readonly onToggleKill: () => void;
}

/** RBAC 四级角色的权限一句话说明（与 rbac.ts 矩阵口径一致） */
const RBAC_ROLE_HINTS: Record<(typeof RBAC_ROLE_ORDER)[number], string> = {
  visitor: "绿区只读",
  specialist: "绿区只读 + 黄区起草 Dry-Run",
  approver: "起草 + FIN-001 具名审批放行",
  security_admin: "只读 + 安全管理与演习（职责分离）",
};

export default function TopBar({ onOpenMobileNav, onToggleSidebar, onOpenSpotlight, killEngaged, onToggleKill }: TopBarProps) {
  const { tenant, setTenant } = useTenant();
  const meta = currentTenantMeta(tenant);
  const [role, setRole] = useState<(typeof RBAC_ROLE_ORDER)[number]>("approver");

  return (
    <header className="glass sticky top-0 z-40 border-b border-hairline">
      <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
        {/* —— 左：侧边坞折叠 + Logo + 租户热切胶囊 —— */}
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label="折叠 / 展开侧边坞"
          title="折叠 / 展开侧边坞"
          className="hidden h-9 w-9 shrink-0 place-items-center rounded-[10px] text-ink-2 transition hover:bg-black/5 md:grid"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" stroke="currentColor" strokeWidth="1.4" />
            <path d="M6 3v10" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>

        <button
          type="button"
          onClick={onOpenMobileNav}
          aria-label="打开导航抽屉"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] border border-hairline text-ink-2 transition hover:bg-black/5 md:hidden"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>

        <Link href="/" className="flex shrink-0 items-center gap-2.5" aria-label="回到 WorkBot 首页">
          <span
            className="grid h-7 w-7 place-items-center rounded-[9px] text-[13px] font-bold text-white shadow-sm transition"
            style={{ background: "linear-gradient(135deg, var(--tenant-accent), var(--tenant-accent-deep))" }}
            aria-hidden
          >
            星
          </span>
          <span className="hidden text-[15px] font-semibold tracking-tight text-ink sm:block">
            WorkBot
            <span className="ml-1.5 align-middle text-[10px] font-medium text-ink-3">v4.0</span>
          </span>
        </Link>

        <details className="group relative shrink-0">
          <summary
            className="flex cursor-pointer list-none items-center gap-2 rounded-full border border-hairline bg-white/70 px-3 py-1.5 text-[13px] font-medium text-ink transition hover:bg-white"
            aria-label={`当前租户：${meta.name}，点击切换`}
          >
            <span className="h-2 w-2 rounded-full" style={{ background: meta.accent }} aria-hidden />
            {meta.shortName}
            <span className="text-[9px] text-ink-3 transition group-open:rotate-180" aria-hidden>▾</span>
          </summary>
          <div className="bento glass absolute left-0 top-full z-50 mt-2 w-60 p-1.5">
            <p className="px-3 pb-1.5 pt-2 text-[11px] font-medium text-ink-3">多租户热切（主题换肤 · 业务配置仍在服务端）</p>
            {TENANTS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTenant(t.id as TenantId)}
                aria-pressed={tenant === t.id}
                className={`flex w-full items-center gap-2.5 rounded-[12px] px-3 py-2 text-left text-[13px] transition ${
                  tenant === t.id ? "bg-black/5 font-semibold text-ink" : "text-ink-2 hover:bg-black/5"
                }`}
              >
                <span className="h-2 w-2 rounded-full" style={{ background: t.accent }} aria-hidden />
                {t.name}
                {tenant === t.id && <span className="ml-auto text-[11px]" style={{ color: t.accent }}>当前</span>}
              </button>
            ))}
          </div>
        </details>

        {/* —— 中：⌘K Spotlight 快捷跳转 —— */}
        <div className="flex flex-1 justify-center">
          <button
            type="button"
            onClick={onOpenSpotlight}
            className="hidden w-full max-w-md items-center gap-2 rounded-full border border-hairline bg-white/70 px-4 py-1.5 text-[13px] text-ink-3 transition hover:bg-white md:flex"
            aria-label="打开 Spotlight 快捷跳转（⌘K）"
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
              <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="m9.5 9.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            搜索工作台 · 跳转路由
            <kbd className="ml-auto rounded-md bg-black/5 px-1.5 py-0.5 font-mono text-[11px] text-ink-2">⌘K</kbd>
          </button>
        </div>

        {/* —— 右：双模型容灾灯 + RBAC + Kill Switch —— */}
        <div className="flex shrink-0 items-center gap-2">
          <span
            className="hidden items-center gap-2 rounded-full border border-hairline bg-white/70 px-3 py-1.5 text-[12px] text-ink-2 lg:inline-flex"
            title="主模型 OpenAI · 备模型 Anthropic · 容灾自动切换"
          >
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" aria-hidden />
              <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
            </span>
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
            双模型在线
          </span>

          <details className="group relative">
            <summary
              className="flex cursor-pointer list-none items-center gap-2 rounded-full border border-hairline bg-white/70 px-3 py-1.5 text-[13px] text-ink transition hover:bg-white"
              aria-label={`当前角色：${RBAC_ROLE_LABELS[role]}，点击切换四级 RBAC 角色`}
            >
              <svg width="12" height="13" viewBox="0 0 12 13" fill="none" aria-hidden>
                <path d="M6 1 10.5 2.8v3.4c0 2.8-1.9 4.7-4.5 5.8-2.6-1.1-4.5-3-4.5-5.8V2.8L6 1Z" stroke="currentColor" strokeWidth="1.3" />
              </svg>
              <span className="hidden lg:inline">{RBAC_ROLE_LABELS[role]}</span>
              <span className="lg:hidden">{role === "visitor" ? "访客" : role === "specialist" ? "专员" : role === "approver" ? "审批官" : "安管员"}</span>
            </summary>
            <div className="bento glass absolute right-0 top-full z-50 mt-2 w-72 p-1.5">
              <p className="px-3 pb-1.5 pt-2 text-[11px] font-medium text-ink-3">四级 RBAC（演示切换 · 服务端会话为准，自称身份不采信）</p>
              {RBAC_ROLE_ORDER.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRole(r)}
                  aria-pressed={role === r}
                  className={`w-full rounded-[12px] px-3 py-2 text-left transition ${
                    role === r ? "bg-black/5" : "hover:bg-black/5"
                  }`}
                >
                  <span className={`block text-[13px] ${role === r ? "font-semibold text-ink" : "text-ink-2"}`}>
                    {RBAC_ROLE_LABELS[r]}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-ink-3">{RBAC_ROLE_HINTS[r]}</span>
                </button>
              ))}
              <p className="mt-1 border-t border-hairline px-3 pb-1.5 pt-2 text-[11px] leading-4 text-ink-3">
                审批放行永远叠加 <span className="font-medium text-amber-600">FIN-001 具名校验</span>，AI 不充当审批人。
              </p>
            </div>
          </details>

          <button
            type="button"
            onClick={onToggleKill}
            aria-pressed={killEngaged}
            title={killEngaged ? "Kill Switch 已触发：全部自动化切断（再点一次恢复）" : "物理 Kill Switch：5 秒内切断全部自动化，日志保留"}
            className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] font-medium transition ${
              killEngaged
                ? "border-red-300 bg-red-500/10 text-red-600"
                : "border-hairline bg-white/70 text-ink-2 hover:bg-white"
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${killEngaged ? "bg-red-500" : "bg-zinc-300"}`} aria-hidden />
            Kill Switch
          </button>
        </div>
      </div>

      {killEngaged && (
        <div className="flex items-center justify-center gap-2 bg-red-500/10 px-4 py-1.5 text-[12px] font-medium text-red-600" role="alert">
          ⛔ Kill Switch 已触发：全部自动化已切断（演练指示），审计日志完整保留；放行仍归具名审批人。
        </div>
      )}
    </header>
  );
}
