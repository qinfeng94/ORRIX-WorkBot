"use client";

/**
 * /channels —— Day 32【4 渠道统一接入网关】联调模拟器
 * 溯源：统一接入网关需求——左侧「企业微信 / 飞书」问 CUST-8842，右侧「邮件 / 手机 H5」
 *      追问「刚才那单批了吗」，亲眼验证跨 4 端上下文与审批状态 100% 同步。
 * 边界（与 AGENTS.md 对齐）：
 * - 页面在浏览器内用 WebCrypto 计算 HMAC 签名后直连 /api/channels/webhook（演示密钥由
 *   网关下发；生产通道被环境变量接管后绝不下发密钥、模拟器拒绝发送）；
 * - 批准动作只走既有 /api/chat/approve（具名审批人 + 幂等 + 审计落账），全站无自动打款。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChannelId,
  ChannelMeta,
  ChannelReceipt,
  ThreadView,
} from "@/lib/channels/types";

/* ================================================================
 * 一、联调剧本与通道身份
 * ================================================================ */

type TabKey = "im:wecom" | "im:feishu" | "email" | "h5";
type BusKey = TabKey | "web";

/** 各通道演示身份（网关侧别名解析统一归一为「林总」，证明跨端同线程） */
const CHANNEL_SENDER: Record<BusKey, { userId: string; display: string }> = {
  "im:wecom": { userId: "wecom-linzong", display: "企业微信" },
  "im:feishu": { userId: "feishu-linzong", display: "飞书" },
  email: { userId: "lin.zong@xingchen-demo.com", display: "邮件入站" },
  h5: { userId: "h5-linzong", display: "手机 H5" },
  web: { userId: "web-linzong", display: "Web 工作台" },
};

const DEFAULT_USER_KEY = "林总";

interface MetaPayload {
  ok: true;
  tenantId: string;
  company: string;
  approvers: string[];
  channels: ChannelMeta[];
}

type Bubble =
  | { kind: "user"; text: string; at: number; senderDisplay: string; subject?: string }
  | { kind: "assistant"; engineText: string; engineTag: string; at: number }
  | { kind: "notice"; level: "info" | "warn" | "fallback"; text: string }
  | { kind: "receipt"; receipt: ChannelReceipt; at: number };

/** 信封构造：吸收 4 通道字段差异（与服务端 adapters 的归一口径一一对应） */
function buildEnvelope(tab: BusKey, tenantId: string, text: string): string {
  const sender = CHANNEL_SENDER[tab];
  switch (tab) {
    case "im:wecom":
      return JSON.stringify({ channel: "im", platform: "wecom", tenantId, channelUserId: sender.userId, text });
    case "im:feishu":
      return JSON.stringify({ channel: "im", platform: "feishu", tenantId, channelUserId: sender.userId, text });
    case "email":
      return JSON.stringify({ channel: "email", tenantId, from: sender.userId, subject: text.slice(0, 80), text });
    case "h5":
      return JSON.stringify({ channel: "h5", tenantId, deviceId: sender.userId, text });
    case "web":
      return JSON.stringify({ channel: "web", tenantId, channelUserId: sender.userId, text });
  }
}

async function hmacHex(secret: string, base: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(base));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const fmtTime = (at: number): string =>
  new Date(at).toLocaleTimeString("zh-CN", { hour12: false });

/* ================================================================
 * 二、页面
 * ================================================================ */

export default function ChannelsSimulatorPage() {
  const [meta, setMeta] = useState<MetaPayload | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [threadView, setThreadView] = useState<ThreadView | null>(null);
  const [bubbles, setBubbles] = useState<Partial<Record<BusKey, Bubble[]>>>({});
  const [busy, setBusy] = useState<Partial<Record<BusKey, boolean>>>({});
  const [inputs, setInputs] = useState<Partial<Record<BusKey, string>>>({});
  const [activeTabs, setActiveTabs] = useState<{ left: TabKey; right: TabKey }>({
    left: "im:wecom",
    right: "email",
  });
  const [approver, setApprover] = useState<string>(DEFAULT_USER_KEY);
  const [ledgerBusy, setLedgerBusy] = useState<string | null>(null);
  const [ledgerNote, setLedgerNote] = useState<{ level: "ok" | "warn"; text: string } | null>(null);

  /* ---- 元信息加载（演示密钥下发；生产通道不下发） ---- */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/channels/webhook?meta=1");
        const data = (await res.json()) as MetaPayload | { error: string };
        if (!alive) return;
        if (!res.ok || !("channels" in data)) {
          throw new Error(("error" in data && data.error) || "网关元信息加载失败");
        }
        setMeta(data);
        setApprover(data.approvers[0] ?? DEFAULT_USER_KEY);
      } catch (e) {
        if (alive) setMetaError(e instanceof Error ? e.message : "网关元信息加载失败");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const pushBubbles = useCallback((tab: BusKey, items: Bubble[]) => {
    setBubbles((prev) => ({ ...prev, [tab]: [...(prev[tab] ?? []), ...items] }));
  }, []);

  /* ---- 签名 + 发送（WebCrypto HMAC → 统一 Webhook） ---- */
  const send = useCallback(
    async (tab: BusKey, textRaw: string) => {
      const text = textRaw.trim();
      if (!text || !meta) return;
      const channel: ChannelId = tab === "web" || tab === "email" || tab === "h5" ? tab : "im";
      const channelMeta = meta.channels.find((c) => c.id === channel);
      if (!channelMeta?.demoSecret) {
        pushBubbles(tab, [
          {
            kind: "notice",
            level: "warn",
            text: "该通道已被生产密钥接管（环境变量生效，密钥不下发），模拟器无法代签。请在演示模式通道联调。",
          },
        ]);
        return;
      }
      const sender = CHANNEL_SENDER[tab];
      setBusy((prev) => ({ ...prev, [tab]: true }));
      setInputs((prev) => ({ ...prev, [tab]: "" }));
      pushBubbles(tab, [{ kind: "user", text, at: Date.now(), senderDisplay: sender.display }]);
      try {
        const body = buildEnvelope(tab, meta.tenantId, text);
        const ts = Date.now();
        const nonce = crypto.randomUUID();
        const sig = await hmacHex(channelMeta.demoSecret, `${channel}.${ts}.${nonce}.${body}`);
        const res = await fetch("/api/channels/webhook", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-workbot-channel": channel,
            "x-workbot-timestamp": String(ts),
            "x-workbot-nonce": nonce,
            "x-workbot-signature": `v1=${sig}`,
          },
          body,
        });
        const data = (await res.json()) as
          | { ok: true; thread: ThreadView; engineText: string; engineTag: string; notices: { level: "info" | "warn" | "fallback"; text: string }[]; receipts: ChannelReceipt[] }
          | { error: string };
        if (!res.ok || !("thread" in data)) {
          throw new Error(("error" in data && data.error) || `网关返回 ${res.status}`);
        }
        setThreadView(data.thread);
        const at = Date.now();
        pushBubbles(tab, [
          { kind: "assistant", engineText: data.engineText, engineTag: data.engineTag, at },
          ...data.notices.map((n) => ({ kind: "notice" as const, level: n.level, text: n.text })),
          ...data.receipts.map((r) => ({ kind: "receipt" as const, receipt: r, at })),
        ]);
      } catch (e) {
        pushBubbles(tab, [
          {
            kind: "notice",
            level: "warn",
            text: e instanceof Error ? e.message : "网关调用失败，请稍后再试。",
          },
        ]);
      } finally {
        setBusy((prev) => ({ ...prev, [tab]: false }));
      }
    },
    [meta, pushBubbles],
  );

  /* ---- 线程刷新（审批状态从审计库真源刷新） ---- */
  const refreshThread = useCallback(async () => {
    try {
      const user = threadView?.userKey ?? DEFAULT_USER_KEY;
      const res = await fetch(
        `/api/channels/webhook?thread=1&tenant=${meta?.tenantId ?? "xingchen"}&user=${encodeURIComponent(user)}`,
      );
      const data = (await res.json()) as { ok: true; thread: ThreadView | null } | { error: string };
      if (res.ok && "thread" in data && data.thread) setThreadView(data.thread);
    } catch {
      /* 刷新失败不打断演示 */
    }
  }, [meta, threadView]);

  /* ---- 批准动作：只走既有具名审批接口（幂等 + 审计落账） ---- */
  const approveInLedger = useCallback(
    async (approvalId: string, summary: string) => {
      setLedgerBusy(approvalId);
      try {
        const res = await fetch("/api/chat/approve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            approvalId,
            tool: "prepare_human_approval_draft",
            summary,
            approver,
            sessionId: (threadView?.threadId ?? "channels-gateway").slice(0, 64),
          }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (res.status === 409) {
          setLedgerNote({ level: "warn", text: data.error ?? "该审批单已批准过（幂等保护）。" });
        } else if (!res.ok) {
          setLedgerNote({ level: "warn", text: data.error ?? `批准失败（${res.status}）` });
        } else {
          setLedgerNote({
            level: "ok",
            text: `${approver} 已签字放行 ${approvalId}，审计落账（只增不改）。到任意渠道问「批了吗」即可验证 4 端同步。`,
          });
        }
      } catch {
        setLedgerNote({ level: "warn", text: "批准请求发送失败，请稍后再试。" });
      } finally {
        setLedgerBusy(null);
        void refreshThread();
      }
    },
    [approver, refreshThread, threadView?.threadId],
  );

  const pendingCount = threadView?.approvals.filter((a) => !a.decided).length ?? 0;
  const approvedCount = threadView?.approvals.filter((a) => a.decided !== null).length ?? 0;

  return (
    <main className="mx-auto w-full max-w-7xl px-4 pb-16 pt-6 sm:px-6">
      {/* 页头 */}
      <div className="mb-4">
        <h1 className="text-xl font-bold tracking-tight text-zinc-900">
          4 渠道统一接入网关 · 联调模拟器
        </h1>
        <p className="mt-1 text-sm leading-6 text-zinc-600">
          Web / 企业 IM Webhook / 邮件入站 / 移动端 H5 四通道统一验签（HMAC-SHA256 + 时间窗 + 防重放）→
          租户识别 → core-engine。同一租户 + 统一身份只有一条跨端线程，审批状态真源在审计库（只增不改）。
        </p>
      </div>

      {/* 红线条幅 */}
      <div className="mb-4 rounded-lg border border-amber-400 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900">
        红线提示：网关只做验签、识别与跨端上下文串联；审批一律由具名审批人签字放行（审计落账），
        全站不存在任何「自动打款」按钮或逻辑。
      </div>

      {metaError ? (
        <div className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-800">
          网关元信息加载失败：{metaError}（请确认 dev 服务器已启动）
        </div>
      ) : null}

      {/* 元信息条 */}
      {meta ? (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-sm">
          <span className="font-semibold text-zinc-900">{meta.company}</span>
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-xs text-zinc-600">
            租户 {meta.tenantId}
          </span>
          <span className="text-zinc-400">·</span>
          <span className="text-zinc-600">
            统一身份 <span className="font-semibold text-zinc-900">林总</span>
            （4 端演示身份经别名解析归一）
          </span>
          <span className="mx-1 h-4 w-px bg-zinc-200" />
          {meta.channels.map((c) => (
            <span
              key={c.id}
              title={c.accessNote}
              className="flex items-center gap-1 rounded-full border border-zinc-200 px-2 py-0.5 text-xs"
            >
              <span className="font-medium text-zinc-700">{c.label}</span>
              {c.mode === "demo" ? (
                <span className="rounded bg-emerald-100 px-1.5 py-px font-medium text-emerald-700">演示签名已下发</span>
              ) : (
                <span className="rounded bg-amber-100 px-1.5 py-px font-medium text-amber-700">生产密钥接管</span>
              )}
            </span>
          ))}
        </div>
      ) : null}

      {/* 联调剧本 */}
      <div className="mb-4 grid gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700 sm:grid-cols-3">
        <div>
          <span className="mr-1 inline-grid h-5 w-5 place-items-center rounded-full bg-zinc-900 text-xs font-bold text-white">1</span>
          左侧用<strong>企业微信 / 飞书</strong>发一句「查一下 CUST-8842 的重复扣款」——触发 FIN-001 挂起审批单
        </div>
        <div>
          <span className="mr-1 inline-grid h-5 w-5 place-items-center rounded-full bg-zinc-900 text-xs font-bold text-white">2</span>
          右侧切到<strong>邮件 / 手机 H5</strong>追问「刚才那单批了吗」——看到跨端上下文与「待审批」状态
        </div>
        <div>
          <span className="mr-1 inline-grid h-5 w-5 place-items-center rounded-full bg-zinc-900 text-xs font-bold text-white">3</span>
          在底部<strong>审批台账</strong>由具名审批人签字 → 再到任意端追问，验证<strong>已批准状态 100% 同步</strong>
        </div>
      </div>

      {/* 左右双端 */}
      <div className="grid gap-4 lg:grid-cols-2">
        <PaneChat
          side="left"
          title="企业 IM Webhook 通道"
          tabs={[
            { key: "im:wecom", label: "企业微信", accent: "indigo" },
            { key: "im:feishu", label: "飞书", accent: "sky" },
          ]}
          activeTab={activeTabs.left}
          onTab={(t) => setActiveTabs((p) => ({ ...p, left: t as TabKey }))}
          bubbles={bubbles[activeTabs.left] ?? []}
          busy={busy[activeTabs.left] ?? false}
          input={inputs[activeTabs.left] ?? ""}
          onInput={(v) => setInputs((p) => ({ ...p, [activeTabs.left]: v }))}
          onSend={() => void send(activeTabs.left, inputs[activeTabs.left] ?? "")}
          preset="查一下 CUST-8842 的重复扣款"
        />
        <PaneChat
          side="right"
          title="邮件入站 / 移动端 H5 通道"
          tabs={[
            { key: "email", label: "邮件入站", accent: "zinc" },
            { key: "h5", label: "手机 H5", accent: "emerald" },
          ]}
          activeTab={activeTabs.right}
          onTab={(t) => setActiveTabs((p) => ({ ...p, right: t as TabKey }))}
          bubbles={bubbles[activeTabs.right] ?? []}
          busy={busy[activeTabs.right] ?? false}
          input={inputs[activeTabs.right] ?? ""}
          onInput={(v) => setInputs((p) => ({ ...p, [activeTabs.right]: v }))}
          onSend={() => void send(activeTabs.right, inputs[activeTabs.right] ?? "")}
          preset="刚才那单批了吗"
        />
      </div>

      {/* 跨端同步总线 */}
      <section className="mt-4 rounded-xl border border-zinc-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3">
          <h2 className="text-sm font-bold text-zinc-900">
            跨端同步总线 · 统一线程 + 审批台账（Web 工作台为第 4 通道）
          </h2>
          <div className="flex items-center gap-2 text-xs">
            <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800">
              挂起 {pendingCount}
            </span>
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-700">
              已批准 {approvedCount}
            </span>
            <button
              onClick={() => void refreshThread()}
              className="rounded-lg border border-zinc-300 px-2.5 py-1 font-medium text-zinc-700 transition-colors hover:bg-zinc-100"
            >
              刷新同步
            </button>
          </div>
        </div>
        <div className="grid gap-4 p-4 lg:grid-cols-3">
          {/* Web 通道迷你发送台 */}
          <div className="rounded-lg border border-violet-200 bg-violet-50/50 p-3">
            <p className="mb-2 text-xs font-semibold text-violet-700">Web 工作台通道（直连同一线程）</p>
            <div className="flex gap-2">
              <input
                value={inputs.web ?? ""}
                onChange={(e) => setInputs((p) => ({ ...p, web: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !busy.web) void send("web", inputs.web ?? "");
                }}
                placeholder="如：刚才那单批了吗"
                className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-violet-500"
              />
              <button
                disabled={busy.web ?? false}
                onClick={() => void send("web", inputs.web ?? "")}
                className="shrink-0 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-violet-700 disabled:opacity-50"
              >
                {busy.web ? "…" : "发送"}
              </button>
            </div>
            <div className="mt-2 space-y-1">
              {(bubbles.web ?? []).slice(-3).map((b, i) => (
                <p key={i} className="truncate text-xs text-zinc-600">
                  {b.kind === "user" ? `我：${b.text}` : b.kind === "assistant" ? `WorkBot：${b.engineText.slice(0, 40)}…` : null}
                </p>
              ))}
            </div>
          </div>

          {/* 统一线程时间线 */}
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
            <p className="mb-2 text-xs font-semibold text-zinc-700">统一线程时间线（4 端汇入，最近 8 条）</p>
            {threadView ? (
              <div className="space-y-1.5">
                {threadView.messages.slice(-8).map((m) => (
                  <div key={m.seq} className="flex items-start gap-1.5 text-xs">
                    <span className="mt-px shrink-0 rounded bg-zinc-200 px-1.5 py-px font-medium text-zinc-700">
                      {m.platform === "wecom" ? "企微" : m.platform === "feishu" ? "飞书" : m.channel === "email" ? "邮件" : m.channel === "h5" ? "H5" : "Web"}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-zinc-600">
                      {m.role === "user" ? "" : "答 · "}
                      {m.text}
                    </span>
                    <span className="shrink-0 text-zinc-400">{fmtTime(m.at)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-zinc-400">还没有消息，先在左右任一端发送一句话。</p>
            )}
          </div>

          {/* 审批台账 */}
          <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3">
            <p className="mb-2 text-xs font-semibold text-amber-800">
              FIN-001 审批台账（真源：approval_audit_logs，只增不改）
            </p>
            {ledgerNote ? (
              <div
                className={`mb-2 rounded border px-2 py-1 text-xs ${
                  ledgerNote.level === "ok"
                    ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                    : "border-amber-300 bg-amber-100 text-amber-900"
                }`}
              >
                {ledgerNote.text}
              </div>
            ) : null}
            {threadView && threadView.approvals.length > 0 ? (
              <div className="space-y-2">
                {threadView.approvals.map((a) => (
                  <div key={a.approvalId} className="rounded border border-amber-200 bg-white p-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-semibold text-amber-900">{a.approvalId}</span>
                      {a.decided ? (
                        <span className="rounded bg-emerald-100 px-1.5 py-px font-medium text-emerald-700">
                          ✅ 已批准
                        </span>
                      ) : (
                        <span className="rounded bg-amber-100 px-1.5 py-px font-medium text-amber-800">
                          待具名审批人
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-zinc-700">{a.title}</p>
                    {a.decided ? (
                      <p className="mt-1 text-zinc-500">
                        {a.decided.approver} · {fmtTime(a.decided.at)}
                      </p>
                    ) : (
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <select
                          value={approver}
                          onChange={(e) => setApprover(e.target.value)}
                          className="rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs"
                        >
                          {(meta?.approvers ?? [DEFAULT_USER_KEY]).map((name) => (
                            <option key={name} value={name}>
                              {name}
                            </option>
                          ))}
                        </select>
                        <button
                          disabled={ledgerBusy === a.approvalId}
                          onClick={() => void approveInLedger(a.approvalId, a.summary)}
                          className="rounded-lg bg-amber-500 px-2.5 py-1 font-semibold text-white transition-colors hover:bg-amber-600 disabled:opacity-50"
                        >
                          {ledgerBusy === a.approvalId ? "落账中…" : "批准执行"}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-zinc-400">
                暂无挂起审批。左侧发「查一下 CUST-8842 的重复扣款」即可触发 FIN-001 挂起。
              </p>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}

/* ================================================================
 * 三、子组件：双端聊天面板
 * ================================================================ */

type Accent = "indigo" | "sky" | "zinc" | "emerald";

const ACCENT_BTN: Record<Accent, string> = {
  indigo: "bg-indigo-600 hover:bg-indigo-700",
  sky: "bg-sky-600 hover:bg-sky-700",
  zinc: "bg-zinc-800 hover:bg-zinc-900",
  emerald: "bg-emerald-600 hover:bg-emerald-700",
};
const ACCENT_USER: Record<Accent, string> = {
  indigo: "bg-indigo-600 text-white",
  sky: "bg-sky-600 text-white",
  zinc: "bg-zinc-800 text-white",
  emerald: "bg-emerald-600 text-white",
};

interface PaneChatProps {
  side: "left" | "right";
  title: string;
  tabs: { key: string; label: string; accent: Accent }[];
  activeTab: string;
  onTab: (key: string) => void;
  bubbles: Bubble[];
  busy: boolean;
  input: string;
  onInput: (v: string) => void;
  onSend: () => void;
  preset: string;
}

function PaneChat(props: PaneChatProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.bubbles.length]);

  const active = props.tabs.find((t) => t.key === props.activeTab) ?? props.tabs[0];

  return (
    <section className="flex h-[560px] flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2.5">
        <h2 className="text-sm font-bold text-zinc-900">{props.title}</h2>
        <div className="flex gap-1">
          {props.tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => props.onTab(t.key)}
              className={`rounded-lg px-3 py-1 text-sm font-semibold transition-colors ${
                t.key === props.activeTab
                  ? "bg-zinc-900 text-white"
                  : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto bg-zinc-50 px-3 py-3">
        {props.bubbles.length === 0 ? (
          <div className="grid h-full place-items-center px-6 text-center">
            <div>
              <p className="text-sm font-medium text-zinc-500">{active.label}端尚未开始对话</p>
              <p className="mt-1 text-xs text-zinc-400">
                点击下方一键胶囊「{props.preset}」开始联调。
              </p>
            </div>
          </div>
        ) : (
          props.bubbles.map((b, i) => {
            if (b.kind === "user") {
              return (
                <div key={i} className="flex justify-end">
                  <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm ${ACCENT_USER[active.accent]}`}>
                    {b.subject ? <p className="mb-1 text-xs opacity-80">主题：{b.subject}</p> : null}
                    {b.text}
                    <p className="mt-1 text-right text-[10px] opacity-70">
                      {b.senderDisplay} · {fmtTime(b.at)}
                    </p>
                  </div>
                </div>
              );
            }
            if (b.kind === "assistant") {
              return (
                <div key={i} className="max-w-[92%] rounded-2xl border border-zinc-200 bg-white px-3.5 py-2">
                  <span className="mr-2 rounded bg-zinc-900 px-1.5 py-px text-[10px] font-semibold text-white">
                    {b.engineTag}
                  </span>
                  <span className="text-[10px] text-zinc-400">{fmtTime(b.at)}</span>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-zinc-700">{b.engineText}</p>
                </div>
              );
            }
            if (b.kind === "notice") {
              return (
                <div
                  key={i}
                  className={`rounded-lg border px-3 py-1.5 text-xs ${
                    b.level === "warn"
                      ? "border-amber-300 bg-amber-50 text-amber-900"
                      : b.level === "fallback"
                        ? "border-sky-300 bg-sky-50 text-sky-800"
                        : "border-zinc-200 bg-white text-zinc-600"
                  }`}
                >
                  {b.text}
                </div>
              );
            }
            return <ReceiptView key={i} receipt={b.receipt} />;
          })
        )}
      </div>

      <div className="border-t border-zinc-200 px-3 py-2.5">
        <button
          onClick={() => props.onInput(props.preset)}
          className="mb-2 rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100"
        >
          一键提问：{props.preset}
        </button>
        <div className="flex gap-2">
          <input
            value={props.input}
            onChange={(e) => props.onInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !props.busy) props.onSend();
            }}
            placeholder={`以 ${active.label} 身份发消息…`}
            className="min-w-0 flex-1 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm outline-none focus:border-zinc-500"
          />
          <button
            disabled={props.busy || !props.input.trim()}
            onClick={props.onSend}
            className={`shrink-0 rounded-lg px-4 py-1.5 text-sm font-semibold text-white transition-colors disabled:opacity-50 ${ACCENT_BTN[active.accent]}`}
          >
            {props.busy ? "网关处理中…" : "发送"}
          </button>
        </div>
      </div>
    </section>
  );
}

/* ================================================================
 * 四、子组件：网关确定性小票
 * ================================================================ */

function ReceiptView({ receipt }: { receipt: ChannelReceipt }) {
  if (receipt.kind === "ticket_inspect") {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs">
        <p className="mb-1.5 font-semibold text-zinc-800">工单勘察小票 · 绿区只读快照（老 ERP 仿真）</p>
        <div className="space-y-1.5">
          {receipt.tickets.map((t) => (
            <div key={t.ticketId} className="rounded border border-zinc-100 bg-zinc-50 px-2 py-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="rounded bg-zinc-200 px-1.5 py-px font-mono font-semibold text-zinc-700">
                  {t.ticketId}
                </span>
                <span className="text-zinc-700">{t.title}</span>
                {t.fin001Triggered ? (
                  <span className="rounded bg-amber-100 px-1.5 py-px font-semibold text-amber-800">
                    FIN-001 强制人工审批
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-zinc-500">
                {t.department} · 单笔 ¥{t.amountYuan.toLocaleString("zh-CN")} · 状态 {t.status}
              </p>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (receipt.kind === "fin001_approval") {
    return (
      <div className="rounded-lg border border-amber-400 bg-amber-50 px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded bg-amber-500 px-1.5 py-px font-semibold text-white">FIN-001</span>
          <span className="font-semibold text-amber-900">{receipt.isNew ? "已挂起新审批单" : "该工单已有挂起审批单（复用原单）"}</span>
        </div>
        <p className="mt-1 font-mono font-semibold text-amber-900">{receipt.approvalId}</p>
        <p className="mt-0.5 text-amber-900">{receipt.title}</p>
        <p className="mt-1 text-amber-700">
          等待具名审批人（林总 / 王主管 / 陈总）签字放行 · 仅人工审批，绝无自动打款。
        </p>
      </div>
    );
  }
  if (receipt.kind === "approval_status") {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs">
        <p className="mb-1.5 font-semibold text-zinc-800">审批状态小票 · 真源 approval_audit_logs（只增不改）</p>
        <div className="space-y-1">
          {receipt.lines.map((l) => (
            <div key={l.approvalId} className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-zinc-600">{l.approvalId}</span>
              {l.status === "approved" ? (
                <span className="rounded bg-emerald-100 px-1.5 py-px font-semibold text-emerald-700">
                  ✅ 已批准 · {l.approver} · {l.decidedAt ? fmtTime(l.decidedAt) : ""}
                </span>
              ) : (
                <span className="rounded bg-amber-100 px-1.5 py-px font-semibold text-amber-800">
                  ⏳ 待具名审批人签字
                </span>
              )}
            </div>
          ))}
        </div>
        {receipt.degradedNote ? (
          <p className="mt-1.5 rounded bg-zinc-100 px-2 py-1 text-zinc-600">{receipt.degradedNote}</p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 px-3 py-2 text-xs">
      <p className="mb-1 font-semibold text-zinc-700">跨端同步小票 · 同一线程的事实清单</p>
      <p className="font-mono text-zinc-500">{receipt.threadId}</p>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <span className="text-zinc-600">统一身份 {receipt.userKey}</span>
        <span className="text-zinc-300">|</span>
        {receipt.channels.map((c) => (
          <span key={`${c.channel}-${c.platform ?? ""}`} className="rounded bg-white px-1.5 py-px text-zinc-600 ring-1 ring-zinc-200">
            {c.platform === "wecom" ? "企微" : c.platform === "feishu" ? "飞书" : c.channel === "email" ? "邮件" : c.channel === "h5" ? "H5" : "Web"}
            <span className="ml-1 text-zinc-400">{fmtTime(c.lastAt)}</span>
          </span>
        ))}
      </div>
      <p className="mt-1 text-zinc-600">
        挂起审批 <span className="font-semibold text-amber-800">{receipt.pendingCount}</span> 笔 ·
        已批准 <span className="font-semibold text-emerald-700">{receipt.approvedCount}</span> 笔 ——
        4 端共享同一线程，此清单即同步证据。
      </p>
    </div>
  );
}
