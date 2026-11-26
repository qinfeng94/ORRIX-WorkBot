# WorkBot 生产架构白皮书（Day 20 Checkpoint #1）

> 项目：星辰跨境企服集团 WorkBot v4.0 · 基准：`.fde/01~05` 契约 + 仓库真实代码扫描
> 扫描范围：`app/` 13 个页面 · 24 个 API 路由 · `src/lib/` 33 个核心模块 · `src/db/schema.ts` 13 张表
> 声明：本文所有结论均有文件级证据；虚构演示数据，无真实客户 PII。

---

## 一、系统一句话

**WorkBot = 「AI 只读 + 起草 + 标记，放行永远归人」的异常发票与退款工单协同系统**：确定性自动化承担抄表/算账/对数（02 号裁剪表 Keep 结论），大模型只做「看单据、拟话术」且产出必须过人，单笔超 ¥50,000 强制具名人工审批（FIN-001），红区能力物理不存在。

### 全栈拓扑（真实文件清单）

| 层 | 组件 | 证据文件 |
|---|---|---|
| 入口层 | 工单协同台 `/`、对话工作台 `/chat`、生成式 UI `/studio`、调查引擎 `/investigate`、客服专班 `/multi-agent`、检索实验室 `/rag-lab`、浏览器实验室 `/browser-lab`、尽调研究台 `/research-analyst`、多模态 `/multimodal`、单据抽取 `/extraction`、持久审批流 `/workflows`、老 ERP 仿真 `/sandbox-legacy-erp` | `app/**/page.tsx`（13 页）+ `app/components/TopNav.tsx` |
| API 层 | `/api/tickets(+approve)`、`/api/chat(+approve)`、`/api/generative-ui`、`/api/memory`、`/api/investigate`、`/api/multi-agent`、`/api/rag-lab`、`/api/browser-lab`、`/api/sandbox-legacy-erp/submit`、`/api/research-analyst(+archive)`、`/api/multimodal/forensics`、`/api/voice/*`、`/api/extraction/eval`、`/api/workflows(+decide)`、`/api/inngest`、`/api/mcp/tasks(+[taskId])`、`/api/external-logistics/a2a/*` | `app/api/**/route.ts`（24 路由） |
| 引擎层 | 双模型流式引擎（主备容灾）、对话工具链（4 工具 + dryRun 锁死）、ReAct 调查引擎、四代理专班、防越权混合检索、抓取/预填引擎、尽调三阶段编排、Postgres 状态机 + Inngest 双引擎 | `lib/llm/llm-client.mjs`、`src/lib/chat-engine.ts`、`src/lib/ai/react-agent.ts`、`src/lib/multiagent/*`、`src/lib/raglab/*`、`src/lib/browser-lab/*`、`src/lib/research-analyst/engine.ts`、`src/lib/workflow/*` |
| 数据层 | `intake_requests`（工单）、`approval_audit_logs`（审计·只增不改）、`llm_usage_logs`（用量·只增不改）、`memory_episodes` / `user_preferences`（记忆·可编辑删除）、`agent_traces` / `agent_spans`（追踪·只增不改）、`erp_scraped_invoices`（抓取副本）、`research_reports`（归档·只增不改）、`workflow_runs`（状态机·单点推进）、`workflow_events`（事件·只增不改）、`mcp_tasks`（异步任务） | `src/db/schema.ts` |
| 安全层 | FIN-001 单点判定、PII 确定性脱敏、双向护栏（注入拦截 / PII 泄露）、生成式 UI 组件白名单、入口只增不改触发器 | `src/lib/fin001.ts`、`src/lib/pii-scrubber.ts`、`src/lib/multiagent/guardrails.ts`、`src/lib/genui/catalog-schema.ts` |

---

## 二、需求偏差审计表（契约 vs 实现）

| # | 契约要求（出处） | 实现状态 | 证据与说明 |
|---|---|:---:|---|
| D1 | FIN-001：单笔**超过** ¥50,000 强制人工审批；「等于」不触发（FIN-001 / Q12） | ✅ 达标 | `src/lib/fin001.ts`：`amount > 50000` 严格大于；全站共用单点函数，无副本；文件内无 100000 阈值 |
| D2 | 拆单按合并口径处理并上报（Q13） | ✅ 达标 | `src/lib/ai/react-agent.ts` 探针结论明确含拆单合并口径提示 |
| D3 | 旧版 10 万制度已废止，不得引用（Q16/Q4） | ✅ 达标 | 全库无任何按 100000 阈值放行的逻辑；护栏正则专门拦截「恢复旧 10 万制度」注入（`guardrails.ts` 注入特征库） |
| D4 | 红区物理剔除：无自动打款类工具（CISO 条款 2） | ✅ 达标 | `chat-engine.ts` / `react-agent.ts` 工具注册表只有只读 + dryRun 工具，且带启动自检兜底（禁词「打款/付款/放款」扫描） |
| D5 | 黄区写操作强制 dryRun 预演（04 号 Y1~Y4） | ✅ 达标 | `chat-engine.ts` `dryRunTool`：调用方传什么都不允许落库，只产出 Diff 草稿 + 审批单号 |
| D6 | 审计日志只增不改（R3 / CISO 条款 4） | ✅ 达标 | `approval_audit_logs` / `workflow_events` 等 6 表配数据库触发器物理拒绝 UPDATE/DELETE；代码层无任何 update/delete 入口 |
| D7 | 记忆可被用户编辑/删除 | ✅ 达标（主动豁免） | `memory_episodes` / `user_preferences` **刻意不挂**只增不改触发器（用户遗忘权优先），代码注释已声明边界 |
| D8 | 每日定时只读快照桥接老 ERP（03 号硬约束 3） | ⚠️ 偏差（方向更保守） | 实现为 Day 14 只读 GET 抓取引擎 → 写 WorkBot 自己的 `erp_scraped_invoices` 副本表；无定时文件通道，但「绝不回写老 ERP」红线不降级 |
| D9 | 话术 AI 起草 + 人工确认后发送（02 步骤 12） | ✅ 达标 | 黄区 dryRun 草稿卡 + 审批接口；批准后 UI 变翠绿不可重复点击 |
| D10 | 算术由确定性自动化执行（02 步骤 7） | ✅ 达标 | `workflow_runs.arithmetic_ok`：Σ 数量×单价 vs 申报总额，代码算术不过即 `phase=invalid` 拦截 |
| D11 | Non-Goal #4「不做数据看板」 | ⚠️ 有意偏差 | 特训营教学演示台（`/studio`、`/research-analyst`）含看板，**不进入对客户交付的 V1 范围**；交付口径以 03 号 Non-Goals 为准 |
| D12 | 系统提示词中禁止密钥 / NEXT_PUBLIC 泄露（AGENTS 代码红线 2） | ✅ 达标 | API Key 仅服务端读取（`/api/chat` 服务端 import llm-client）；无 NEXT_PUBLIC_ 密钥前缀 |

> 审计结论：12 项中 10 项严格达标，2 项为「方向更保守」或「教学演示专属」的有意偏差，无一项违反业务红线。

---

## 三、架构决策记录（ADR）

### ADR-001 · 生成式 UI 采用「受控组件目录」而非自由 HTML

- **状态**：已采纳（Day 8 上线）· **证据**：`src/lib/genui/catalog-schema.ts` + `src/components/genui/ComponentRegistry.tsx`
- **背景**：让大模型直接输出 UI 代码 = 把任意 JS 注入高管浏览器；AGENTS.md 明令严禁模型输出原始 HTML/JS。
- **决策**：模型只能输出「白名单组件名 + 受控 Props」的布局 JSON。目录固定 4 大类 16 组件（指标 / 图表 / 表格 / 交互回写）；逐组件 Props 校验器；布局 JSON 含 `<script`、`javascript:`、`onerror=` 注入特征直接服务端 400；未注册组件名温和降级为灰色提示条，每个组件独立 ErrorBoundary。
- **后果**：牺牲表达自由度，换来「模型输出永远不可能执行」的物理保证；新增组件需扩目录 + 写校验器，属于受控演进。

### ADR-002 · 检索权限采用 Pre-filtering ACL（先过滤后打分）

- **状态**：已采纳（Day 13 上线，Day 15 复用）· **证据**：`src/lib/raglab/retrieval.ts`（① ACL 前置过滤优先，越权文档物理跳过）+ `src/lib/raglab/corpus.ts`
- **背景**：若先对全库算相关性再裁剪结果，越权文档的片段仍可能经「语义邻近」泄漏进上下文（软泄露）。
- **决策**：相关性打分**之前**按登录角色过滤文档池——越权文档物理进不了打分管线；已废止制度文件命中只出拦截通报，绝不进引文；`/research` 结论强制校验 `[DOC-XX §X.X]` 引文必须存在于证据集。
- **后果**：索引需按 ACL 维度重建（全语料 IDF + 角色可见池两段），检索成本略增；换来「越权内容在数学上不可达」。

### ADR-003 · 大额审批流采用 Inngest + 代码算术校验的「双引擎同构」状态机

- **状态**：已采纳（Day 18 上线）· **证据**：`src/lib/workflow/engine.ts` + `src/lib/workflow/inngest.ts` + `app/api/workflows/*` + `app/api/inngest/route.ts`
- **背景**：FIN-001 审批窗口最长 7 天，绝不能依赖进程内存挂起；算术校验若交给 LLM 可能被诱导「凑平」（违反 Q6）。
- **决策**：① 状态机函数与编排引擎解耦——postgres（等价演练）与 inngest（真实 Dev Server）调用**同一批函数**，引擎选择失败自动降级并出 notice；② 挂起态只存 `workflow_runs` 行（`suspended_at` / `wait_expires_at`），零定时器，跨重启以 `PROCESS_START_MS > suspended_at` 确定性证明；③ 算术校验是纯代码（Σ qty×price vs 申报总额），不过即步骤 1 红灯 `phase=invalid`，**不进入挂起**；④ 批准幂等（`completeRun` 校验 `phase === "completed"` 时直接返回原凭据，调用方据此回 409，绝不产生第二张凭据），批准后只写审计凭据 + 通知下游，全程零打款动作。
- **后果**：审批流断电不丢、可证明恢复；算术结论 100% 可复现；代价是多一张状态表 + 事件流水表的写入约定。

---

## 四、红线映射速查

| 红线 | 落地点 |
|---|---|
| FIN-001 >¥50,000 | `fin001.ts` 单点 + `/studio` 琥珀卡片 + `/workflows` 强制挂起 |
| 严禁自动打款 | 工具注册表物理无此工具 + 启动自检禁词扫描 |
| 严禁直写正式数据 | 只有只读 GET 抓取 → WorkBot 副本表；提交只进仿真沙盒 |
| 日志只增不改 | 6 张审计/事件表触发器物理拒绝 UPDATE/DELETE |
| Kill Switch | 无常驻定时器/进程内挂起态，切断即停，日志已落库不丢 |
| PII 脱敏 | `pii-scrubber.ts` 确定性正则（fail-closed）+ 展示层统一脱敏 |
| 外来内容隔离 | 注入特征正则拦截（$0 毫秒级）+ 只上报不执行 |

---

*文档版本：v1.0（2026-11-26，Day 20 Checkpoint #1）· 配套：`FEATURE-PROPOSAL-POLICY-ENGINE.md` · 核验：`pnpm midpoint:verify`*
