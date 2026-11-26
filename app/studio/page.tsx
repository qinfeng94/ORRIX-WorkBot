"use client";

/**
 * /studio —— Day 8 生成式 UI 动态工作台
 * 溯源：AGENTS.md 红线——大模型只输出受控布局 JSON（严禁原始 HTML/JS），
 *      渲染权在 ComponentRegistry 白名单注册表手里；
 *      04 号文档（approval_form_card 批准必须具名审批人，真实回写审计表）。
 * 透明度：右上角可随时查看「布局 JSON 源码」，所见即模型产出的全部内容；
 * 沙盒区：MCP Apps 演示 iframe sandbox="allow-scripts"（无 allow-same-origin）
 *        ——子页偷 Cookie 被浏览器拦截，跨窗协作只能走 PostMessage 消息桥 + 人工批准。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  GENUI_APPROVED_EVENT,
  GenuiRuntimeContext,
  RenderGenuiItem,
} from "@/components/genui/ComponentRegistry";
import type { GenuiLayoutItem } from "@/lib/genui/catalog-schema";

interface GenUiResponse {
  mode: string;
  preset?: string;
  presetLabel?: string;
  layout?: GenuiLayoutItem[];
  modelText?: string;
  metricsNote?: string;
  error?: string;
}

/** 沙盒消息桥发来的合规审批请求 */
interface BridgeRequest {
  summary: string;
  approvalId: string;
}

const PRESET_BUTTONS = [
  { key: "cfo", label: "👔 CFO 晨会", question: "给我 CFO 晨会大屏：待审批、批准量、费用与部门分布。" },
  { key: "csd", label: "🎧 客服总监", question: "给我客服总监看板：客诉漏斗、响应率与最新工单。" },
  { key: "ciso", label: "🛡️ CISO 合规", question: "给我 CISO 合规态势：红区条款与三色权限边界。" },
] as const;

export default function StudioPage() {
  const [question, setQuestion] = useState("");
  const [layout, setLayout] = useState<GenuiLayoutItem[]>([]);
  const [modelText, setModelText] = useState("");
  const [presetLabel, setPresetLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [sandboxOpen, setSandboxOpen] = useState(false);
  const [bridgeRequest, setBridgeRequest] = useState<BridgeRequest | null>(null);
  const [sandboxJsLoaded, setSandboxJsLoaded] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<string>("");

  const sessionIdRef = useRef<string>("");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const lastQueryRef = useRef<string>("");

  useEffect(() => {
    sessionIdRef.current = crypto.randomUUID();
  }, []);

  /** 拉取布局（mode=full）或刷新指标（mode=metrics） */
  const load = useCallback(
    async (mode: "full" | "metrics", preset?: string, question?: string): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/generative-ui", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode,
            preset: preset ?? "",
            question: question ?? "",
            sessionId: sessionIdRef.current,
          }),
        });
        const data: unknown = await res.json();
        if (!res.ok) {
          throw new Error((data as { error?: string }).error ?? `接口返回 ${res.status}`);
        }
        const body = data as GenUiResponse;
        const items = body.layout ?? [];
        if (mode === "full") {
          setLayout(items);
          setModelText(body.modelText ?? "");
          setPresetLabel(body.presetLabel ?? "");
          lastQueryRef.current = question ?? "";
        } else {
          // metrics 模式：把最新指标区（前 4 个 KPI/费用卡）合并进当前布局
          setLayout((prev) => {
            const rest = prev.filter(
              (it) => it.component !== "kpi_card" && it.component !== "cost_card",
            );
            return [...items, ...rest];
          });
        }
        setLastRefresh(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "加载失败");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // 首屏：综合速览
  useEffect(() => {
    void load("full", "", "综合速览");
  }, [load]);

  // 批准回写成功 → 立刻刷新大屏指标（metrics 轻量刷新，不重跑整份布局）
  useEffect(() => {
    const onApproved = (): void => {
      void load("metrics");
    };
    window.addEventListener(GENUI_APPROVED_EVENT, onApproved);
    return () => window.removeEventListener(GENUI_APPROVED_EVENT, onApproved);
  }, [load]);

  // 沙盒消息桥：校验来源窗口 + 消息形状 + 白名单类型，通过后才放行成审批草稿
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== iframeRef.current?.contentWindow) return; // 必须来自我们的沙盒 iframe
      const data = e.data as { type?: string; summary?: string } | null;
      if (typeof data !== "object" || data === null) return;
      if (data.type === "workbot_sandbox_loaded") {
        // 子页 client bundle 已执行（诊断探针）
        setSandboxJsLoaded(true);
        return;
      }
      if (data.type !== "workbot_sandbox_approval_request") return; // 消息类型白名单
      const summary = String(data.summary ?? "").slice(0, 120).replace(/[<>]/g, "");
      if (summary.length === 0) return;
      setBridgeRequest({
        summary,
        approvalId: `AP-BRIDGE-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Date.now() % 1000}`,
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  /** 父页驱动握手：iframe 加载完成后主动通知子页重放自动演示（不依赖子页 hydration 时序） */
  const onSandboxFrameLoad = (): void => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: "workbot_sandbox_auto" },
      "*",
    );
  };

  /** 导出报告：把当前布局 JSON 下载为文件（export_report_button 组件经上下文调用） */
  const exportLayout = useCallback((): void => {
    const blob = new Blob(
      [JSON.stringify({ exportedAt: new Date().toISOString(), layout }, null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "workbot-studio-report.json";
    a.click();
    URL.revokeObjectURL(url);
  }, [layout]);

  return (
    <GenuiRuntimeContext.Provider value={{ exportLayout, sessionId: sessionIdRef.current }}>
      <div className="min-h-screen bg-zinc-50 px-4 py-6 font-sans text-zinc-900 sm:px-6">
        <main className="mx-auto w-full max-w-6xl">
          {/* 标题 + JSON 源码开关 */}
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">生成式 UI 动态工作台</h1>
              <p className="mt-1 text-sm text-zinc-500">
                大模型只输出受控布局 JSON（点菜式组件），严禁输出原始 HTML/JS；全部渲染经过白名单注册表。
              </p>
            </div>
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700">
              <input
                type="checkbox"
                checked={showJson}
                onChange={(e) => setShowJson(e.target.checked)}
                className="h-4 w-4"
              />
              查看布局 JSON 源码
            </label>
          </div>

          {/* 提问框 + 预设按钮 */}
          <div className="mb-4 space-y-3 rounded-xl border border-zinc-200 bg-white p-4">
            <div className="flex gap-2">
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && question.trim()) {
                    void load("full", "", question);
                  }
                }}
                placeholder="向 AI 描述你要的大屏，例如：CFO 晨会要看的费用与审批态势…"
                className="min-h-[44px] flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
              />
              <button
                onClick={() => question.trim() && void load("full", "", question)}
                disabled={loading || question.trim().length === 0}
                className="rounded-lg bg-zinc-900 px-5 py-2 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-40"
              >
                {loading ? "生成中…" : "生成大屏"}
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {PRESET_BUTTONS.map((p) => (
                <button
                  key={p.key}
                  onClick={() => void load("full", p.key, p.question)}
                  disabled={loading}
                  className="rounded-full border border-zinc-300 bg-white px-4 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:border-zinc-500 disabled:opacity-50"
                >
                  {p.label}
                </button>
              ))}
              <button
                onClick={() => void load("full", "zero", "0 数据边界测试：所有数据为空或全零")}
                disabled={loading}
                className="rounded-full border border-dashed border-red-300 bg-red-50 px-4 py-1.5 text-sm font-medium text-red-700 transition-colors hover:border-red-500 disabled:opacity-50"
              >
                🧪 0 数据边界测试
              </button>
              {lastRefresh && (
                <span className="ml-auto self-center font-mono text-xs text-zinc-400">
                  指标刷新于 {lastRefresh}（数据库实读）
                </span>
              )}
            </div>
          </div>

          {error && (
            <div className="mb-4 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800">
              ⛔ 布局被安全管线拒绝：{error}
            </div>
          )}

          {/* JSON 源码视图（模型产出的全部内容，透明可审计） */}
          {showJson && (
            <div className="mb-4 rounded-xl border border-zinc-300 bg-zinc-900 p-4">
              <p className="mb-2 text-xs font-semibold text-zinc-400">
                模型输出（已剥离 ```json 围栏并通过白名单校验——这就是它的全部输出，不含任何 HTML/JS）
              </p>
              <pre className="max-h-80 overflow-auto font-mono text-xs leading-5 text-emerald-300">
                {modelText || "（暂无）"}
              </pre>
            </div>
          )}

          {/* 当前布局视图 */}
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-semibold text-white">
              {presetLabel || "综合速览"}
            </span>
            <span className="font-mono text-xs text-zinc-400">
              {layout.length} 个受控组件 · 全部经独立 ErrorBoundary 包裹
            </span>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {layout.map((item, i) => (
              <div
                key={i}
                className={item.component === "ticket_table" ? "md:col-span-2" : ""}
              >
                <RenderGenuiItem item={item} />
              </div>
            ))}
          </div>
          {layout.length === 0 && !loading && !error && (
            <p className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-400">
              点击上方按钮生成大屏。
            </p>
          )}

          {/* MCP Apps 沙盒演示区（可折叠） */}
          <div className="mt-8 rounded-xl border border-zinc-200 bg-white">
            <button
              onClick={() => setSandboxOpen((v) => !v)}
              className="flex w-full items-center justify-between px-4 py-3 text-left"
            >
              <span className="text-sm font-bold text-zinc-700">
                🧩 MCP Apps 沙盒演示区
                <span className="ml-2 font-normal text-zinc-400">
                  iframe sandbox=&quot;allow-scripts&quot;（无 allow-same-origin）
                </span>
              </span>
              <span className="text-zinc-400">{sandboxOpen ? "▲ 收起" : "▼ 展开"}</span>
            </button>
            {sandboxOpen && (
              <div className="space-y-4 border-t border-zinc-100 p-4">
                <p className="text-xs leading-6 text-zinc-500">
                  左侧沙盒子页运行在 <span className="font-mono">opaque origin</span>（不透明源）里：
                  它试图偷读主站 Cookie 会被浏览器安全策略直接拦截（亮绿盾）；
                  它想发起审批只能走 <span className="font-mono">PostMessage 消息桥</span>——
                  主站校验来源窗口与消息白名单后，把请求转成黄区审批草稿，仍需具名审批人批准。
                  提示：个别自动化/无头浏览器会禁用不透明源 iframe 的脚本；若「JS 加载信号」一直不亮，
                  请在真实 Chrome / Edge 中查看，或点「▶ 重放沙盒演示」重新握手。
                </p>
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <iframe
                    ref={iframeRef}
                    src="/sandbox-demo?embed=1"
                    onLoad={onSandboxFrameLoad}
                    sandbox="allow-scripts"
                    title="MCP Apps 沙盒演示"
                    className="h-[430px] w-full rounded-xl border-2 border-dashed border-zinc-300"
                  />
                  <div className="space-y-3 rounded-xl border border-zinc-200 bg-zinc-50 p-4">
                    <p className="text-sm font-bold text-zinc-700">主站侧（消息桥接收端）</p>
                    {bridgeRequest ? (
                      <RenderGenuiItem
                        item={{
                          component: "dry_run_confirm_card",
                          props: {
                            approvalId: bridgeRequest.approvalId,
                            tool: "update_crm_profile",
                            title: "沙盒桥接审批请求（合规通道）",
                            summary: bridgeRequest.summary,
                            draft: { via: "postMessage bridge", origin: "opaque sandbox" },
                          },
                        }}
                      />
                    ) : (
                      <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-sm text-zinc-400">
                        尚未收到沙盒消息。子页加载时会自动发起（auto=1 演示模式），也可在左侧子页点击「经消息桥发起审批请求」手动重放。
                      </p>
                    )}
                    <div className="flex items-center gap-2 text-xs">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-1 font-mono ${
                          sandboxJsLoaded
                            ? "border border-emerald-300 bg-emerald-50 text-emerald-700"
                            : "border border-zinc-300 bg-white text-zinc-400"
                        }`}
                      >
                        {sandboxJsLoaded ? "子页 JS 已加载（模块加载信号已收到）" : "等待子页 JS 加载信号…"}
                      </span>
                      <button
                        onClick={() => onSandboxFrameLoad()}
                        className="rounded-full border border-sky-300 bg-sky-50 px-2.5 py-1 font-medium text-sky-700 hover:bg-sky-100"
                      >
                        ▶ 重放沙盒演示
                      </button>
                    </div>
                    <ul className="space-y-1 text-xs leading-6 text-zinc-500">
                      <li>✅ 校验 event.source 必须是我们的 iframe（防其他窗口伪造）</li>
                      <li>✅ 消息类型白名单：仅接受 workbot_sandbox_approval_request</li>
                      <li>✅ 文本截断 120 字并剥离 &lt;&gt;（防注入）</li>
                      <li>✅ 请求只变成黄区草稿，放行仍需具名审批人点击批准</li>
                    </ul>
                  </div>
                </div>
              </div>
            )}
          </div>

          <footer className="mt-6 rounded-xl border border-zinc-200 bg-white p-4 text-xs leading-6 text-zinc-500">
            🔒 安全声明：大模型输出仅为白名单组件名 + 受控 Props（JSON），渲染管线内置
            ```json 围栏剥离、逐组件校验、禁用模式扫描（&lt;script / javascript: / onerror
            等注入特征整条 400）；审批类组件批准后真实回写审计表（只增不改），大屏指标由数据库实时刷新。
          </footer>
        </main>
      </div>
    </GenuiRuntimeContext.Provider>
  );
}
