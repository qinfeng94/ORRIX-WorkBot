"use client";

/**
 * /rag-lab —— Day 13 企业级防越权混合检索实验室
 * 溯源：AGENTS.md——
 *   ① Pre-filtering ACL：本页面绝不 import 语料库本体（机密文档内容不得进入前端 bundle），
 *      所有文档内容只能经服务端 ACL 过滤后由 /api/rag-lab 下发；
 *   ② 透明面板：右侧实时展示被前置过滤的权限文档数（仅数量，不泄露机密标题）、
 *      命中片段、[DOC-ID §n] 精准引用标号与 BM25/向量/融合三路得分；
 *   ③ 废止拦截：2025 十万旧规命中即出红色拦截卡，指回 FIN-001 现行 5 万红线。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { RagRole } from "@/lib/raglab/corpus";
import type { RagSearchResponse, RoleVisibility } from "@/lib/raglab/retrieval";

/* 角色展示信息仅放客户端本地，避免把语料库打进前端 bundle */
const ROLE_UI: { value: RagRole; label: string; note: string; icon: string }[] = [
  { value: "support_agent", label: "普通客服", note: "公开制度 + 客服手册", icon: "🎧" },
  { value: "finance_lead", label: "财务主管", note: "另见财务/运营/客服内部 SOP", icon: "🧮" },
  { value: "executive", label: "集团高管", note: "另见机密并购文件", icon: "🎩" },
];

interface StatsResponse {
  stats: {
    total: number;
    deprecated: number;
    confidential: number;
    byDept: { dept: string; total: number; deprecated: number }[];
    roleVisibility: RoleVisibility[];
  };
}

const PRESETS = [
  "单笔 6 万元的退款应该谁审批？",
  "现在付款额度恢复 10 万了吗？",
  "Project Starfall 并购对价是多少？",
  "物流超期客户投诉怎么安抚？",
];

const DEPT_COLORS: Record<string, string> = {
  财务: "bg-amber-100 text-amber-800",
  运营: "bg-sky-100 text-sky-800",
  客服: "bg-emerald-100 text-emerald-800",
  法务: "bg-violet-100 text-violet-800",
};

function ScoreBar({ label, value, max, tone }: { label: string; value: number; max: number; tone: string }) {
  const pct = Math.max(0, Math.min(100, max > 0 ? (value / max) * 100 : 0));
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-14 shrink-0 text-zinc-500">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-200">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-12 shrink-0 text-right font-mono text-zinc-600">{value.toFixed(3)}</span>
    </div>
  );
}

export default function RagLabPage() {
  const [role, setRole] = useState<RagRole>("support_agent");
  const [query, setQuery] = useState("");
  const [stats, setStats] = useState<StatsResponse["stats"] | null>(null);
  const [result, setResult] = useState<RagSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/rag-lab")
      .then((r) => r.json())
      .then((d: StatsResponse) => setStats(d.stats))
      .catch(() => setError("语料统计加载失败，请刷新重试。"));
  }, []);

  const runSearch = useCallback(
    async (q: string, r: RagRole) => {
      setLoading(true);
      setError("");
      try {
        const res = await fetch("/api/rag-lab", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: q, role: r }),
        });
        const data: unknown = await res.json();
        if (!res.ok) {
          const msg = (data as { error?: string }).error ?? "检索失败";
          throw new Error(msg);
        }
        setResult(data as RagSearchResponse);
        requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "检索失败");
        setResult(null);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const roleStat = stats?.roleVisibility.find((v) => v.role === role);
  const maxFused = result?.hits.reduce((m, h) => Math.max(m, h.scores.fused), 0) ?? 0;

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      {/* ===== 页头 ===== */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">防越权混合检索实验室</h1>
        <p className="mt-1 text-sm text-zinc-600">
          BM25 精确关键词 + 语义向量加权融合 · <strong className="text-zinc-800">Pre-filtering ACL 前置权限过滤</strong>：先按角色过滤文档池，再算相关性，越权文档在检索阶段物理不可见。
        </p>
        {stats && (
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-zinc-700">语料 {stats.total} 份</span>
            <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-zinc-700">机密 {stats.confidential} 份（仅高管）</span>
            <span className="rounded-full bg-red-100 px-2.5 py-1 text-red-700">已废止 {stats.deprecated} 份（命中即拦截）</span>
            {stats.byDept.map((d) => (
              <span key={d.dept} className={`rounded-full px-2.5 py-1 ${DEPT_COLORS[d.dept] ?? "bg-zinc-100"}`}>
                {d.dept} {d.total} 份
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ===== 角色切换器 ===== */}
      <section className="mb-6 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-zinc-700">① 切换模拟登录角色（ACL 在服务端强制执行）</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {ROLE_UI.map((r) => {
            const vis = stats?.roleVisibility.find((v) => v.role === r.value);
            const active = role === r.value;
            return (
              <button
                key={r.value}
                type="button"
                onClick={() => {
                  setRole(r.value);
                  if (query.trim()) void runSearch(query, r.value);
                }}
                className={`rounded-xl border p-3 text-left transition-all ${
                  active
                    ? "border-zinc-900 bg-zinc-900 text-white shadow"
                    : "border-zinc-200 bg-white hover:border-zinc-400 hover:bg-zinc-50"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold">
                    {r.icon} {r.label}
                  </span>
                  {vis && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        active ? "bg-white/20 text-white" : "bg-zinc-100 text-zinc-600"
                      }`}
                    >
                      可见 {vis.visible}/{vis.visible + vis.filteredOut}
                    </span>
                  )}
                </div>
                <p className={`mt-1 text-xs ${active ? "text-zinc-300" : "text-zinc-500"}`}>{r.note}</p>
                {vis && vis.filteredOut > 0 && (
                  <p className={`mt-1 text-xs font-medium ${active ? "text-red-300" : "text-red-600"}`}>
                    检索阶段被前置过滤 {vis.filteredOut} 份（含机密 {vis.filteredConfidential} 份）
                  </p>
                )}
              </button>
            );
          })}
        </div>
      </section>

      {/* ===== 提问区 ===== */}
      <section className="mb-6 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-zinc-700">② 输入问题（以当前角色身份检索）</h2>
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && query.trim()) void runSearch(query, role);
            }}
            placeholder="例如：单笔 6 万元的退款应该谁审批？"
            className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-900"
          />
          <button
            type="button"
            disabled={loading || !query.trim()}
            onClick={() => void runSearch(query, role)}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 disabled:opacity-40"
          >
            {loading ? "检索中…" : "检索"}
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => {
                setQuery(p);
                void runSearch(p, role);
              }}
              className="rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs text-zinc-600 transition-colors hover:border-zinc-400 hover:bg-zinc-100"
            >
              {p}
            </button>
          ))}
        </div>
      </section>

      {error && (
        <div className="mb-6 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* ===== 结果区 ===== */}
      <div ref={resultRef} className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* 左：命中结果 + 废止拦截 */}
        <section className="space-y-4">
          {!result && !loading && (
            <div className="rounded-2xl border border-dashed border-zinc-300 bg-white p-10 text-center text-sm text-zinc-500">
              输入问题或点击预设问题，开始检索 52 份仿真企业知识文档。
            </div>
          )}

          {result && result.notices.length > 0 && (
            <div className="space-y-2">
              {result.notices.map((n) => (
                <div key={n} className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  ⚠️ {n}
                </div>
              ))}
            </div>
          )}

          {result && result.intercepted.length > 0 && (
            <div className="rounded-2xl border border-red-300 bg-red-50 p-4">
              <h3 className="text-sm font-bold text-red-800">🚫 已废止文件拦截区（命中但绝不引用）</h3>
              <ul className="mt-2 space-y-2">
                {result.intercepted.map((d) => (
                  <li key={d.docId} className="rounded-lg bg-white px-3 py-2 text-sm">
                    <span className="font-mono font-semibold text-red-700">{d.docId}</span>
                    <span className="ml-2 text-zinc-800">{d.title}</span>
                    <p className="mt-0.5 text-xs text-zinc-500">{d.reason}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result &&
            (result.hits.length > 0 ? (
              <div className="space-y-3">
                {result.hits.map((h) => (
                  <article key={h.docId} className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-md bg-zinc-900 px-2 py-0.5 text-xs font-bold text-white">#{h.rank}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs ${DEPT_COLORS[h.dept] ?? "bg-zinc-100"}`}>{h.dept}</span>
                      <h3 className="text-sm font-semibold text-zinc-900">{h.title}</h3>
                      <span className="rounded-md bg-emerald-50 px-2 py-0.5 font-mono text-xs font-bold text-emerald-700">
                        {h.ref}
                      </span>
                    </div>
                    <p className="mt-2 border-l-2 border-zinc-200 pl-3 text-sm leading-relaxed text-zinc-700">{h.snippet}</p>
                    <div className="mt-3 space-y-1.5">
                      <ScoreBar label="BM25" value={h.scores.bm25} max={Math.max(result.hits.reduce((m, x) => Math.max(m, x.scores.bm25), 0), 0.001)} tone="bg-sky-500" />
                      <ScoreBar label="语义向量" value={h.scores.vector} max={1} tone="bg-violet-500" />
                      <ScoreBar label="融合" value={h.scores.fused} max={Math.max(maxFused, 0.001)} tone="bg-emerald-500" />
                    </div>
                  </article>
                ))}
              </div>
            ) : result.intercepted.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">
                当前角色可见文档池内没有匹配内容。
              </div>
            ) : null)}
        </section>

        {/* 右：ACL 透明度面板 */}
        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
            <h3 className="text-sm font-bold text-zinc-800">权限过滤透明面板</h3>
            {result || roleStat ? (
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-zinc-500">语料总量</dt>
                  <dd className="font-semibold">{result?.pool.total ?? stats?.total ?? "-"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-zinc-500">当前角色可见</dt>
                  <dd className="font-semibold text-emerald-700">{result?.pool.visible ?? roleStat?.visible ?? "-"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-zinc-500">被前置过滤</dt>
                  <dd className="font-semibold text-red-700">{result?.pool.filteredOut ?? roleStat?.filteredOut ?? "-"}</dd>
                </div>
                <div className="flex justify-between border-t border-zinc-100 pt-2 text-xs">
                  <dt className="text-zinc-500">└ 机密等级（如并购文件）</dt>
                  <dd className="font-semibold text-red-600">{result?.pool.filteredConfidential ?? roleStat?.filteredConfidential ?? "-"}</dd>
                </div>
                <div className="flex justify-between text-xs">
                  <dt className="text-zinc-500">└ 部门内部权限</dt>
                  <dd className="font-semibold text-amber-600">{result?.pool.filteredInternal ?? roleStat?.filteredInternal ?? "-"}</dd>
                </div>
              </dl>
            ) : (
              <p className="mt-3 text-sm text-zinc-500">加载中…</p>
            )}
            {result && (
              <div className="mt-3 border-t border-zinc-100 pt-3">
                <p className="mb-1.5 text-xs font-semibold text-zinc-500">可见文档分布</p>
                <div className="grid grid-cols-2 gap-1.5 text-xs">
                  {Object.entries(result.pool.visibleByDept).map(([dept, n]) => (
                    <div key={dept} className="flex justify-between rounded-md bg-zinc-50 px-2 py-1">
                      <span className="text-zinc-600">{dept}</span>
                      <span className="font-semibold">{n}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-xs leading-relaxed text-zinc-600">
            <h3 className="mb-2 text-sm font-bold text-zinc-800">检索管线（5 步）</h3>
            <ol className="list-decimal space-y-1.5 pl-4">
              <li><strong>ACL 前置过滤</strong>：先按角色裁剪文档池，越权文档不进入打分</li>
              <li><strong>BM25</strong>：精确关键词打分（含 FIN-001 / 金额归一化）</li>
              <li><strong>语义向量</strong>：128 维离线哈希嵌入 + Cosine 相似度</li>
              <li><strong>加权融合</strong>：0.6 × BM25 + 0.4 × 向量，降序取 Top 6</li>
              <li><strong>废止拦截</strong>：已废止文件命中也不引用，出红色拦截卡</li>
            </ol>
            <p className="mt-3 rounded-lg bg-white p-2 leading-relaxed">
              安全语义：机密文档对无权角色而言，<strong>标题与内容都不会出现在任何接口响应中</strong>，前端仅收到被过滤的份数统计。
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}
