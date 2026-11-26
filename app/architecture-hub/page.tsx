"use client";

/**
 * /architecture-hub —— Day 20 Checkpoint #1 架构中心（纯前端展示 + 考官接口）
 * Tab 1：交互式全栈架构拓扑（悬停高亮数据流向）+ 需求偏差审计表（12 项）
 * Tab 2：5 段式精确 300 秒倒计时提词器（每段 60 秒，自动推进）+ AI 扮演 CFO/CISO/CTO 考官
 * 数据同源：docs/architecture/WORKBOT-PRODUCTION-ARCHITECTURE.md（展示内容与文档一致）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ================= 一、Tab 1 数据（与架构文档同源） ================= */

const LAYERS: {
  id: string;
  title: string;
  color: string;
  items: string[];
  note: string;
}[] = [
  {
    id: "entry",
    title: "入口层 · 13 页面",
    color: "bg-emerald-50 border-emerald-300",
    items: [
      "工单协同台 /",
      "对话工作台 /chat",
      "生成式 UI /studio",
      "调查引擎 /investigate",
      "客服专班 /multi-agent",
      "检索实验室 /rag-lab",
      "浏览器实验室 /browser-lab",
      "尽调研究台 /research-analyst",
      "多模态 /multimodal",
      "单据抽取 /extraction",
      "持久审批流 /workflows",
      "老 ERP 仿真 /sandbox-legacy-erp",
    ],
    note: "全部纳入 TopNav；页面只展示，不放行任何资金动作。",
  },
  {
    id: "api",
    title: "API 层 · 24 路由",
    color: "bg-sky-50 border-sky-300",
    items: [
      "/api/tickets(+approve)",
      "/api/chat(+approve)",
      "/api/generative-ui",
      "/api/memory",
      "/api/investigate",
      "/api/multi-agent",
      "/api/rag-lab",
      "/api/browser-lab",
      "/api/sandbox-legacy-erp/submit",
      "/api/research-analyst(+archive)",
      "/api/multimodal/forensics",
      "/api/voice/*",
      "/api/extraction/eval",
      "/api/workflows(+decide)",
      "/api/inngest",
      "/api/mcp/tasks(+[taskId])",
      "/api/external-logistics/a2a/*",
    ],
    note: "API Key 只在服务端读取；审批接口幂等（重复批准 409）。",
  },
  {
    id: "engine",
    title: "引擎层 · 核心模块",
    color: "bg-amber-50 border-amber-300",
    items: [
      "双模型流式引擎（主备容灾）",
      "对话工具链 4 工具 + dryRun 锁死",
      "ReAct 调查引擎（maxSteps=8 熔断）",
      "四代理专班 + 双向护栏",
      "防越权混合检索（Pre-filtering ACL）",
      "抓取/预填引擎（只读 GET）",
      "尽调三阶段编排",
      "Postgres 状态机 + Inngest 双引擎同构",
    ],
    note: "打款/付款/放款类工具物理不存在于任何注册表。",
  },
  {
    id: "data",
    title: "数据层 · 13 张表",
    color: "bg-violet-50 border-violet-300",
    items: [
      "intake_requests 工单",
      "approval_audit_logs 审计（只增不改）",
      "llm_usage_logs 用量（只增不改）",
      "memory_episodes / user_preferences（可编辑删除）",
      "agent_traces / agent_spans（只增不改）",
      "erp_scraped_invoices 抓取副本",
      "research_reports 归档（只增不改）",
      "workflow_runs 状态机（单点推进）",
      "workflow_events 事件（只增不改）",
      "mcp_tasks 异步任务",
    ],
    note: "6 张审计/事件表挂触发器物理拒绝 UPDATE/DELETE；记忆表刻意豁免（用户遗忘权）。",
  },
  {
    id: "security",
    title: "安全层 · 红线落地",
    color: "bg-rose-50 border-rose-300",
    items: [
      "FIN-001 单点判定（>¥50,000，等于不触发）",
      "PII 确定性脱敏（fail-closed）",
      "入口/出口双向护栏（注入毫秒级拦截）",
      "生成式 UI 16 组件白名单",
      "物理 Kill Switch（5 秒切断不丢日志）",
    ],
    note: "红区不是「提示不要做」，而是物理剔除——机器想违规都没有手段。",
  },
];

const AUDIT_ROWS: { no: string; contract: string; status: "达标" | "偏差"; evidence: string }[] = [
  { no: "D1", contract: "FIN-001：单笔超过 ¥50,000 强制人工审批，等于不触发", status: "达标", evidence: "src/lib/fin001.ts 严格大于；全站单点函数无副本" },
  { no: "D2", contract: "拆单按合并口径处理并上报（Q13）", status: "达标", evidence: "react-agent.ts 探针结论含拆单合并口径" },
  { no: "D3", contract: "旧版 10 万制度已废止，不得引用", status: "达标", evidence: "全库无 100000 阈值；护栏专门拦截「恢复旧制度」注入" },
  { no: "D4", contract: "红区物理剔除：无自动打款类工具", status: "达标", evidence: "工具注册表 + 启动自检禁词扫描（打款/付款/放款）" },
  { no: "D5", contract: "黄区写操作强制 dryRun 预演", status: "达标", evidence: "chat-engine.ts dryRunTool：传什么都不落库，只出 Diff 草稿" },
  { no: "D6", contract: "审计日志只增不改", status: "达标", evidence: "6 表触发器物理拒绝 UPDATE/DELETE；代码无篡改入口" },
  { no: "D7", contract: "记忆可被用户编辑/删除", status: "达标", evidence: "memory 两表刻意不挂只增不改触发器（遗忘权优先）" },
  { no: "D8", contract: "每日定时只读快照桥接老 ERP", status: "偏差", evidence: "实现为只读 GET 抓取引擎 → WorkBot 副本表；方向更保守，绝不回写老 ERP" },
  { no: "D9", contract: "话术 AI 起草 + 人工确认后发送", status: "达标", evidence: "黄区草稿卡 + 审批接口；批准后 UI 变翠绿不可重复点击" },
  { no: "D10", contract: "算术由确定性自动化执行（02 步骤 7）", status: "达标", evidence: "workflow_runs.arithmetic_ok 代码算术，不过即红灯拦截" },
  { no: "D11", contract: "Non-Goal #4：不做数据看板", status: "偏差", evidence: "特训营教学演示台含看板，不进入对客户交付的 V1 范围" },
  { no: "D12", contract: "API Key 只在服务端读取，严禁 NEXT_PUBLIC 泄露", status: "达标", evidence: "密钥仅服务端 import；前端零接触" },
];

const ADRS = [
  {
    id: "ADR-001",
    title: "生成式 UI：受控组件目录而非自由 HTML",
    decision: "模型只输出「白名单组件名 + 受控 Props」布局 JSON；注入特征（<script / javascript: / onerror=）服务端直接 400。",
    consequence: "牺牲表达自由度，换来「模型输出永远不可能执行」的物理保证。",
  },
  {
    id: "ADR-002",
    title: "检索权限：Pre-filtering ACL（先过滤后打分）",
    decision: "相关性打分之前按角色过滤文档池，越权文档物理进不了打分管线；废止文件只出拦截通报。",
    consequence: "索引两段式（全语料 IDF + 角色可见池），成本略增；换来越权内容数学上不可达。",
  },
  {
    id: "ADR-003",
    title: "大额审批流：Inngest + 代码算术校验的双引擎同构状态机",
    decision: "postgres 与 inngest 调同一批状态机函数；挂起只存数据库行（零定时器）；算术纯代码校验不过即红灯；批准幂等（重复 409）。",
    consequence: "断电不丢、跨重启可证明恢复、算术 100% 可复现；代价是多一张状态表 + 事件流水写入约定。",
  },
];

/* ================= 二、Tab 2 数据：5 段式提词器（每段 60 秒，共 300 秒） ================= */

const SEGMENTS: { title: string; seconds: number; script: string }[] = [
  {
    title: "第一段 · 开场与 MVV（60 秒）",
    seconds: 60,
    script:
      "各位好。WorkBot 解决的是一件事：每月 4,000 张退款单里，抄表、算账、对数这三样重复劳动全部自动跑起来，算术零失误、漏审有据可查。同时每笔超过 5 万元的付款，必须由具名的人签字放行——AI 只读、起草、标记，放行永远归人。这就是我们的最小可行价值。",
  },
  {
    title: "第二段 · 流程裁剪与 ROI（60 秒）",
    seconds: 60,
    script:
      "我们对 12 步现状流程做了裁剪：砍掉 4 步纯搬运（两张表的抄写、自查、文件传递），保留 3 步交给确定性自动化（算术、额度校验、照章执行），2 步必须人来（接单沟通、大额审批），2 步交给 AI 但产出必须过人（看发票、拟话术）。测算月净收益约 7.1 万元——其中五项是假设值，上线前一周会用真实数据回填复核，不构成承诺。",
  },
  {
    title: "第三段 · 三色安全边界与红线（60 秒）",
    seconds: 60,
    script:
      "安全上我们做了三色边界：绿区只读免确认，黄区 AI 起草加人类确认，红区物理剔除——不是提示词劝阻，而是打款类工具在工具列表里根本不存在。审计日志只增不改，数据库触发器物理拒绝篡改。外来文件内容一律当资料，注入指令只上报不执行。任何人 5 秒内可以物理切断全部自动化，切断不丢日志。",
  },
  {
    title: "第四段 · 技术架构与三个关键决策（60 秒）",
    seconds: 60,
    script:
      "技术上三个关键决策：第一，生成式 UI 用 16 个受控组件白名单，严禁模型输出原始网页代码，注入特征直接拦截；第二，检索权限先过滤后打分，越权文档物理进不了打分管线；第三，大额审批流用持久化状态机，挂起 7 天不占内存，服务重启照样恢复，算术校验是纯代码，模型想凑平也凑不了。",
  },
  {
    title: "第五段 · Non-Goals 与下一步（60 秒）",
    seconds: 60,
    script:
      "最后说清楚我们不做什么：不做无人值守的全自动付款，不动 15 年老 ERP 本身，不做自由对话机器人，不做绕过审批的加急通道。下一步是按黄金考卷 20 题整卷重考，20 比 20 合格才进小流量试运行。谢谢，欢迎提问。",
  },
];

/* ================= 三、AI 考官（调用 /api/architecture-hub/examiner） ================= */

type Role = "CFO" | "CISO" | "CTO";
interface AskResp {
  mode: "ask";
  question: { id: string; question: string; intent: string };
  total: number;
}
interface GradeResp {
  mode: "grade";
  blocked: boolean;
  patterns?: string[];
  intent?: string;
  hits?: { keyword: string; hint: string; hit: boolean }[];
  score?: number;
  verdict?: string;
  message: string;
}

/* ================= 四、页面组件 ================= */

export default function ArchitectureHubPage() {
  const [tab, setTab] = useState<"topo" | "rehearse">("topo");
  const [hoverLayer, setHoverLayer] = useState<string | null>(null);
  const [auditFilter, setAuditFilter] = useState<"all" | "达标" | "偏差">("all");

  /* ---- 提词器状态（精确倒计时：以时间戳为基准，非累计近似） ---- */
  const [segIdx, setSegIdx] = useState(0);
  const [running, setRunning] = useState(false);
  const [remainInSeg, setRemainInSeg] = useState(SEGMENTS[0].seconds);
  const [totalElapsed, setTotalElapsed] = useState(0);
  const deadlineRef = useRef<number | null>(null);
  const segRemainRef = useRef(SEGMENTS[0].seconds);
  const elapsedRef = useRef(0);

  useEffect(() => {
    if (!running) return;
    deadlineRef.current = Date.now() + segRemainRef.current * 1000;
    const timer = setInterval(() => {
      const segRemain = Math.max(
        0,
        Math.ceil(((deadlineRef.current ?? Date.now()) - Date.now()) / 1000),
      );
      segRemainRef.current = segRemain;
      elapsedRef.current += 1;
      setRemainInSeg(segRemain);
      setTotalElapsed(elapsedRef.current);
      if (segRemain <= 0) {
        // 本段结束：推进下一段；最后一段结束自动停
        if (segIdx < SEGMENTS.length - 1) {
          const next = segIdx + 1;
          setSegIdx(next);
          segRemainRef.current = SEGMENTS[next].seconds;
          deadlineRef.current = Date.now() + SEGMENTS[next].seconds * 1000;
          setRemainInSeg(SEGMENTS[next].seconds);
        } else {
          setRunning(false);
        }
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [running, segIdx]);

  const resetTeleprompter = useCallback(() => {
    setRunning(false);
    setSegIdx(0);
    segRemainRef.current = SEGMENTS[0].seconds;
    elapsedRef.current = 0;
    setRemainInSeg(SEGMENTS[0].seconds);
    setTotalElapsed(0);
  }, []);

  const segProgress = useMemo(
    () => 1 - remainInSeg / SEGMENTS[segIdx].seconds,
    [remainInSeg, segIdx],
  );

  /* ---- 考官状态 ---- */
  const [role, setRole] = useState<Role>("CFO");
  const [question, setQuestion] = useState<AskResp["question"] | null>(null);
  const [answer, setAnswer] = useState("");
  const [grade, setGrade] = useState<GradeResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const askFirst = useCallback(async (r: Role) => {
    setLoading(true);
    setError("");
    setGrade(null);
    setAnswer("");
    try {
      const res = await fetch("/api/architecture-hub/examiner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: r }),
      });
      const data = (await res.json()) as AskResp;
      setQuestion(data.question);
    } catch {
      setError("考官接口异常，请稍后再试。");
    } finally {
      setLoading(false);
    }
  }, []);

  const submitAnswer = useCallback(async () => {
    if (!question || answer.trim().length === 0) {
      setError("请先作答再提交。");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/architecture-hub/examiner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, questionId: question.id, answer }),
      });
      const data = (await res.json()) as GradeResp;
      setGrade(data);
    } catch {
      setError("评分请求异常，请稍后再试。");
    } finally {
      setLoading(false);
    }
  }, [question, answer, role]);

  const filteredAudit = auditFilter === "all" ? AUDIT_ROWS : AUDIT_ROWS.filter((r) => r.status === auditFilter);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold tracking-tight">架构中心 · Day 20 Checkpoint #1</h1>
      <p className="mt-1 text-sm text-zinc-500">
        架构拓扑与偏差审计同源 <code className="rounded bg-zinc-100 px-1">docs/architecture/WORKBOT-PRODUCTION-ARCHITECTURE.md</code>
        ；核验一键命令 <code className="rounded bg-zinc-100 px-1">pnpm midpoint:verify</code>。
      </p>

      {/* Tab 切换 */}
      <div className="mt-5 inline-flex rounded-xl border border-zinc-200 bg-white p-1">
        <button
          onClick={() => setTab("topo")}
          className={`rounded-lg px-4 py-1.5 text-sm font-semibold ${tab === "topo" ? "bg-zinc-900 text-white" : "text-zinc-600 hover:text-zinc-900"}`}
        >
          Tab 1 · 全栈拓扑与偏差审计
        </button>
        <button
          onClick={() => setTab("rehearse")}
          className={`rounded-lg px-4 py-1.5 text-sm font-semibold ${tab === "rehearse" ? "bg-zinc-900 text-white" : "text-zinc-600 hover:text-zinc-900"}`}
        >
          Tab 2 · 300 秒提词器 + AI 考官
        </button>
      </div>

      {/* ============ Tab 1 ============ */}
      {tab === "topo" && (
        <div className="mt-6 space-y-6">
          {/* 交互式拓扑：悬停某层高亮，其余层降透明 */}
          <section className="rounded-2xl border border-zinc-200 bg-white p-5">
            <h2 className="font-bold">全栈架构拓扑（悬停查看该层要点）</h2>
            <div className="mt-4 space-y-2">
              {LAYERS.map((layer, i) => (
                <div key={layer.id}>
                  {i > 0 && <div className="mx-auto h-3 w-px bg-zinc-300" aria-hidden />}
                  <button
                    onMouseEnter={() => setHoverLayer(layer.id)}
                    onMouseLeave={() => setHoverLayer(null)}
                    onFocus={() => setHoverLayer(layer.id)}
                    onBlur={() => setHoverLayer(null)}
                    className={`w-full rounded-xl border p-4 text-left transition-all ${layer.color} ${
                      hoverLayer && hoverLayer !== layer.id ? "opacity-40" : "opacity-100"
                    }`}
                  >
                    <div className="font-bold">{layer.title}</div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {layer.items.map((it) => (
                        <span key={it} className="rounded-md bg-white/80 px-2 py-0.5 text-xs text-zinc-700">
                          {it}
                        </span>
                      ))}
                    </div>
                    {hoverLayer === layer.id && (
                      <p className="mt-2 text-xs font-medium text-zinc-600">{layer.note}</p>
                    )}
                  </button>
                </div>
              ))}
            </div>
          </section>

          {/* 偏差审计表 */}
          <section className="rounded-2xl border border-zinc-200 bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-bold">需求偏差审计表（契约 vs 实现，12 项）</h2>
              <div className="flex gap-1">
                {(["all", "达标", "偏差"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setAuditFilter(f)}
                    className={`rounded-lg px-3 py-1 text-xs font-semibold ${auditFilter === f ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-600 hover:text-zinc-900"}`}
                  >
                    {f === "all" ? "全部" : f}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-xs text-zinc-500">
                    <th className="py-2 pr-2">#</th>
                    <th className="py-2 pr-2">契约要求</th>
                    <th className="py-2 pr-2">状态</th>
                    <th className="py-2">证据</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAudit.map((r) => (
                    <tr key={r.no} className="border-b border-zinc-100 align-top">
                      <td className="py-2 pr-2 font-mono text-xs">{r.no}</td>
                      <td className="py-2 pr-2">{r.contract}</td>
                      <td className="py-2 pr-2">
                        <span
                          className={`rounded-md px-2 py-0.5 text-xs font-bold ${
                            r.status === "达标" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
                          }`}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="py-2 text-xs text-zinc-500">{r.evidence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-zinc-500">
              结论：10 项严格达标，2 项为「方向更保守」或「教学演示专属」的有意偏差，无一项违反业务红线。
            </p>
          </section>

          {/* 三份 ADR */}
          <section className="grid gap-4 md:grid-cols-3">
            {ADRS.map((a) => (
              <div key={a.id} className="rounded-2xl border border-zinc-200 bg-white p-5">
                <div className="font-mono text-xs font-bold text-sky-600">{a.id}</div>
                <h3 className="mt-1 font-bold">{a.title}</h3>
                <p className="mt-2 text-xs text-zinc-600">
                  <span className="font-bold text-zinc-800">决策：</span>
                  {a.decision}
                </p>
                <p className="mt-1.5 text-xs text-zinc-600">
                  <span className="font-bold text-zinc-800">后果：</span>
                  {a.consequence}
                </p>
              </div>
            ))}
          </section>
        </div>
      )}

      {/* ============ Tab 2 ============ */}
      {tab === "rehearse" && (
        <div className="mt-6 space-y-6">
          {/* 5 段式提词器 */}
          <section className="rounded-2xl border border-zinc-200 bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-bold">汇报提词器 · 5 段式精确 300 秒</h2>
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm">
                  总用时 {String(Math.floor(totalElapsed / 60)).padStart(2, "0")}:
                  {String(totalElapsed % 60).padStart(2, "0")} / 05:00
                </span>
                <button
                  onClick={() => setRunning((v) => !v)}
                  className="rounded-lg bg-zinc-900 px-4 py-1.5 text-sm font-semibold text-white hover:bg-zinc-700"
                >
                  {running ? "暂停" : totalElapsed === 0 ? "开始" : "继续"}
                </button>
                <button
                  onClick={resetTeleprompter}
                  className="rounded-lg bg-zinc-100 px-3 py-1.5 text-sm font-semibold text-zinc-600 hover:text-zinc-900"
                >
                  重置
                </button>
              </div>
            </div>

            {/* 段落指示条 */}
            <div className="mt-4 flex gap-1">
              {SEGMENTS.map((s, i) => (
                <div key={s.title} className="flex-1">
                  <div
                    className={`h-2 rounded-full ${i < segIdx ? "bg-emerald-500" : i === segIdx ? "bg-zinc-900" : "bg-zinc-200"}`}
                    style={
                      i === segIdx && running
                        ? { background: `linear-gradient(to right, #18181b ${segProgress * 100}%, #e4e4e7 ${segProgress * 100}%)` }
                        : undefined
                    }
                  />
                  <div className={`mt-1 text-center text-[10px] ${i === segIdx ? "font-bold text-zinc-900" : "text-zinc-400"}`}>
                    段 {String(i + 1)}
                  </div>
                </div>
              ))}
            </div>

            {/* 当前段提词卡 */}
            <div className="mt-4 rounded-xl border-2 border-zinc-900 bg-zinc-50 p-5">
              <div className="flex items-center justify-between">
                <h3 className="font-bold">{SEGMENTS[segIdx].title}</h3>
                <span
                  className={`font-mono text-3xl font-bold tabular-nums ${remainInSeg <= 10 ? "text-red-600" : "text-zinc-900"}`}
                >
                  {String(Math.floor(remainInSeg / 60)).padStart(1, "0")}:
                  {String(remainInSeg % 60).padStart(2, "0")}
                </span>
              </div>
              <p className="mt-3 text-base leading-relaxed">{SEGMENTS[segIdx].script}</p>
              <div className="mt-3 flex justify-between text-xs text-zinc-400">
                <button
                  onClick={() => {
                    const prev = Math.max(0, segIdx - 1);
                    setSegIdx(prev);
                    segRemainRef.current = SEGMENTS[prev].seconds;
                    setRemainInSeg(SEGMENTS[prev].seconds);
                  }}
                  disabled={segIdx === 0}
                  className="font-semibold text-zinc-500 hover:text-zinc-900 disabled:opacity-40"
                >
                  ← 上一段
                </button>
                <button
                  onClick={() => {
                    const next = Math.min(SEGMENTS.length - 1, segIdx + 1);
                    setSegIdx(next);
                    segRemainRef.current = SEGMENTS[next].seconds;
                    setRemainInSeg(SEGMENTS[next].seconds);
                  }}
                  disabled={segIdx === SEGMENTS.length - 1}
                  className="font-semibold text-zinc-500 hover:text-zinc-900 disabled:opacity-40"
                >
                  下一段 →
                </button>
              </div>
            </div>
          </section>

          {/* AI 考官 */}
          <section className="rounded-2xl border border-zinc-200 bg-white p-5">
            <h2 className="font-bold">AI 尖锐问答考官（CFO / CISO / CTO）</h2>
            <p className="mt-1 text-xs text-zinc-500">
              评分是确定性关键词命中（可复现、零幻觉），大模型只负责考官话术包装；默认离线高仿真，密钥零接触。
            </p>

            <div className="mt-4 flex gap-2">
              {(["CFO", "CISO", "CTO"] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => {
                    setRole(r);
                    void askFirst(r);
                  }}
                  className={`rounded-lg px-4 py-1.5 text-sm font-bold ${role === r ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-600 hover:text-zinc-900"}`}
                >
                  {r === "CFO" ? "CFO · 财务官" : r === "CISO" ? "CISO · 安全官" : "CTO · 技术官"}
                </button>
              ))}
            </div>

            {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

            {question && (
              <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4">
                <div className="flex items-center justify-between">
                  <span className="rounded-md bg-amber-200 px-2 py-0.5 text-xs font-bold text-amber-800">
                    {role} · {question.id}
                  </span>
                </div>
                <p className="mt-2 font-semibold">{question.question}</p>
                <textarea
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  rows={4}
                  placeholder="用大白话作答，关键词命中考察点即可得分……"
                  className="mt-3 w-full rounded-lg border border-zinc-300 p-3 text-sm focus:border-zinc-900 focus:outline-none"
                />
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => void submitAnswer()}
                    disabled={loading}
                    className="rounded-lg bg-zinc-900 px-4 py-1.5 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-50"
                  >
                    {loading ? "考官阅卷中…" : "提交作答"}
                  </button>
                  <button
                    onClick={() => void askFirst(role)}
                    disabled={loading}
                    className="rounded-lg bg-zinc-100 px-4 py-1.5 text-sm font-semibold text-zinc-600 hover:text-zinc-900 disabled:opacity-50"
                  >
                    换一题
                  </button>
                </div>
              </div>
            )}

            {grade && (
              <div
                className={`mt-4 rounded-xl border p-4 ${
                  grade.blocked
                    ? "border-rose-300 bg-rose-50"
                    : grade.verdict === "合格"
                      ? "border-emerald-300 bg-emerald-50"
                      : grade.verdict === "待补强"
                        ? "border-amber-300 bg-amber-50"
                        : "border-rose-300 bg-rose-50"
                }`}
              >
                {!grade.blocked && grade.score !== undefined && (
                  <div className="flex items-center gap-3">
                    <span className="text-2xl font-bold tabular-nums">{grade.score} 分</span>
                    <span
                      className={`rounded-md px-2 py-0.5 text-xs font-bold ${
                        grade.verdict === "合格"
                          ? "bg-emerald-200 text-emerald-800"
                          : grade.verdict === "待补强"
                            ? "bg-amber-200 text-amber-800"
                            : "bg-rose-200 text-rose-800"
                      }`}
                    >
                      {grade.verdict}
                    </span>
                  </div>
                )}
                {grade.blocked && grade.patterns && (
                  <p className="text-sm font-bold text-rose-700">
                    入口护栏拦截：{grade.patterns.join("；")}
                  </p>
                )}
                {grade.hits && (
                  <ul className="mt-2 space-y-1 text-xs">
                    {grade.hits.map((h) => (
                      <li key={h.keyword} className={h.hit ? "text-emerald-700" : "text-rose-600"}>
                        {h.hit ? "✓" : "✗"} {h.hint}
                      </li>
                    ))}
                  </ul>
                )}
                {grade.intent && <p className="mt-2 text-xs text-zinc-500">考察点：{grade.intent}</p>}
                <p className="mt-2 text-sm">{grade.message}</p>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
