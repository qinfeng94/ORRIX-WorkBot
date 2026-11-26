"use client";

/**
 * ⌘K Spotlight 快捷跳转面板（macOS 质感）
 * 全站路由模糊过滤 + 键盘导航（↑ ↓ Enter Esc）；仅做纯前端跳转，无任何数据写入。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SHELL_NAV_GROUPS } from "./nav-config";

interface SpotlightProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

const ALL_ROUTES = SHELL_NAV_GROUPS.flatMap((g) =>
  g.routes.map((r) => ({ ...r, group: g.title })),
);

export default function Spotlight({ open, onClose }: SpotlightProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ALL_ROUTES;
    return ALL_ROUTES.filter(
      (r) => r.label.toLowerCase().includes(q) || r.href.toLowerCase().includes(q) || r.group.toLowerCase().includes(q),
    );
  }, [query]);

  // 打开时聚焦输入框并重置
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      // 等面板渲染完成后聚焦
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  if (!open) return null;

  const go = (href: string) => {
    router.push(href);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = results[activeIndex];
      if (target) go(target.href);
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Spotlight 快捷跳转">
      <button type="button" className="absolute inset-0 bg-black/20" onClick={onClose} aria-label="关闭 Spotlight" />
      <div className="bento glass mx-auto mt-[14vh] w-[min(560px,92vw)] overflow-hidden p-0 shadow-[0_24px_80px_rgba(0,0,0,0.18)]">
        <div className="flex items-center gap-3 border-b border-hairline px-5">
          <svg width="15" height="15" viewBox="0 0 14 14" fill="none" aria-hidden className="shrink-0 text-ink-3">
            <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="m9.5 9.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="搜索工作台 · 输入路由或功能名"
            className="h-12 w-full bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3"
            aria-label="搜索路由"
          />
          <kbd className="shrink-0 rounded-md bg-black/5 px-1.5 py-0.5 font-mono text-[11px] text-ink-3">Esc</kbd>
        </div>

        <ul className="max-h-[46vh] overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <li className="px-4 py-6 text-center text-[13px] text-ink-3">没有匹配的工作台，换个关键词试试。</li>
          ) : (
            results.map((r, i) => (
              <li key={r.href}>
                <button
                  type="button"
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => go(r.href)}
                  className={`flex w-full items-center gap-3 rounded-[12px] px-3.5 py-2.5 text-left transition ${
                    i === activeIndex ? "bg-black/5" : ""
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium text-ink">{r.label}</span>
                    <span className="block truncate font-mono text-[11px] text-ink-3">{r.href}</span>
                  </span>
                  <span className="shrink-0 rounded-full bg-black/5 px-2.5 py-1 text-[11px] text-ink-2">{r.group}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
