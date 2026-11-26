"use client";

/**
 * /chat —— 全栈透明对话工作台（Day 6 双模型引擎 + Day 9 三层企业记忆）
 * 溯源：04 号文档三色权限边界；AGENTS.md 业务红线（FIN-001 / 严禁自动打款）。
 * 透明度：工具链每一步、上下文窗口占用、AI 记住的每一条事实全部实时可见；
 * 可控性：「我的记忆」面板可随时查看 / 编辑 / 删除任意一条 AI 记住的事实；
 * 安全性：批准动作必须具名审批人，写入 approval_audit_logs（只增不改），
 *        本页面绝不出现「AI 自动打款」类按钮。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { buildInjectPreview, selectInjectableFacts } from "@/lib/memory";
import type { ChatSseEvent } from "@/lib/chat-engine";

/* ---------------- 类型 ---------------- */

interface ToolCardState {
  tool: string;
  zone: "green" | "yellow";
  label: string;
  status: "running" | "done";
  summary: string;
  raw: unknown;
}

interface DryRunState {
  approvalId: string;
  tool: string;
  title: string;
  summary: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  draft?: Record<string, unknown>;
  state: "pending" | "approved" | "cancelled";
  approvedAt?: string;
  approver?: string;
}

interface UsageInfo {
  providerId: string;
  model: string;
  mode: string;
  ttftMs: number;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  usdCost: number;
  wasFallback: boolean;
}

/** Day 9：上下文占用仪表盘数据（来自 context_notice 事件） */
interface ContextInfo {
  summarizedRounds: number;
  originalTokens: number;
  compressedTokens: number;
  savedPercent: number;
  contextTokens: number;
  contextBudget: number;
}

/** Day 9：情景记忆行（memory_episodes） */
interface EpisodeRow {
  id: number;
  sessionId: string;
  episodeType: string;
  content: string;
  ticketRefs: string;
  /** 片段开关：false=已停用，AI 不再参考 */
  enabled: boolean;
  createdAt: string;
}

/** Day 9：语义记忆行（user_preferences） */
interface PreferenceRow {
  id: number;
  userKey: string;
  displayName: string;
  department: string;
  style: string;
  facts: string[];
  /** 被停用的事实（facts 子集） */
  disabledFacts: string[];
  updatedAt: string;
}

interface AssistantBlock {
  id: string;
  question: string;
  toolCards: ToolCardState[];
  dryRuns: DryRunState[];
  text: string;
  usage: UsageInfo | null;
  fallback: { from: string; to: string; reason: string } | null;
  done: boolean;
}

type ModelSelector = "auto" | "openai" | "anthropic";
type LeftTab = "quick" | "memory";

/** 三个部门的一键提问胶囊（星辰集团真实场景） */
const PRESET_QUESTIONS = [
  {
    tag: "运营",
    label: "查超期物流",
    question: "查一下本周超期的跨境物流单，按仓库分组给出处理建议。",
  },
  {
    tag: "财务",
    label: "查 CUST-8842 重复扣款",
    question: "查 CUST-8842 重复扣款 ¥52,800 的处理进度和合规建议。",
  },
  {
    tag: "客服",
    label: "查投诉约评审会",
    question: "查今天的客诉投诉，需要评审会的帮我约一个时间。",
  },
] as const;

/* ---------------- Diff 渲染子组件（必选参数，收窄 undefined） ---------------- */

function DiffRows({
  before,
  after,
}: {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}): React.ReactElement {
  const changedKeys = Object.keys(after).filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
  return (
    <div className="mb-2 space-y-1 font-mono text-xs">
      {changedKeys.map((k) => (
        <p key={k} className="text-zinc-600">
          <span className="text-zinc-400">{k}：</span>
          {JSON.stringify(before[k])}
          <span className="mx-1 text-amber-600">→</span>
          <span className="font-semibold text-amber-800">{JSON.stringify(after[k])}</span>
        </p>
      ))}
    </div>
  );
}

/* ---------------- Day 9：我的记忆面板（查看 / 编辑 / 删除） ---------------- */

function MemoryPanel({
  userKey,
  episodes,
  preference,
  reload,
  busy,
}: {
  userKey: string;
  episodes: EpisodeRow[];
  preference: PreferenceRow | null;
  reload: () => Promise<void>;
  busy: boolean;
}): React.ReactElement {
  // 语义记忆编辑草稿（preference 变化时同步）
  const [nameDraft, setNameDraft] = useState(preference?.displayName ?? "");
  const [deptDraft, setDeptDraft] = useState(preference?.department ?? "");
  const [styleDraft, setStyleDraft] = useState(preference?.style ?? "");
  const [factsDraft, setFactsDraft] = useState<string[]>(preference?.facts ?? []);
  const [disabledFactsDraft, setDisabledFactsDraft] = useState<string[]>(
    preference?.disabledFacts ?? [],
  );
  const [newFact, setNewFact] = useState("");
  const [editingFactIdx, setEditingFactIdx] = useState<number | null>(null);
  const [factEditDraft, setFactEditDraft] = useState("");
  // 情景记忆编辑态
  const [editingEpId, setEditingEpId] = useState<number | null>(null);
  const [epEditDraft, setEpEditDraft] = useState("");
  const [panelMsg, setPanelMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setNameDraft(preference?.displayName ?? "");
    setDeptDraft(preference?.department ?? "");
    setStyleDraft(preference?.style ?? "");
    setFactsDraft(preference?.facts ?? []);
    setDisabledFactsDraft(preference?.disabledFacts ?? []);
  }, [preference]);

  const flash = (msg: string): void => {
    setPanelMsg(msg);
    window.setTimeout(() => setPanelMsg(null), 3000);
  };

  /** 保存语义记忆（称呼 / 部门 / 风格 / 事实清单 / 停用清单） */
  const savePreference = async (): Promise<void> => {
    setSaving(true);
    try {
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "preference",
          userKey,
          displayName: nameDraft,
          department: deptDraft,
          style: styleDraft,
          facts: factsDraft,
          disabledFacts: disabledFactsDraft.filter((f) => factsDraft.includes(f)),
        }),
      });
      const data: unknown = await res.json();
      if (!res.ok) {
        throw new Error((data as { error?: string }).error ?? "保存失败");
      }
      flash("✅ 语义记忆已保存，下轮对话生效");
      await reload();
    } catch (err: unknown) {
      flash(`保存失败：${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setSaving(false);
    }
  };

  /** 切换事实片段：启用 ↔ 停用（立即持久化） */
  const toggleFact = async (idx: number): Promise<void> => {
    const fact = factsDraft[idx];
    if (fact === undefined) return;
    const nextFacts = factsDraft;
    const nextDisabled = disabledFactsDraft.includes(fact)
      ? disabledFactsDraft.filter((f) => f !== fact)
      : [...disabledFactsDraft, fact];
    setDisabledFactsDraft(nextDisabled);
    setSaving(true);
    try {
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "preference",
          userKey,
          displayName: nameDraft,
          department: deptDraft,
          style: styleDraft,
          facts: nextFacts,
          disabledFacts: nextDisabled,
        }),
      });
      const data: unknown = await res.json();
      if (!res.ok) {
        throw new Error((data as { error?: string }).error ?? "切换失败");
      }
      flash(
        disabledFactsDraft.includes(fact)
          ? "✅ 已启用该事实，AI 下轮恢复参考"
          : "⏸️ 已停用该事实，AI 下轮不再参考",
      );
      await reload();
    } catch (err: unknown) {
      flash(`切换失败：${err instanceof Error ? err.message : "未知错误"}`);
      await reload();
    } finally {
      setSaving(false);
    }
  };

  /** 切换情景记忆片段：启用 ↔ 停用（立即持久化） */
  const toggleEpisode = async (id: number, next: boolean): Promise<void> => {
    setSaving(true);
    try {
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "episode", id, content: "", enabled: next }),
      });
      const data: unknown = await res.json();
      if (!res.ok) {
        throw new Error((data as { error?: string }).error ?? "切换失败");
      }
      flash(next ? "✅ 已启用该情景片段" : "⏸️ 已停用该情景片段，AI 不再参考");
      await reload();
    } catch (err: unknown) {
      flash(`切换失败：${err instanceof Error ? err.message : "未知错误"}`);
      await reload();
    } finally {
      setSaving(false);
    }
  };

  /** 删除语义记忆（整份遗忘） */
  const deletePreference = async (): Promise<void> => {
    if (preference === null) return;
    if (!window.confirm("确定让 AI 忘掉你的全部偏好（称呼/部门/风格/事实清单）吗？")) return;
    setSaving(true);
    try {
      const res = await fetch(
        `/api/memory?kind=preference&id=${String(preference.id)}`,
        { method: "DELETE" },
      );
      const data: unknown = await res.json();
      if (!res.ok) {
        throw new Error((data as { error?: string }).error ?? "删除失败");
      }
      flash("🗑️ 语义记忆已删除");
      await reload();
    } catch (err: unknown) {
      flash(`删除失败：${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setSaving(false);
    }
  };

  /** 编辑情景记忆 */
  const saveEpisode = async (id: number): Promise<void> => {
    setSaving(true);
    try {
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "episode", id, content: epEditDraft }),
      });
      const data: unknown = await res.json();
      if (!res.ok) {
        throw new Error((data as { error?: string }).error ?? "保存失败");
      }
      setEditingEpId(null);
      flash("✅ 情景记忆已更新");
      await reload();
    } catch (err: unknown) {
      flash(`保存失败：${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setSaving(false);
    }
  };

  /** 删除情景记忆 */
  const deleteEpisode = async (id: number): Promise<void> => {
    if (!window.confirm("确定删除这条 AI 记住的工单结论吗？")) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/memory?kind=episode&id=${String(id)}`, {
        method: "DELETE",
      });
      const data: unknown = await res.json();
      if (!res.ok) {
        throw new Error((data as { error?: string }).error ?? "删除失败");
      }
      flash("🗑️ 情景记忆已删除");
      await reload();
    } catch (err: unknown) {
      flash(`删除失败：${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setSaving(false);
    }
  };

  const disabled = busy || saving;
  const activeFacts = selectInjectableFacts(factsDraft, disabledFactsDraft);
  const preview = buildInjectPreview(factsDraft, disabledFactsDraft, episodes);

  return (
    <div className="space-y-3">
      {panelMsg && (
        <p className="rounded-lg border border-sky-200 bg-sky-50 px-2 py-1.5 text-xs text-sky-800">
          {panelMsg}
        </p>
      )}

      {/* 片段注入预览：下一轮对话将带进上下文的记忆数量 */}
      <div className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
        🔌 注入预览：下轮对话将参考{" "}
        <span className="font-semibold">
          {String(preview.activeFacts)} 条事实 · {String(preview.activeEpisodes)}/
          {String(preview.totalEpisodes)} 条情景
        </span>
        （停用的片段不进入上下文）
      </div>

      {/* ② 语义记忆：部门偏好与称呼风格 */}
      <div className="rounded-xl border border-zinc-200 bg-white p-3">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-semibold text-zinc-700">🧠 语义记忆（偏好）</p>
          {preference && (
            <button
              onClick={() => void deletePreference()}
              disabled={disabled}
              className="text-xs text-red-500 hover:underline disabled:opacity-40"
            >
              全部遗忘
            </button>
          )}
        </div>
        <div className="space-y-1.5">
          <input
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            placeholder="称呼（如：王经理）"
            className="w-full rounded-lg border border-zinc-300 px-2 py-1 text-xs"
          />
          <input
            value={deptDraft}
            onChange={(e) => setDeptDraft(e.target.value)}
            placeholder="常关注部门（如：财务部）"
            className="w-full rounded-lg border border-zinc-300 px-2 py-1 text-xs"
          />
          <input
            value={styleDraft}
            onChange={(e) => setStyleDraft(e.target.value)}
            placeholder="称呼风格（如：正式敬语）"
            className="w-full rounded-lg border border-zinc-300 px-2 py-1 text-xs"
          />
        </div>

        {/* 事实清单：逐条切换 / 编辑 / 删除 / 新增 */}
        <p className="mt-2 mb-1 text-xs font-semibold text-zinc-500">
          已记住的事实（{String(factsDraft.length)} 条 · {String(activeFacts.length)} 条启用中）
        </p>
        <div className="space-y-1">
          {factsDraft.map((fact, idx) => {
            const factOff = disabledFactsDraft.includes(fact);
            return (
              <div
                key={`${fact}-${String(idx)}`}
                className={`flex items-start gap-1 rounded-lg px-2 py-1 ${
                  factOff ? "bg-zinc-100 opacity-60" : "bg-zinc-50"
                }`}
              >
                {editingFactIdx === idx ? (
                  <>
                    <input
                      value={factEditDraft}
                      onChange={(e) => setFactEditDraft(e.target.value)}
                      className="min-w-0 flex-1 rounded border border-zinc-300 px-1 py-0.5 text-xs"
                    />
                    <button
                      onClick={() => {
                        const next = [...factsDraft];
                        next[idx] = factEditDraft.trim();
                        setFactsDraft(next.filter((f) => f.length > 0));
                        setEditingFactIdx(null);
                      }}
                      className="text-xs font-semibold text-emerald-700 hover:underline"
                    >
                      存
                    </button>
                    <button
                      onClick={() => setEditingFactIdx(null)}
                      className="text-xs text-zinc-400 hover:underline"
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <span
                      className={`min-w-0 flex-1 break-all text-xs ${
                        factOff
                          ? "text-zinc-400 line-through"
                          : "text-zinc-700"
                      }`}
                    >
                      {fact}
                    </span>
                    <button
                      onClick={() => void toggleFact(idx)}
                      disabled={disabled}
                      className={`text-xs font-semibold hover:underline disabled:opacity-40 ${
                        factOff ? "text-emerald-600" : "text-amber-600"
                      }`}
                    >
                      {factOff ? "启用" : "停用"}
                    </button>
                    <button
                      onClick={() => {
                        setEditingFactIdx(idx);
                        setFactEditDraft(fact);
                      }}
                      disabled={disabled}
                      className="text-xs text-sky-600 hover:underline disabled:opacity-40"
                    >
                      改
                    </button>
                    <button
                      onClick={() => {
                        setFactsDraft(factsDraft.filter((_, i) => i !== idx));
                        setDisabledFactsDraft(disabledFactsDraft.filter((f) => f !== fact));
                      }}
                      disabled={disabled}
                      className="text-xs text-red-500 hover:underline disabled:opacity-40"
                    >
                      删
                    </button>
                  </>
                )}
              </div>
            );
          })}
          {factsDraft.length === 0 && (
            <p className="text-xs text-zinc-400">暂无事实；聊几轮业务后 AI 会自动学习。</p>
          )}
        </div>
        <div className="mt-1.5 flex gap-1">
          <input
            value={newFact}
            onChange={(e) => setNewFact(e.target.value)}
            placeholder="手动加一条事实…"
            className="min-w-0 flex-1 rounded-lg border border-zinc-300 px-2 py-1 text-xs"
          />
          <button
            onClick={() => {
              const f = newFact.trim();
              if (f.length === 0 || f.length > 200) return;
              setFactsDraft([...factsDraft, f]);
              setNewFact("");
            }}
            disabled={disabled}
            className="rounded-lg border border-zinc-300 px-2 text-xs text-zinc-600 hover:border-zinc-500 disabled:opacity-40"
          >
            添加
          </button>
        </div>
        <button
          onClick={() => void savePreference()}
          disabled={disabled}
          className="mt-2 w-full rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-700 disabled:opacity-40"
        >
          保存语义记忆
        </button>
      </div>

      {/* ② 情景记忆：跨会话工单结论 */}
      <div className="rounded-xl border border-zinc-200 bg-white p-3">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-semibold text-zinc-700">📋 情景记忆（{String(episodes.length)} 条）</p>
          <button
            onClick={() => void reload()}
            disabled={disabled}
            className="text-xs text-sky-600 hover:underline disabled:opacity-40"
          >
            刷新
          </button>
        </div>
        <div className="max-h-72 space-y-2 overflow-y-auto">
          {episodes.map((ep) => (
            <div
              key={String(ep.id)}
              className={`rounded-lg border p-2 ${
                ep.enabled ? "border-zinc-200" : "border-zinc-200 bg-zinc-100 opacity-60"
              }`}
            >
              {editingEpId === ep.id ? (
                <>
                  <textarea
                    value={epEditDraft}
                    onChange={(e) => setEpEditDraft(e.target.value)}
                    rows={3}
                    className="w-full rounded border border-zinc-300 px-1.5 py-1 text-xs"
                  />
                  <div className="mt-1 flex gap-2">
                    <button
                      onClick={() => void saveEpisode(ep.id)}
                      disabled={disabled}
                      className="rounded bg-emerald-600 px-2 py-0.5 text-xs font-semibold text-white disabled:opacity-40"
                    >
                      保存
                    </button>
                    <button
                      onClick={() => setEditingEpId(null)}
                      className="rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600"
                    >
                      取消
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <details>
                    <summary className="cursor-pointer text-xs leading-5 text-zinc-700">
                      {ep.enabled ? "" : "⏸️ "}
                      {ep.content.length > 46 ? `${ep.content.slice(0, 46)}…` : ep.content}
                    </summary>
                    <p className="mt-1 text-xs leading-5 text-zinc-600">{ep.content}</p>
                    {ep.ticketRefs && (
                      <p className="mt-1 font-mono text-[10px] text-zinc-400">
                        关联单号：{ep.ticketRefs}
                      </p>
                    )}
                  </details>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-[10px] text-zinc-400">
                      {new Date(ep.createdAt).toLocaleString("zh-CN", { hour12: false })}
                    </span>
                    <button
                      onClick={() => void toggleEpisode(ep.id, !ep.enabled)}
                      disabled={disabled}
                      className={`ml-auto text-xs font-semibold hover:underline disabled:opacity-40 ${
                        ep.enabled ? "text-amber-600" : "text-emerald-600"
                      }`}
                    >
                      {ep.enabled ? "停用" : "启用"}
                    </button>
                    <button
                      onClick={() => {
                        setEditingEpId(ep.id);
                        setEpEditDraft(ep.content);
                      }}
                      disabled={disabled}
                      className="text-xs text-sky-600 hover:underline disabled:opacity-40"
                    >
                      编辑
                    </button>
                    <button
                      onClick={() => void deleteEpisode(ep.id)}
                      disabled={disabled}
                      className="text-xs text-red-500 hover:underline disabled:opacity-40"
                    >
                      删除
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
          {episodes.length === 0 && (
            <p className="text-xs text-zinc-400">
              暂无情景记忆；提问命中工单号（如 CUST-8842）后，关键结论会自动存到这里。
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- 主组件 ---------------- */

export default function ChatPage() {
  const [selector, setSelector] = useState<ModelSelector>("auto");
  const [simulateOutage, setSimulateOutage] = useState(false);
  const [approver, setApprover] = useState("王主管");
  const [input, setInput] = useState("");
  const [blocks, setBlocks] = useState<AssistantBlock[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [globalFallback, setGlobalFallback] = useState<string | null>(null);
  const [lastUsageBadge, setLastUsageBadge] = useState<string | null>(null);
  // Day 9 状态
  const [leftTab, setLeftTab] = useState<LeftTab>("quick");
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeRow[]>([]);
  const [preference, setPreference] = useState<PreferenceRow | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string>("");
  /** Day 9 工作记忆：已完成的历史轮次（随每轮对话累积） */
  const historyRef = useRef<{ user: string; assistant: string }[]>([]);

  const userKey = approver.trim() || "demo-林总";

  // 会话 ID（不含 PII，用于记账与埋点归因）
  useEffect(() => {
    sessionIdRef.current = crypto.randomUUID();
  }, []);

  /** 拉取记忆面板数据（情景 + 语义） */
  const loadMemory = useCallback(async (): Promise<void> => {
    setMemoryLoading(true);
    try {
      const res = await fetch(`/api/memory?userKey=${encodeURIComponent(userKey)}`);
      const data: unknown = await res.json();
      if (!res.ok) {
        throw new Error((data as { error?: string }).error ?? "记忆读取失败");
      }
      const body = data as { episodes: EpisodeRow[]; preference: PreferenceRow | null };
      setEpisodes(Array.isArray(body.episodes) ? body.episodes : []);
      setPreference(body.preference ?? null);
    } catch {
      // 记忆读取失败不阻塞对话主流程：面板保持现状
    } finally {
      setMemoryLoading(false);
    }
  }, [userKey]);

  // 切到记忆页签 / 用户标识变化时拉取
  useEffect(() => {
    if (leftTab === "memory") {
      void loadMemory();
    }
  }, [leftTab, loadMemory]);

  // 自动滚动：对话区有更新时贴底（仅流式期间）
  useEffect(() => {
    if (streaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  });

  /** 发送问题：fetch SSE 流式解析（支持「停止生成」中断） */
  const ask = useCallback(
    async (question: string): Promise<void> => {
      const q = question.trim();
      if (q.length === 0 || streaming) return;

      const blockId = crypto.randomUUID();
      const blank: AssistantBlock = {
        id: blockId,
        question: q,
        toolCards: [],
        dryRuns: [],
        text: "",
        usage: null,
        fallback: null,
        done: false,
      };
      setBlocks((prev) => [...prev, blank]);
      setInput("");
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      const patch = (fn: (b: AssistantBlock) => AssistantBlock): void => {
        setBlocks((prev) => prev.map((b) => (b.id === blockId ? fn(b) : b)));
      };

      let replyAccum = ""; // Day 9：本轮回复累积，结束后写入工作记忆
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            question: q,
            primary: selector,
            simulateOutage,
            sessionId: sessionIdRef.current,
            userKey,
            history: historyRef.current,
          }),
        });
        if (!res.ok || !res.body) {
          const errText = await res.text().catch(() => "");
          throw new Error(errText || `接口返回 ${res.status}`);
        }

        // SSE 解析：data: {...}\n\n
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finished = false;
        while (!finished) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            let evt: ChatSseEvent;
            try {
              evt = JSON.parse(line.slice(5).trim()) as ChatSseEvent;
            } catch {
              continue;
            }

            switch (evt.type) {
              case "context_notice": {
                // Day 9：顶部上下文占用仪表盘
                setContextInfo({
                  summarizedRounds: evt.summarizedRounds,
                  originalTokens: evt.originalTokens,
                  compressedTokens: evt.compressedTokens,
                  savedPercent: evt.savedPercent,
                  contextTokens: evt.contextTokens,
                  contextBudget: evt.contextBudget,
                });
                break;
              }
              case "tool_start": {
                const ev = evt; // const 收窄：闭包内保持事件类型
                patch((b) => ({
                  ...b,
                  toolCards: [
                    ...b.toolCards,
                    {
                      tool: ev.tool,
                      zone: ev.zone,
                      label: ev.label,
                      status: "running",
                      summary: "",
                      raw: null,
                    },
                  ],
                }));
                break;
              }
              case "tool_result": {
                const ev = evt;
                patch((b) => ({
                  ...b,
                  toolCards: b.toolCards.map((c) =>
                    c.tool === ev.tool && c.status === "running"
                      ? { ...c, status: "done", summary: ev.summary, raw: ev.raw }
                      : c,
                  ),
                }));
                break;
              }
              case "dry_run_required": {
                const ev = evt;
                patch((b) => ({
                  ...b,
                  dryRuns: [
                    ...b.dryRuns,
                    {
                      approvalId: ev.approvalId,
                      tool: ev.tool,
                      title: ev.title,
                      summary: ev.summary,
                      before: ev.before,
                      after: ev.after,
                      draft: ev.draft,
                      state: "pending",
                    },
                  ],
                }));
                break;
              }
              case "fallback_notice": {
                const ev = evt;
                patch((b) => ({
                  ...b,
                  fallback: { from: ev.from, to: ev.to, reason: ev.reason },
                }));
                setGlobalFallback(
                  `主厂商故障（${ev.reason}），已自动切换到备用厂商 ${ev.to} 继续服务。`,
                );
                break;
              }
              case "text_delta": {
                const ev = evt;
                replyAccum += ev.text;
                patch((b) => ({ ...b, text: b.text + ev.text }));
                break;
              }
              case "usage_done": {
                const ev = evt;
                const usage: UsageInfo = {
                  providerId: ev.providerId,
                  model: ev.model,
                  mode: ev.mode,
                  ttftMs: ev.ttftMs,
                  totalMs: ev.totalMs,
                  inputTokens: ev.inputTokens,
                  outputTokens: ev.outputTokens,
                  usdCost: ev.usdCost,
                  wasFallback: ev.wasFallback,
                };
                patch((b) => ({ ...b, usage, done: true }));
                setLastUsageBadge(
                  `${ev.providerId} · ${ev.model} · ` +
                    `TTFT ${ev.ttftMs}ms · Token ${ev.inputTokens}/${ev.outputTokens} · ` +
                    `$${ev.usdCost.toFixed(6)}` +
                    (ev.wasFallback ? " · 已容灾切换" : ""),
                );
                finished = true;
                break;
              }
            }
          }
        }
        patch((b) => ({ ...b, done: true }));
        // Day 9：本轮完成 → 累积进工作记忆历史（供下轮滑窗摘要）
        if (replyAccum.trim().length > 0) {
          historyRef.current = [...historyRef.current, { user: q, assistant: replyAccum }];
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") {
          patch((b) => ({
            ...b,
            done: true,
            text: b.text + "\n（已按「停止生成」中断本次回复）",
          }));
        } else {
          patch((b) => ({
            ...b,
            done: true,
            text:
              b.text +
              `\n调用失败：${err instanceof Error ? err.message : "未知错误"}`,
          }));
        }
        // 中断/失败：已收到的部分回复也计入工作记忆（保持真实）
        if (replyAccum.trim().length > 0) {
          historyRef.current = [...historyRef.current, { user: q, assistant: replyAccum }];
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [selector, simulateOutage, streaming, userKey],
  );

  /** 停止生成：直接中断 SSE 连接（费用已在服务端 after() 兜底落账） */
  const stop = (): void => {
    abortRef.current?.abort();
  };

  /** 批准执行：具名审批落库 + 埋点，成功后卡片变翠绿并锁死 */
  const approveDryRun = async (
    blockId: string,
    approvalId: string,
    tool: string,
    summary: string,
  ): Promise<void> => {
    const patchDryRun = (fn: (d: DryRunState) => DryRunState): void => {
      setBlocks((prev) =>
        prev.map((b) =>
          b.id === blockId
            ? { ...b, dryRuns: b.dryRuns.map((d) => (d.approvalId === approvalId ? fn(d) : d)) }
            : b,
        ),
      );
    };
    try {
      const res = await fetch("/api/chat/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approvalId,
          tool,
          summary,
          approver,
          sessionId: sessionIdRef.current,
        }),
      });
      const data: unknown = await res.json();
      if (!res.ok) {
        const err = data as { error?: string; approvedAt?: string };
        if (res.status === 409 && err.approvedAt) {
          // 已被批准过（幂等保护）：本地状态同样收敛为已批准
          patchDryRun((d) => ({
            ...d,
            state: "approved",
            approvedAt: err.approvedAt,
            approver,
          }));
          return;
        }
        throw new Error(err.error ?? "批准失败");
      }
      const body = data as { approvedAt: string };
      patchDryRun((d) => ({
        ...d,
        state: "approved",
        approvedAt: body.approvedAt,
        approver,
      }));
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "批准失败");
    }
  };

  const cancelDryRun = (blockId: string, approvalId: string): void => {
    setBlocks((prev) =>
      prev.map((b) =>
        b.id === blockId
          ? {
              ...b,
              dryRuns: b.dryRuns.map((d) =>
                d.approvalId === approvalId ? { ...d, state: "cancelled" } : d,
              ),
            }
          : b,
      ),
    );
  };

  /* 上下文占用百分比（仪表盘口径，封顶 100%） */
  const contextPct =
    contextInfo && contextInfo.contextBudget > 0
      ? Math.min(
          100,
          Math.round((contextInfo.contextTokens / contextInfo.contextBudget) * 100),
        )
      : 0;

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col bg-zinc-50">
      {/* 顶部：模型选择器 + 故障演习 + 上下文占用仪表盘 + 容灾黄条 */}
      <div className="border-b border-zinc-200 bg-white px-4 py-3 sm:px-6">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-3">
          <span className="text-sm font-semibold text-zinc-700">引擎：</span>
          <div className="flex rounded-lg border border-zinc-300 p-0.5">
            {(
              [
                { key: "auto", label: "自动容灾" },
                { key: "openai", label: "OpenAI" },
                { key: "anthropic", label: "Anthropic" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.key}
                onClick={() => setSelector(opt.key)}
                disabled={streaming}
                className={`rounded-md px-3 py-1 text-sm font-medium transition-colors disabled:opacity-50 ${
                  selector === opt.key
                    ? "bg-zinc-900 text-white"
                    : "text-zinc-600 hover:text-zinc-900"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-sm text-zinc-600">
            <input
              type="checkbox"
              checked={simulateOutage}
              onChange={(e) => setSimulateOutage(e.target.checked)}
              disabled={streaming}
              className="h-4 w-4"
            />
            故障演习（注入 429）
          </label>
          <label className="ml-auto flex items-center gap-2 text-sm text-zinc-600">
            具名审批人
            <input
              value={approver}
              onChange={(e) => setApprover(e.target.value)}
              className="w-28 rounded-lg border border-zinc-300 px-2 py-1 text-sm"
            />
          </label>
        </div>

        {/* Day 9：上下文窗口占用仪表盘 */}
        <div className="mx-auto mt-3 w-full max-w-6xl">
          {contextInfo === null ? (
            <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-400">
              📊 上下文占用仪表盘：发送第一条消息后，这里会实时显示窗口占用与三层记忆压缩情况。
            </div>
          ) : (
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-semibold text-zinc-700">📊 上下文占用</span>
                <span className="font-mono text-zinc-600">
                  {String(contextInfo.contextTokens)} / {String(contextInfo.contextBudget)} tokens
                  （{String(contextPct)}%）
                </span>
                {contextInfo.summarizedRounds > 0 && (
                  <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-semibold text-emerald-700">
                    已压缩 {String(contextInfo.summarizedRounds)} 轮 · 节省 {String(contextInfo.savedPercent)}% Token
                  </span>
                )}
                <span className="text-zinc-400">
                  最近 6 轮保留原文，更早轮次自动滑动摘要
                </span>
              </div>
              <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-zinc-200">
                <div
                  className={`h-full rounded-full transition-all ${
                    contextPct >= 80
                      ? "bg-red-500"
                      : contextPct >= 50
                        ? "bg-amber-500"
                        : "bg-emerald-500"
                  }`}
                  style={{ width: `${String(Math.max(contextPct, 2))}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {globalFallback && (
          <div className="mx-auto mt-3 w-full max-w-6xl rounded-lg border border-amber-400 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900">
            ⚠️ 降级提示：{globalFallback}
          </div>
        )}
      </div>

      {/* 主体：左侧（快捷提问 / 我的记忆） + 对话区 */}
      <div className="mx-auto flex w-full max-w-6xl flex-1 gap-4 overflow-hidden px-4 py-4 sm:px-6">
        <aside className="hidden w-72 shrink-0 flex-col overflow-y-auto md:block">
          {/* 页签切换 */}
          <div className="mb-3 flex rounded-lg border border-zinc-300 bg-white p-0.5">
            {(
              [
                { key: "quick", label: "⚡ 快捷提问" },
                { key: "memory", label: "🧠 我的记忆" },
              ] as const
            ).map((tab) => (
              <button
                key={tab.key}
                onClick={() => setLeftTab(tab.key)}
                className={`flex-1 rounded-md px-2 py-1.5 text-xs font-semibold transition-colors ${
                  leftTab === tab.key
                    ? "bg-zinc-900 text-white"
                    : "text-zinc-600 hover:text-zinc-900"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {leftTab === "quick" ? (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-zinc-400">星辰集团 · 一键提问</p>
              {PRESET_QUESTIONS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => void ask(p.question)}
                  disabled={streaming}
                  className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-left text-sm transition-colors hover:border-zinc-500 disabled:opacity-50"
                >
                  <span className="mr-1.5 rounded-md bg-zinc-100 px-1.5 py-0.5 text-xs font-semibold text-zinc-600">
                    {p.tag}
                  </span>
                  {p.label}
                </button>
              ))}
              <p className="mt-4 rounded-xl border border-zinc-200 bg-white p-3 text-xs leading-5 text-zinc-500">
                🔒 绿区工具只读快照；黄区写操作只出
                <span className="font-semibold text-amber-700"> Dry-Run 草稿</span>
                ，批准后才会转正式留痕。全站无自动打款。
              </p>
            </div>
          ) : (
            <MemoryPanel
              userKey={userKey}
              episodes={episodes}
              preference={preference}
              reload={loadMemory}
              busy={memoryLoading}
            />
          )}
        </aside>

        {/* 右侧：对话区 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            className="flex-1 space-y-6 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-4"
          >
            {blocks.length === 0 && (
              <div className="grid h-full place-items-center text-center text-sm text-zinc-400">
                <div>
                  <p className="text-4xl">💬</p>
                  <p className="mt-3">
                    问点什么吧：左侧胶囊一键查询，或直接在下方输入。
                  </p>
                  <p className="mt-1 text-xs">
                    三层记忆已就绪：最近 6 轮原文保留，更早轮次自动压缩成摘要。
                  </p>
                </div>
              </div>
            )}

            {blocks.map((b) => (
              <div key={b.id} className="space-y-3">
                {/* 用户提问 */}
                <div className="flex justify-end">
                  <p className="max-w-[80%] rounded-2xl bg-zinc-900 px-4 py-2 text-sm text-white">
                    {b.question}
                  </p>
                </div>

                {/* AI 回复块 */}
                <div className="space-y-3">
                  {/* ① 查证进度卡（工具直播） */}
                  {b.toolCards.length > 0 && (
                    <div className="space-y-1.5">
                      {b.toolCards.map((c, i) => (
                        <div
                          key={`${c.tool}-${String(i)}`}
                          className={`rounded-lg border px-3 py-2 text-sm ${
                            c.zone === "green"
                              ? "border-emerald-200 bg-emerald-50"
                              : "border-amber-300 bg-amber-50"
                          }`}
                        >
                          <span className="mr-2">
                            {c.status === "running" ? "⏳" : c.zone === "green" ? "🟢" : "🟡"}
                          </span>
                          <span className="font-mono text-xs text-zinc-500">{c.tool}</span>
                          <span className="mx-2 text-zinc-300">|</span>
                          <span className="text-zinc-700">
                            {c.status === "running" ? "查证中…" : c.summary}
                          </span>
                          {c.raw !== null && (
                            <details className="mt-1">
                              <summary className="cursor-pointer text-xs text-sky-700 hover:underline">
                                展开原文结果
                              </summary>
                              <pre className="mt-1 max-h-48 overflow-auto rounded bg-zinc-50 p-2 font-mono text-xs leading-4 text-zinc-600">
                                {JSON.stringify(c.raw, null, 2)}
                              </pre>
                            </details>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* ② 琥珀色 Dry-Run 审批卡 */}
                  {b.dryRuns.map((d) => (
                    <div
                      key={d.approvalId}
                      className={`rounded-xl border-2 p-4 ${
                        d.state === "approved"
                          ? "border-emerald-400 bg-emerald-50"
                          : d.state === "cancelled"
                            ? "border-zinc-300 bg-zinc-100 opacity-70"
                            : "border-amber-400 bg-amber-50 ring-1 ring-amber-200"
                      }`}
                    >
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-sm font-bold">
                          {d.state === "approved" ? "✅ " : d.state === "cancelled" ? "🚫 " : "⚠️ "}
                          {d.title}
                        </p>
                        <span className="font-mono text-xs text-zinc-500">{d.approvalId}</span>
                      </div>

                      {d.before && d.after && (
                        <DiffRows before={d.before} after={d.after} />
                      )}
                      {d.draft && (
                        <pre className="mb-2 rounded bg-amber-100/60 p-2 font-mono text-xs leading-4 text-amber-900">
                          {JSON.stringify(d.draft, null, 2)}
                        </pre>
                      )}

                      <p className="text-xs leading-5 text-zinc-500">{d.summary}</p>

                      {d.state === "pending" && (
                        <div className="mt-3 flex gap-2">
                          <button
                            onClick={() =>
                              void approveDryRun(b.id, d.approvalId, d.tool, d.summary)
                            }
                            className="rounded-lg bg-amber-500 px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-amber-600 active:scale-95"
                          >
                            批准执行
                          </button>
                          <button
                            onClick={() => cancelDryRun(b.id, d.approvalId)}
                            className="rounded-lg border border-zinc-300 bg-white px-4 py-1.5 text-sm text-zinc-600 hover:border-zinc-500"
                          >
                            取消
                          </button>
                        </div>
                      )}
                      {d.state === "approved" && (
                        <p className="mt-2 text-sm font-semibold text-emerald-700">
                          ✅ 已批准 · {d.approver} ·{" "}
                          {d.approvedAt
                            ? new Date(d.approvedAt).toLocaleString("zh-CN", { hour12: false })
                            : ""}
                          （审计已留痕，本卡不可重复操作）
                        </p>
                      )}
                      {d.state === "cancelled" && (
                        <p className="mt-2 text-sm text-zinc-500">已取消，草稿作废（不落库）。</p>
                      )}
                    </div>
                  ))}

                  {/* ③ 流式回复正文 */}
                  {b.text && (
                    <p className="whitespace-pre-wrap text-sm leading-7 text-zinc-800">
                      {b.text}
                    </p>
                  )}

                  {/* ④ 底部费用徽章 */}
                  {b.usage && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                      <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1 font-mono">
                        {b.usage.providerId} · {b.usage.model}
                      </span>
                      <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1 font-mono">
                        TTFT {b.usage.ttftMs}ms · {b.usage.totalMs}ms
                      </span>
                      <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1 font-mono">
                        Token {b.usage.inputTokens}/{b.usage.outputTokens}
                      </span>
                      <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 font-mono text-emerald-700">
                        ${b.usage.usdCost.toFixed(6)}
                      </span>
                      <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1">
                        {b.usage.mode === "offline-sim" ? "离线高仿真" : "真实 API"}
                      </span>
                      {b.usage.wasFallback && (
                        <span className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 font-semibold text-amber-800">
                          已容灾切换
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* 底部：输入区 + 费用徽章 */}
          <div className="mt-3 space-y-2">
            {lastUsageBadge && (
              <p className="font-mono text-xs text-zinc-400">上次调用：{lastUsageBadge}</p>
            )}
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void ask(input);
                  }
                }}
                rows={2}
                placeholder="输入问题，Enter 发送（Shift+Enter 换行）…"
                className="min-h-[52px] flex-1 resize-none rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
              />
              {streaming ? (
                <button
                  onClick={stop}
                  className="h-[52px] rounded-xl bg-red-600 px-5 text-sm font-semibold text-white transition-colors hover:bg-red-700"
                >
                  ■ 停止生成
                </button>
              ) : (
                <button
                  onClick={() => void ask(input)}
                  disabled={input.trim().length === 0}
                  className="h-[52px] rounded-xl bg-zinc-900 px-5 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 disabled:opacity-40"
                >
                  发送
                </button>
              )}
            </div>
            <p className="text-xs leading-5 text-zinc-400">
              每次调用结束后，厂商、Token 数与美元花费由服务端写入 llm_usage_logs
              台账（只增不改）；三层记忆（情景/语义）写入记忆表且可随时在左侧「我的记忆」里查看、编辑、删除。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
