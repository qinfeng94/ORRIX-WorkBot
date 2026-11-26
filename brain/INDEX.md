# WorkBot 公司大脑 · 总目录（brain/INDEX.md）

> 定位：跨工具共享的结构化知识卡索引。每张卡 ≤200 行、可独立检索、自带出处。
> 用法：AI 编程助手**按需检索单张卡**，不要整目录读入上下文。
> 冲突裁决：`AGENTS.md` > 本目录 > 其他文档。卡片内容与代码不一致时，以代码为准并回写修正卡片。

## 卡片清单

| 卡片 | 主题 | 何时读 | 一句话结论 |
|---|---|---|---|
| [DOMAIN-XINGCHEN.md](./DOMAIN-XINGCHEN.md) | 星辰业务规则 | 改任何涉及金额/审批/权限/数据的代码前 | AI 只读+起草+标记，放行永远归人；FIN-001 超 ¥50,000 严格大于才触发 |
| [USAGE.md](./USAGE.md) | 使用指南 | 要更新卡片或新增规则时 | 按需更新单卡 + 登记索引；废弃不删文件只改状态 |
| [ADR-001.md](./ADR-001.md) | 生成式 UI 受控组件目录 | 动 `/studio`、`genui/`、任何「让模型出 UI」的需求 | 模型只出白名单组件名+受控 Props 的布局 JSON，永不输出原始 HTML/JS |
| [ADR-002.md](./ADR-002.md) | 检索 Pre-filtering ACL | 动 `/rag-lab`、`/research-analyst`、任何检索权限逻辑 | 先按角色过滤文档池再打分，越权内容在数学上不可达 |
| [ADR-003.md](./ADR-003.md) | 大额审批双引擎状态机 | 动 `/workflows`、`src/lib/workflow/*` | 挂起只存 DB 行零定时器，算术纯代码校验，批准幂等零打款 |
| [ADR-004.md](./ADR-004.md) | 统一推理入口 `src/lib/workbot/` 收口设计 | 动任何 AI 编排/对话路由、新增页面接引擎前 | 新路由只准走 `workbot/facade` 门面；LLM 调用/重试/SSE 信封/红线挂点全项目唯一实现，禁止路由直连 |
| [ADR-005.md](./ADR-005.md) | **AI 时代架构宪章（Harness Engineering，Day 26）** | 改业务规则阈值/汇率/区域条款、加新工具、拆大文件、改评测门禁前 | 规则外置到 `config/approval-policies.json`、对话工具只留 3 个业务意图、文件 150~400 行、25 题 `pnpm eval:ci` 全绿才准合入 |
| [BENCHMARK-ORCHESTRATION.md](./BENCHMARK-ORCHESTRATION.md) | 编排基准评估（Day 23） | 评估要不要引入编排框架、或动 E1~E7 引擎前 | 用户在等的活用原生轻编排（快/透明/红线攥手里），跨重启持久化才用 Inngest；收口决定见 ADR-004 |

## 按场景检索

- **改金额/审批逻辑** → DOMAIN-XINGCHEN.md §FIN-001 + ADR-003.md；注意：此类改动须先改 `.fde/` 契约并三人签字
- **改生成式 UI / 新增组件** → ADR-001.md（16 组件白名单、Props 校验器、ErrorBoundary、`Math.max(...values, 1)` 防 NaN）
- **改检索/RAG/引文** → ADR-002.md（`[DOC-XX §X.X]` 引文必须存在于证据集，注意方括号前缀）
- **改工作流/挂起/批准** → ADR-003.md（幂等 409、`workflow_runs` 单点推进、事件流水只增不改）
- **新增页面接 AI / 改编排入口** → ADR-004.md（只准走 `src/lib/workbot/facade`，禁止路由直连 llm-client）+ BENCHMARK-ORCHESTRATION.md
- **改审批阈值 / 汇率 / 区域条款，或加工具、拆大文件** → ADR-005.md（规则外置 `config/approval-policies.json`、3 个业务意图工具、`pnpm eval:ci` 25/25 全绿才合入）
- **排障经验** → DOMAIN-XINGCHEN.md §排障速查（drizzle 缓存重启、React 19 setState-in-effect、残留 dev 进程）

## 上游文档（权威源，不在本目录）

- 业务契约：`.fde/01~05`（01 需求 · 03 方案设计+Non-Goals · 04 权限边界 · 05 验收考卷 20 题）
- 全栈白皮书：`docs/architecture/WORKBOT-PRODUCTION-ARCHITECTURE.md`（Day 20，含偏差审计表 D1~D12）
