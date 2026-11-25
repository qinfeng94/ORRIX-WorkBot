# Day4 · 正交原子工单看板（ENG-101 ~ ENG-106）

> 上游真源：`AGENTS.md`（红线）· `03-solution-design.md`（方案）· `04-access-boundary.md`（边界）
> 路径约定：本项目为**无 src 目录结构**，页面代码一律在 `app/`；文中的 `src/app/page.tsx` 统一落地为 `app/page.tsx`。
> 全局约束（每张工单默认生效）：① `pnpm exec tsc --noEmit` 零错误；② 禁 TypeScript `any`；③ 界面文案清晰中文大白话；④ 严禁出现任何「AI 自动打款 / 自动放款」控件或文案；⑤ 测试数据一律虚构。

---

## 一、六张工单总览

| 工单 | 标题 | Allowed Files（白名单） | 正交性 |
|:---:|---|---|:---:|
| ENG-101 | 工单详情抽屉组件 | `app/components/TicketDrawer.tsx` | 独立 |
| ENG-102 | 搜索过滤条组件 | `app/components/TicketSearchBar.tsx` | 独立 |
| ENG-103 | 金额统计顶栏组件 | `app/components/StatsHeader.tsx` | 独立 |
| ENG-104 | 审批历史时间轴组件 | `app/components/ApprovalTimeline.tsx` | 独立 |
| ENG-105 | 四组件统一挂载进首页 | `app/page.tsx` | 集成 |
| ENG-106 | 独立宣传官网初始化 | `../workbot-site/**`（仓库外独立目录） | 独立仓库 |

---

## 二、ENG-101 · 工单详情抽屉组件

- **溯源章节**：03 方案书**第四节**（数据流图②「只读暂存区」→ 判定结果）；权限依据 04 号文档绿区 G1~G4（只读）
- **Allowed Files**：`app/components/TicketDrawer.tsx`
- **Forbidden Files**：`app/page.tsx`、其余三个组件文件、`app/layout.tsx`、`app/globals.css`、`.fde/**`、`.claude/**`、`AGENTS.md`、`package.json`、`tsconfig.json`、`.env*`
- **验收标准**：
  1. 点击任意工单卡片可展开/收起详情，完整展示工单号、部门、金额、摘要、当前状态；
  2. 抽屉内客户姓名、银行账号一律脱敏显示（如 `张*`、`6222 **** **** 1234`），且抽屉内**只有查看**，无任何放款、执行、修改按钮；
  3. `tsc --noEmit` 零错误；组件 Props 类型本地声明，不 import 其他三个组件的任何导出。

## 三、ENG-102 · 搜索过滤条组件

- **溯源章节**：03 方案书**第一节**（MVV 中"一线效率"诉求）；01 号文档王主管沟通策略
- **Allowed Files**：`app/components/TicketSearchBar.tsx`
- **Forbidden Files**：同 ENG-101 清单（含 `app/page.tsx` 与其余三个组件文件）
- **验收标准**：
  1. 输入关键词（工单号/摘要文字）可即时过滤工单列表，无需点按钮；
  2. 「全部 / 运营部 / 财务部 / 客服部」四个标签可独立点击，且与关键词搜索**可叠加**过滤；
  3. 全部文案为中文大白话、无英文占位符；`tsc --noEmit` 零错误且不依赖其他组件导出。

## 四、ENG-103 · 金额统计顶栏组件

- **溯源章节**：03 方案书**第一节**（MVV"林总不点任何东西就能看懂风险"）+ **第三节**（ROI 数字口径）
- **Allowed Files**：`app/components/StatsHeader.tsx`
- **Forbidden Files**：同 ENG-101 清单（含 `app/page.tsx` 与其余三个组件文件）
- **⚠️ 越界警示（对应 Non-Goal 4）**：本组件**只做当前工单列表的数字汇总**（总数、待审批数、超 ¥50,000 金额合计）；**严禁**引入图表库、趋势图、历史报表等任何"数据看板"能力——那是 V1 明确不做清单第 4 条。
- **验收标准**：
  1. 顶栏一行展示：工单总数 / 待审批数 / FIN-001 大额合计金额，数字随筛选联动更新；
  2. 纯只读计算，零新增依赖（不装任何包）；无任何编辑或导出按钮；
  3. `tsc --noEmit` 零错误且不依赖其他组件导出。

## 五、ENG-104 · 审批历史时间轴组件

- **溯源章节**：03 方案书**第二节**（硬约束 2"合规：留痕"）+ **第四节**数据流图⑥；权限依据 04 号文档 CISO 条款 3（具名审批人）、条款 4（审计日志只增不改）
- **Allowed Files**：`app/components/ApprovalTimeline.tsx`
- **Forbidden Files**：同 ENG-101 清单（含 `app/page.tsx` 与其余三个组件文件）
- **验收标准**：
  1. 按时间倒序展示审批事件，每条必须含：具名审批人姓名、审批时间戳、动作描述；
  2. FIN-001 事件（超 ¥50,000 放行）有醒目琥珀色标记；时间轴**只增不改**——界面与逻辑均无删除、编辑历史记录的入口；
  3. `tsc --noEmit` 零错误且不依赖其他组件导出。

## 六、ENG-105 · 四组件统一挂载进首页

- **溯源章节**：03 方案书**第一节**（MVV 整体）+ **第四节**（数据流图整体串接）
- **Allowed Files**：`app/page.tsx`
- **Forbidden Files**：`app/components/TicketDrawer.tsx`、`TicketSearchBar.tsx`、`StatsHeader.tsx`、`ApprovalTimeline.tsx`（**只许挂载传 Props，严禁改动四个组件内部实现**）、`app/layout.tsx`、`app/globals.css`、`.fde/**`、`.claude/**`、`AGENTS.md`、`package.json`、`tsconfig.json`、`.env*`
- **验收标准**：
  1. 四个组件全部挂载：顶栏（103）置顶 → 过滤条（102）→ 卡片列表 + 详情抽屉（101）→ 时间轴（104），布局顺序符合一线操作动线；
  2. FIN-001 判定逻辑（财务部 && 金额 > 50000）保持单点唯一来源，挂载过程不得复制或改写该逻辑；
  3. `tsc --noEmit` 零错误；浏览器全流程回归：筛选 → 搜索 → 开抽屉 → 点「林总批准放行」→ 状态变翠绿「已批准」→ 时间轴出现新事件，与拆分前行为一致。

## 七、ENG-106 · 独立产品宣传官网（仓库外）

- **溯源章节**：03 方案书**第一节**（MVV 对外表达）；本工单是**工作区之外**的独立交付物，不进入 WorkBot V1 代码库
- **Allowed Files**：`D:\Users\frankfeny\Desktop\workbot-site\**`（全新独立目录、独立仓库）
- **Forbidden Files**：`ORRIX WorkBot` 仓库内**一切文件**（严禁为官网改动 V1 任何代码）；严禁在官网写入任何真实客户数据、真实 PII、真实金额
- **⚠️ 红线警示**：官网文案**严禁**出现"AI 自动打款 / 无人值守放款 / 5 秒到账"类承诺（Non-Goal 1 + 红区禁令）；对外表述统一为"智能辅助 + 具名人工审批"
- **验收标准**：
  1. 独立目录含独立 `package.json`，与 WorkBot 仓库零文件交集，可单独构建运行；
  2. 全站文案经红线自查：无自动打款承诺、无真实数据、测试内容全虚构；
  3. `tsc --noEmit`（或等价构建检查）零错误，本地可打开预览。

---

## 八、正交性体检（ENG-101 ~ 104 文件路径矩阵）

| 组件文件 | 101 | 102 | 103 | 104 | 105 |
|---|:---:|:---:|:---:|:---:|:---:|
| `app/components/TicketDrawer.tsx` | ✏️ | 🚫 | 🚫 | 🚫 | 🚫 |
| `app/components/TicketSearchBar.tsx` | 🚫 | ✏️ | 🚫 | 🚫 | 🚫 |
| `app/components/StatsHeader.tsx` | 🚫 | 🚫 | ✏️ | 🚫 | 🚫 |
| `app/components/ApprovalTimeline.tsx` | 🚫 | 🚫 | 🚫 | ✏️ | 🚫 |
| `app/page.tsx` | 🚫 | 🚫 | 🚫 | 🚫 | ✏️ |

✏️ = 允许改动 · 🚫 = 严禁触碰。**101~104 白名单两两零交集**；隔离手段：Props 类型在各组件文件内本地声明，互不 import。

## 九、反越界体检（对照 03 号方案书第五节 Non-Goals）

| Non-Goal | 体检结论 |
|---|---|
| 1. 不做无人值守全自动付款 | ✅ 六张工单均无自动打款控件；ENG-106 文案红线已写死"智能辅助 + 具名人工审批" |
| 2. 不改动 15 年老 ERP | ✅ 无任何工单触碰 ERP 或取数链路 |
| 3. 不做客户自由对话机器人 | ✅ 无对话类工单 |
| 4. 不做数据看板 | ✅ ENG-103 明确限定为"当前列表数字汇总"，禁止图表库与趋势图，越界警示已写入工单 |
| 5. 不做绕过审批的加急通道 | ✅ ENG-104/105 均强化具名审批与只增不改约束，无任何加急路径 |

**体检结论：六张工单零越界，全部放行开工。**

---

*文档版本：v1.0（2026-11-25，Day 4）· 执行顺序建议：101/102/103/104 可并行 → 105 集成回归 → 106 独立进行*
