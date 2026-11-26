"use client";

/**
 * 三层极简 App Shell（Apple Keynote 浅色系）
 * 第一层：56px 磨砂指挥栏（TopBar）
 * 第二层：240px 可折叠毛玻璃侧边坞（SideDock，移动端自动收为抽屉，可进 Keynote 演示模式）
 * 第三层：内容画布（children，各页面自持版式）
 * 快捷键：⌘K / Ctrl+K 唤起 Spotlight；演示模式下 Esc 退出。
 */

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import TopBar from "./TopBar";
import SideDock from "./SideDock";
import Spotlight from "./Spotlight";

export default function AppShell({ children }: { readonly children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [keynote, setKeynote] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [spotlightOpen, setSpotlightOpen] = useState(false);
  const [killEngaged, setKillEngaged] = useState(false);

  // ⌘K / Ctrl+K 全局唤起 Spotlight
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSpotlightOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Keynote 演示模式：Esc 退出
  useEffect(() => {
    if (!keynote) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setKeynote(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keynote]);

  const toggleKill = useCallback(() => {
    if (!killEngaged) {
      const ok = window.confirm(
        "确认触发物理 Kill Switch？\n全部自动化将在 5 秒内切断（演练指示），审计日志完整保留。",
      );
      if (!ok) return;
    }
    setKillEngaged(!killEngaged);
  }, [killEngaged]);

  const enterKeynote = useCallback(() => {
    setKeynote(true);
    setMobileOpen(false);
    setCollapsed(true);
  }, []);

  return (
    <div className="flex min-h-screen flex-col">
      <TopBar
        onOpenMobileNav={() => setMobileOpen(true)}
        onToggleSidebar={() => setCollapsed((v) => !v)}
        onOpenSpotlight={() => setSpotlightOpen(true)}
        killEngaged={killEngaged}
        onToggleKill={toggleKill}
      />

      <div className="flex flex-1">
        {!keynote && (
          <SideDock
            collapsed={collapsed}
            mobileOpen={mobileOpen}
            onCloseMobile={() => setMobileOpen(false)}
            onEnterKeynote={enterKeynote}
          />
        )}
        <main className="keynote-stage min-w-0 flex-1">{children}</main>
      </div>

      {/* 演示模式下的悬浮退出按钮 */}
      {keynote && (
        <button
          type="button"
          onClick={() => setKeynote(false)}
          className="bento glass fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-2.5 text-[13px] font-medium text-ink shadow-[0_8px_28px_rgba(0,0,0,0.14)] transition hover:scale-[1.02]"
        >
          <span className="text-ink-3" aria-hidden>⌘</span> Esc 退出演示模式
        </button>
      )}

      <Spotlight open={spotlightOpen} onClose={() => setSpotlightOpen(false)} />
    </div>
  );
}
