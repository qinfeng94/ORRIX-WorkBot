"use client";

/**
 * /sandbox-demo —— MCP Apps 沙盒演示子页（运行在 iframe sandbox="allow-scripts" 里）
 * 溯源：04 号文档 CISO 条款（外部内容隔离 + 最小权限）。
 * 关键点：因为父级 iframe 没给 allow-same-origin，本页运行在「不透明源（opaque origin）」：
 * - document.cookie 直接抛 SecurityError（偷 Cookie 被浏览器拦截 → 亮绿盾）；
 * - window.parent.location 等跨窗访问同样被拒；
 * - 想发起审批只能 parent.postMessage 走消息桥，且必须经主站校验 + 人工批准。
 */

import { useEffect, useState } from "react";

interface ProbeResult {
  channel: string;
  blocked: boolean;
  detail: string;
}

/** 模块加载信号：client bundle 一执行就通知父页（早于 React hydration，用作诊断探针） */
if (typeof window !== "undefined" && window.parent !== window) {
  try {
    window.parent.postMessage({ type: "workbot_sandbox_loaded" }, "*");
  } catch {
    // 信号失败不影响演示
  }
}

export default function SandboxDemoPage() {
  const [probes, setProbes] = useState<ProbeResult[]>([]);
  const [bridgeSent, setBridgeSent] = useState(false);

  /** 幕一：尝试偷读主站数据（在沙盒里必然被浏览器拦截） */
  const trySteal = (): void => {
    const results: ProbeResult[] = [];

    try {
      // 尝试 1：读 Cookie（沙盒不透明源下 document.cookie 抛 SecurityError）
      const c = document.cookie;
      results.push({
        channel: "document.cookie",
        blocked: false,
        detail: `竟然读到了：${c}（说明未在沙盒中运行，请检查 iframe sandbox 属性！）`,
      });
    } catch (err: unknown) {
      results.push({
        channel: "document.cookie",
        blocked: true,
        detail: `SecurityError：${err instanceof Error ? err.message.slice(0, 80) : "访问被拒"}`,
      });
    }

    try {
      // 尝试 2：摸父窗口地址栏 / DOM（跨源访问直接被拒）
      const parentLoc = (window.parent as Window).location.href;
      results.push({
        channel: "window.parent.location",
        blocked: false,
        detail: `竟然读到了父页地址：${parentLoc}（异常！请检查 sandbox 配置）`,
      });
    } catch (err: unknown) {
      results.push({
        channel: "window.parent.location",
        blocked: true,
        detail: `SecurityError：${err instanceof Error ? err.message.slice(0, 80) : "访问被拒"}`,
      });
    }

    try {
      // 尝试 3：直接翻父窗口的 DOM（localStorage 同样不可达）
      window.parent.localStorage.getItem("anything");
      results.push({ channel: "window.parent.localStorage", blocked: false, detail: "竟然访问成功（异常！）" });
    } catch (err: unknown) {
      results.push({
        channel: "window.parent.localStorage",
        blocked: true,
        detail: `SecurityError：${err instanceof Error ? err.message.slice(0, 80) : "访问被拒"}`,
      });
    }

    setProbes(results);
  };

  /** 幕二：经 PostMessage 消息桥合规发起审批请求（唯一合法跨窗通道） */
  const requestApprovalViaBridge = (): void => {
    window.parent.postMessage(
      {
        type: "workbot_sandbox_approval_request",
        summary: "沙盒内应用请求：为工单 TCK-3117（CUST-8842 重复扣款 ¥52,800）发起 FIN-001 财务复核",
      },
      "*",
    );
    setBridgeSent(true);
  };

  // 自动演示（双保险）：
  // ① 父页握手：收到 workbot_sandbox_auto（父页 iframe onLoad 时发出）即重放两幕；
  // ② ?auto=1 兜底：本页挂载后自行重放。
  useEffect(() => {
    const autoRun = (): void => {
      trySteal();
      requestApprovalViaBridge();
    };
    const onMessage = (e: MessageEvent): void => {
      const data = e.data as { type?: string } | null;
      if (typeof data === "object" && data !== null && data.type === "workbot_sandbox_auto") {
        autoRun();
      }
    };
    window.addEventListener("message", onMessage);
    if (new URLSearchParams(window.location.search).has("auto")) {
      const t = setTimeout(autoRun, 300);
      return () => {
        window.removeEventListener("message", onMessage);
        clearTimeout(t);
      };
    }
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allBlocked = probes.length > 0 && probes.every((p) => p.blocked);

  return (
    <div className="min-h-screen bg-white p-4 text-sm">
      {/* 沙盒内嵌运行时隐藏全局导航（本样式只作用于 iframe 文档自身） */}
      <style>{`header{display:none!important}`}</style>

      <p className="rounded-lg bg-zinc-100 px-3 py-2 font-mono text-xs text-zinc-500">
        运行环境：iframe sandbox=&quot;allow-scripts&quot;（不透明源，无任何同源特权）
      </p>

      <h2 className="mt-3 text-base font-bold">幕一 · 点击偷读主站 Cookie</h2>
      <button
        onClick={trySteal}
        className="mt-2 rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 hover:border-zinc-500"
      >
        🕵️ 尝试偷读主站 Cookie / 父窗口数据
      </button>

      {probes.length > 0 && (
        <div
          className={`mt-3 rounded-xl border-2 p-3 ${
            allBlocked ? "border-emerald-400 bg-emerald-50" : "border-red-400 bg-red-50"
          }`}
        >
          <p className={`text-sm font-bold ${allBlocked ? "text-emerald-700" : "text-red-700"}`}>
            {allBlocked ? "🛡️ 绿盾：全部尝试被浏览器安全策略拦截" : "⛔ 有通道未被拦截（配置异常）"}
          </p>
          <div className="mt-2 space-y-1.5">
            {probes.map((p) => (
              <p key={p.channel} className="font-mono text-xs leading-5 text-zinc-600">
                <span className={p.blocked ? "text-emerald-700" : "text-red-700"}>
                  {p.blocked ? "拦截" : "泄漏"}
                </span>{" "}
                {p.channel} → {p.detail}
              </p>
            ))}
          </div>
        </div>
      )}

      <h2 className="mt-5 text-base font-bold">幕二 · PostMessage 消息桥合规发起审批</h2>
      <button
        onClick={requestApprovalViaBridge}
        className="mt-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700"
      >
        📨 经消息桥发起审批请求
      </button>
      {bridgeSent && (
        <p className="mt-2 rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-xs leading-5 text-sky-800">
          已通过 PostMessage 把审批请求发给主站（这是沙盒里唯一合法的跨窗通道）。
          主站会校验来源窗口与消息白名单，然后把它转成黄区草稿——右侧主站面板应出现琥珀色审批卡，
          还需要具名审批人手动批准，沙盒自己无权放行任何东西。
        </p>
      )}

      <p className="mt-4 border-t border-zinc-100 pt-3 text-xs leading-6 text-zinc-400">
        本页 = 模拟「第三方 MCP App」。沙盒给了它 JS 执行权（allow-scripts），但没给同源特权
        （无 allow-same-origin），所以它读不到 Cookie、摸不到父窗口、改不了主站 DOM；
        想做事只能走受控消息桥。
      </p>
    </div>
  );
}
