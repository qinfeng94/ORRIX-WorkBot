# WorkBot 部署与回滚说明书（小白版）

> 本文档只回答三个问题：**部署到哪？安全怎么保证？出了问题怎么 90 秒退回去？**
> 全程人话 + 图，不要求你懂云，也不要求你懂 Kubernetes。

---

## 一、三套着陆区：你要把 WorkBot 放在哪？

「着陆区（Landing Zone）」可以理解成**给 WorkBot 精装修好的、带门禁的机房**。
我们准备了三套户型，里面装的东西一样，水电（安全门禁）统一验收：

```
                    你要把 WorkBot 部署到哪？
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
  ① 电脑 / 私有云 K8s        ② AWS 客户账号            ③ GCP 客户账号
  environments/             environments/             environments/
  local-k8s                 aws-landing-zone          gcp-landing-zone
  ─────────────────         ─────────────────         ─────────────────
  kind / minikube /         VPC + 私有子网            VPC-SC 服务边界
  私有 Kubernetes           + RDS 数据库(锁内网)       + Cloud SQL(无公网IP)
  ClusterIP 零公网          + CloudWatch(KMS加密)     + 日志桶(CMEK加密)
  local:// 演习密钥         KMS 密钥 ARN              CMEK 密钥路径
```

| | ① local-k8s | ② aws-landing-zone | ③ gcp-landing-zone |
|---|---|---|---|
| 适合 | 自己电脑演练 / 客户私有云 | 客户要求用 AWS | 客户要求用 GCP + 强隔离 |
| 数据库 | 集群外自备（本地 Postgres） | RDS，公网物理关闭 | Cloud SQL，公网 IP 不分配 |
| 日志加密 | local:// 演习密钥 | CloudWatch + KMS | Cloud Logging 桶 + CMEK |
| 额外亮点 | 零云账号就能跑 | 审计归档桶（公网阻断） | VPC-SC 数据护城河（可选启用） |

**目录结构**（都在 `infra/terraform/` 下）：

```
infra/terraform/
├── modules/
│   ├── security-gates/     ← 统一安全门禁（三道闸，三套环境共用同一份）
│   └── workbot-app/        ← 应用部署模板（K8s 版，探针直连 /api/health）
└── environments/
    ├── local-k8s/          ← 环境①：main.tf + outputs.tf + terraform.tfvars.example
    ├── aws-landing-zone/   ← 环境②：同上
    └── gcp-landing-zone/   ← 环境③：同上
```

---

## 二、安全三道闸：所有环境统一过同一道安检

三套环境共用 `modules/security-gates` 里的**同一份门禁规则**（单一真源）。
想「裸奔」？`terraform plan` 阶段直接报错终止——是**代码物理拦截**，不是口头劝阻。

| 闸门 | 规则 | 违规下场 |
|:---:|---|---|
| **GATE-1** | 子网必须是 RFC1918 私有网段（10.x / 172.16-31.x / 192.168.x），且至少 2 个跨可用区 | 公网网段子网 → plan 直接终止 |
| **GATE-2** | 数据库公网开关只认 `false` | 写 `true` → plan 直接终止（AWS 资源层还再硬编码一次 `publicly_accessible = false` 双保险） |
| **GATE-3** | 日志必须挂加密密钥（AWS KMS ARN / GCP CMEK 路径 / local:// 演习密钥，三选一） | 缺钥、裸路径 → plan 直接终止 |

**没装 Terraform 也能验收门禁**——项目自带零依赖自检（内含 6 道反例考卷：
公网网段、单子网、非法 CIDR、公网开关、假密钥、合法对照组）：

```bash
pnpm day35:gates        # 全绿 = 21 项全过，审计追加到 data/day35/gates-checks.jsonl
```

**统一变量声明**：三套环境用同一套变量名，换环境不用重新学——
`project_name` / `environment` / `private_subnet_cidrs` / `database_publicly_accessible` / `log_encryption_kms_key_ref`。
每个环境里多出来的变量都是它自己的「方言」（比如 AWS 的 `aws_region`）。

上手步骤（以 AWS 为例，①③同理）：

```bash
cd infra/terraform/environments/aws-landing-zone
cp terraform.tfvars.example terraform.tfvars   # 改成你的真实值（密钥别写进来！）
terraform init
terraform plan      # ← 门禁在这里过闸；任何一道闸不过，走不到下一步
terraform apply
```

> 密钥纪律：`terraform.tfvars` 已被 gitignore，数据库密码只走环境变量 / 密钥管理通道，
> 永远不进代码、不进文档、不进日志。

---

## 三、零删库回滚 4 步流程（重点！）

先说清一个比喻：

- **应用镜像 = 电视机的软件版本号**，回滚 = 把版本号换回上一个，电视还是那台电视；
- **业务数据库 = 会计的账本**，工单、客户、审批记录全在里面，**回滚永远不碰账本**。

```
   回滚只动这一层                       这些永远不动（零删库）
 ┌─────────────────────────┐        ┌──────────────────────────────┐
 │  应用容器（镜像版本号）     │        │  业务数据库（工单/客户/审批）    │
 │  workbot:v4.0.35-bad    │        │  审计台账 approval_audit_logs │
 │        │ 换成            │        │  用量台账 llm_usage_logs      │
 │        ▼                │        │  记忆表 memory_episodes       │
 │  workbot:v4.0.34-good   │        │  （回滚前后行数只增不减）        │
 └─────────────────────────┘        └──────────────────────────────┘
```

### 4 步流程图（90 秒预算）

```
┌───────────────────────────── 90 秒无损回滚 · 4 步 ─────────────────────────────┐
│                                                                              │
│ ① 停闸体检              ② 只换镜像              ③ 验活                ④ 出报告  │
│ ┌───────────────┐   ┌───────────────┐   ┌───────────────┐   ┌─────────────┐│
│ │ 📸 给数据拍指纹 │ → │ 🔄 只换版本号   │ → │ 🩺 轮询        │ → │ 📒 流水入台账 ││
│ │ 记下台账行数    │   │ 数据库零触碰   │   │ /api/health   │   │ JSONL 只增不改││
│ └───────────────┘   └───────────────┘   └───────────────┘   └─────────────┘│
│  约 2 秒               约 1 秒              ≤80 秒轮询           约 1 秒       │
│                                                                              │
│  超过 90 秒没验活通过？→ 判失败退出，提示人工介入（Kill Switch 5 秒可切断）        │
└──────────────────────────────────────────────────────────────────────────────┘
```

**第 1 步 · 停闸体检**：先给业务数据「拍个指纹」——调 `/api/health` 记下审批台账、
用量台账的**行数**。这不是备份，只是记个数，用来回滚后比对。

**第 2 步 · 只换镜像**：把应用版本号退回上一版。K8s 用 `kubectl rollout undo`
（官方标准回退），本地演习用状态文件对调。**数据库、审计台账、记忆表一个字节都不碰。**
脚本启动时还会自证清白：全文检索自己，物理不含任何破坏性数据语句（有就当场自杀退出）。

**第 3 步 · 验活**：轮询 `/api/health`（只读体检接口），三关全过才算活——
① 状态 `ok`；② 版本号已经退回旧版（肉眼可见，`release.image` 字段）；③ **台账行数
没有比第 1 步少**（少了 = 数据被删过，立刻报警）。超过 90 秒没过 → 判失败，
提示人工介入，绝不硬凑「成功」。

**第 4 步 · 出报告**：把这次回滚（时间、模式、退到哪版、用时、数据行数）追加进
`data/day35/rollback-logs.jsonl`。**只增不改**——历史流水永不覆盖。

### 怎么跑演习

```bash
# 本地演习（默认）：先启动 pnpm dev，然后：
pnpm day35:rollback
# 等价于 bash scripts/rollback-90s.sh

# 真实 K8s 环境：
bash scripts/rollback-90s.sh --target k8s --namespace workbot
```

本地演习模式说明：没有真的容器可换，所以用 `data/day35/deploy-state.json`
模拟「当前版本 / 上一版」对调——但**验活是真的**：`/api/health` 会真实回读这个文件，
版本号退没退回去、数据少没少，全都看得见。首次运行自动摆出一个「坏版本」
`v4.0.35-bad` 供你退回 `v4.0.34-good`；再跑一次会对调回去（演习一来一回）。

实测成绩：**2 秒完成**（预算 90 秒），台账 18→18 行、40→40 行，零删库。

### 和 Day 34「拉取式升级」是什么关系？

```
 升级（pull-upgrade.sh）                     回滚（rollback-90s.sh）
 ──────────────────────                    ─────────────────────
 升级失败时的自动回滚是「保险丝」，            本脚本是「消防演习」：
 平时不用你动手；                            平时主动练，真出事时按肌肉记忆执行。
 走容器切换 + 影子容器验活。                  走 K8s 标准回退 / 本地状态演习。
 两者共用同一个验活入口 /api/health 和同一个铁律：零删库。
```

---

## 四、红线声明（每一行都不可谈判）

- 回滚只退**应用镜像**，业务数据零删除：脚本物理不含破坏性数据语句（启动时自证）；
- 审计台账（`rollback-logs.jsonl` / `gates-checks.jsonl`）**只增不改**，永不覆盖；
- `/api/health` 全程只读，是升级、回滚、容器 HEALTHCHECK 三方共用的唯一验活口径；
- 数据库公网暴露、日志不加密，在任何一套环境都过不了 plan（物理门禁，非口头约定）；
- 任何时刻可 5 秒内人工切断（Kill Switch），切断不丢日志。
