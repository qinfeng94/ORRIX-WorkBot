"use client";

/**
 * TopNav —— 全站顶部导航栏（工单协同台 / 对话工作台）
 * 用 usePathname 高亮当前页；链接全部走 next/link 客户端路由。
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "工单协同台" },
  { href: "/chat", label: "对话工作台" },
  { href: "/studio", label: "生成式 UI" },
  { href: "/investigate", label: "调查引擎" },
  { href: "/multi-agent", label: "客服专班" },
  { href: "/rag-lab", label: "检索实验室" },
  { href: "/browser-lab", label: "浏览器实验室" },
  { href: "/research-analyst", label: "尽调研究台" },
] as const;

export default function TopNav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-zinc-200 bg-white/90 backdrop-blur">
      <nav className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-bold tracking-tight">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-zinc-900 text-sm text-white">
            星
          </span>
          <span>星辰 WorkBot</span>
        </Link>
        <div className="flex items-center gap-1">
          {NAV_ITEMS.map((item) => {
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
                  active
                    ? "bg-zinc-900 text-white"
                    : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </header>
  );
}
