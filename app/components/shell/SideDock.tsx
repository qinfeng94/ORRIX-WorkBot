"use client";

/**
 * 左侧 240px 可折叠毛玻璃侧边坞
 * 四大分组收纳全部路由；移动端自动收为抽屉；支持「Keynote 演示模式」隐藏侧边坞。
 * 红线提示：导航只做展示，页面上不放行任何资金动作。
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SHELL_NAV_GROUPS } from "./nav-config";

interface SideDockProps {
  /** 桌面端折叠态 */
  readonly collapsed: boolean;
  /** 移动端抽屉开合 */
  readonly mobileOpen: boolean;
  readonly onCloseMobile: () => void;
  readonly onEnterKeynote: () => void;
}

function NavGroups({ onNavigate }: { readonly onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex-1 overflow-y-auto px-3 pb-6" aria-label="WorkBot 全站导航">
      {SHELL_NAV_GROUPS.map((group) => (
        <section key={group.title} className="mb-5">
          <h3 className="px-3 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
            {group.title}
          </h3>
          <ul className="space-y-0.5">
            {group.routes.map((route) => {
              const active = pathname === route.href;
              return (
                <li key={route.href}>
                  <Link
                    href={route.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={`block truncate rounded-[12px] px-3 py-2 text-[13px] transition ${
                      active
                        ? "font-semibold text-accent"
                        : "text-ink-2 hover:bg-black/5 hover:text-ink"
                    }`}
                    style={active ? { background: "var(--tenant-accent-soft)" } : undefined}
                  >
                    {route.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </nav>
  );
}

function DockFooter({
  onEnterKeynote,
}: {
  readonly onEnterKeynote: () => void;
}) {
  return (
    <div className="border-t border-hairline p-3">
      <button
        type="button"
        onClick={onEnterKeynote}
        className="flex w-full items-center justify-center gap-2 rounded-[12px] border border-hairline bg-white/70 px-3 py-2 text-[13px] font-medium text-ink transition hover:bg-white"
        title="隐藏侧边坞，进入大画布演示模式"
      >
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
          <rect x="1.5" y="2.5" width="11" height="7.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M5 12.5h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        Keynote 演示模式
      </button>
      <p className="mt-2 px-1 text-[11px] leading-4 text-ink-3">
        AI 只读 · 起草 · 标记，放行永远归人。
      </p>
    </div>
  );
}

export default function SideDock({ collapsed, mobileOpen, onCloseMobile, onEnterKeynote }: SideDockProps) {
  return (
    <>
      {/* 桌面端侧边坞（Keynote 模式下隐藏） */}
      <aside
        className={`glass sticky top-14 hidden h-[calc(100vh-3.5rem)] w-[240px] shrink-0 flex-col border-r border-hairline transition-all duration-300 md:flex ${
          collapsed ? "-ml-[240px]" : "ml-0"
        }`}
        aria-label="侧边坞导航"
      >
        <NavGroups />
        <DockFooter onEnterKeynote={onEnterKeynote} />
      </aside>

      {/* 移动端抽屉 */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="导航抽屉">
          <button
            type="button"
            className="absolute inset-0 bg-black/25"
            onClick={onCloseMobile}
            aria-label="关闭导航抽屉"
          />
          <aside className="glass absolute inset-y-0 left-0 flex w-[280px] flex-col pt-14 shadow-2xl">
            <NavGroups onNavigate={onCloseMobile} />
            <DockFooter onEnterKeynote={onEnterKeynote} />
          </aside>
        </div>
      )}
    </>
  );
}
