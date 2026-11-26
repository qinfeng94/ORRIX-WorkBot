# BENCHMARK-ORCHESTRATION.md —— 编排基准评估（Day 23）

> 定位：梳理全项目 AI 编排现状，用大白话对比「原生轻编排 vs 重型框架」，并给出收口结论。
> 溯源：本卡基于 2026-11-26 对实际代码的逐文件扫描（文末附证据清单），不是理论空谈。
> 结论效力：收口决定已立卡 [ADR-004.md](./ADR-004.md)；本卡只负责「为什么」。

## 一句话结论

**本项目选原生轻编排是对的，重型框架（Inngest）只留在跨重启持久化这一个它真正能打的场景；调试难度、首字延迟、可控性三个维度原生全胜，代价是「散」——所以下一步不是换框架，而是收口成统一门面（ADR-004）。**

---

## 1. 现状盘点：项目里到底有几个"大脑"

| 编号 | 引擎文件 | 谁在用（路由/页面） | 编排方式 | 用不用 LLM | 防死循环上限 |
|---|---|---|---|---|---|
| E1 | `src/lib/ai/react-agent.ts` | `/api/investigate`、`/multiagent/pipeline` 复用 | 原生 ReAct 循环（思考→行动→观察），**确定性规划器** | ❌ 零 LLM | maxSteps=8 物理熔断 |
| E2 | `src/lib/chat-engine.ts` | `/api/chat`、`/api/voice/tools` | 原生工具循环（绿/黄区工具注册表 + Dry-Run） | ✅ LLM 在路由层调 | maxSteps=6 |
| E3 | `src/lib/multiagent/pipeline.ts` | `/api/multi-agent` | 原生多代理流水线（内部复用 E1） | ✅ | 复用 E1 上限 |
| E4 | `src/lib/research-analyst/engine.ts` | `/api/research-analyst` | 原生三阶段编排（检索→快照→交叉核对） | ✅ 路由直连 | SSE 事件序固定 |
| E5 | `src/lib/workflow/engine.ts` + `inngest.ts` | `/api/workflows`、`/api/mcp/tasks` | **双引擎**：postgres 状态机（原生）vs Inngest（重型框架，可一键降级） | ❌ | 挂起存 DB 行，零定时器 |
| E6 | `src/lib/raglab/retrieval.ts` | `/api/rag-lab` | 原生检索（Pre-filtering ACL） | ❌ | 不适用 |
| E7 | `src/lib/browser-lab/*` | `/api/browser-lab` | 原生抓取/预填引擎（内置物理断点） | ❌ | TTL 暂停会话 |

大白话：项目里有 7 个各干各的"小脑"，其中 2 个要调用大模型说话，其余全是确定性代码（不用 AI、结果可复现）。

## 2. 散装现状的四个重复点（收口的动机）

| 重复点 | 具体表现 | 风险 |
|---|---|---|
| LLM 调用出口 | `chat`、`research-analyst`、`architecture-hub/examiner` 三个路由**各自直接 import** 根目录 `lib/llm/llm-client.mjs` 的 `streamChat` | 换模型/改计费口径要改三处，漏一处就口径分裂 |
| 超时重试策略 | 三套各自实现：E4 `resilientFetch`（400ms 超时→重试 2 次→降级缓存）、A2A 客户端（2500ms 熔断+2 次开熔断冷却 30s）、llm-client 主备秒切 | 同一家外部服务，三种"等多久算超时"的答案 |
| SSE 事件格式 | 5 套各自定义的事件类型（Investigate/Chat/MultiAgent/BrowserLab/Research），字段名、事件序互不相同 | 前端每接一个新页面就要重学一套"暗号" |
| FIN-001 大额判断 | 公共函数 `fin001.ts` 已收口（✅ 好样本），但 E1 结论构建里又手写了一遍 `> 50000` 判断 | 红线逻辑出现第二份拷贝，改制度时容易漏 |

注：PII 脱敏（`pii-scrubber.ts`）和审批人校验（`fin001.ts`）是已收口的好样本，E1 的重复是唯一漏网。

## 3. 大白话对比表：原生轻编排 vs 重型框架

判定标准来自本项目最在乎的三件事：出问题好不好查、用户等多久看到第一个字、红线守不守得住。

| 维度 | 原生轻编排（本项目 E1~E4、E6~E7 的做法） | 重型框架（Inngest 等编排平台，本项目 E5 备用引擎） | 本项目实测证据 |
|---|---|---|---|
| **调试难度** | ✅ 赢。代码就是全部逻辑，断点打在哪就停在哪；E1 的每一步思考/行动/观察都通过 emit 对外直播，出问题一眼看到第几步歪的 | ❌ 框架偷偷帮你做了调度、排队、重试，"为什么这步没跑"要去框架自己的后台翻日志；本地还得额外起一个 Dev Server（8288 端口）才能看 | E1 全程 SSE 直播 thought/action/observation；Inngest 路径需要 `npx inngest-cli dev` 且 SDK v4.27 API 与文档不一致（createFunction 两参数、devServerUrl 选项已删），踩坑成本真实发生过 |
| **首字延迟** | ✅ 赢。没有中间商，路由拿到请求直接进循环，第一个字/第一个事件立刻吐给前端；离线高仿真模式下几乎零等待 | ❌ 多一跳：事件先落库 → 框架服务器领任务 → 再执行 → 再回写状态；对"用户盯着屏幕等回复"的对话场景是纯开销 | `/api/chat` 用 streamChat 直推 text_delta，TTFT 在路由内实测记录进 llm_usage_logs；Inngest 路径天然是异步任务队列，本来也不是为"秒回"设计的 |
| **可控性（红线守卫）** | ✅ 赢。红区工具"物理不存在于注册表"是写在自家代码里的，启动自检不过直接抛错拒启动；maxSteps、dryRun 强制覆盖都是自己的一行代码 | ⚠️ 半赢。持久化/重试/断点续跑这类"底层脏活"框架确实更专业（Day 18 跨重启审批挂起就是靠它）；但框架的自动重试与本项目"宁可转人工绝不硬凑"的原则有天然张力，重试策略必须逐项审 | E1 模块加载即红区自检；恶意 `dryRun: false` 被执行层物理覆盖；FIN-001 拆单合并口径手写在确定性代码里，不走 LLM 猜 |
| **部署/环境负担** | ✅ 零外部依赖，pnpm dev 就能跑 | ❌ 多一个常驻进程 + 一套事件表语义 | Day 18 为 Inngest 专门加了 pnpm-workspace.yaml 的 protobufjs 构建白名单 |
| **跨重启持久化** | ⚠️ 弱项：要自己设计"挂起只存 DB 行、零定时器、进度=时间的确定性函数"这类状态机纪律 | ✅ 这是重型框架真正能打的唯一场景，框架替你管断点续跑 | 本项目 E5 的 postgres 引擎用"挂起存 DB 行"证明了原生也能做对，所以 Inngest 只是备胎而非必需 |
| **适合的场景** | 请求-响应型对话、调查、检索、生成 UI（用户在等） | 长时间后台任务、需要跨重启续跑的审批流（没人在等） | E5 双引擎同构设计 = 两种场景各用各的 |

一句话总结这张表：**用户在等的活用原生（快、透明、红线攥在自己手里），用户不等且可能跨重启的活才考虑重型框架（帮你看住断点）。**

## 4. 三个维度的量化小结（本项目口径）

- **调试难度**：原生路径排障 = 读自家代码 + 看自家 SSE 日志（已发生过 3 次实测排障：drizzle 缓存重启、Fast Refresh 死循环、水合失败，全部原生路径定位）；Inngest 路径额外引入 SDK 版本差异 + Dev Server 状态两类新故障源。
- **首字延迟**：原生直推 SSE，TTFT 由 llm-client 精确计时落台账；Inngest 异步队列不计入对话 TTFT 竞赛——不是输，是根本不该上场。
- **可控性**：红线四件套（红区物理剔除、maxSteps 熔断、dryRun 强制、FIN-001 确定性判断）全部以代码硬约束落地在原生层；框架层只允许承担"不会替你做业务决定"的纯管道职责。

## 5. 收口决定（指向 ADR-004）

1. **不引入更多重型框架**（Non-Goals：不评估 LangGraph/LlamaIndex 等，V1 编排栈冻结为"原生 + Inngest 备胎"）。
2. **新建 `src/lib/workbot/` 统一推理门面**：所有页面/路由以后只准从这一个入口进核心引擎，LLM 调用、超时重试、SSE 事件信封、FIN-001/PII 挂点全部收口到门面后面（接口设计见 ADR-004）。
3. **存量 7 个引擎不推倒重写**：门面只包外壳不动内核，按"新页面强制、旧路由灰度"迁移。
4. **E1 的手写 50000 列为首个整改点**：迁移时改用 `fin001.ts` 公共函数，消灭红线第二份拷贝。

## 证据清单（本卡溯源）

- E1~E7 引擎文件与路由映射：`app/api/*/route.ts` import 逐个核实（2026-11-26）
- 三处直连 LLM：`app/api/chat/route.ts:44`、`app/api/research-analyst/route.ts:22`、`app/api/architecture-hub/examiner/route.ts:17`
- E1 熔断与红区自检：`src/lib/ai/react-agent.ts`（MAX_STEPS=8、RED_ZONE_BANNED_WORDS 启动自检、buildConclusion 手写 50000）
- 双引擎降级：`src/lib/workflow/inngest.ts`（SDK v4.27 差异与降级 notice）
- 三套重试：`src/lib/research-analyst/engine.ts` resilientFetch / `src/lib/multiagent/a2a-client.ts` 熔断器 / `lib/llm/llm-client.mjs` 主备切换
