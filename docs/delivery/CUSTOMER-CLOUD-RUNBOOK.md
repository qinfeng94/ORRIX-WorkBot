# WorkBot v4.0 客户云端盲装 Runbook（15 分钟版）

> 交付版本：v4.0（Checkpoint #2 · Day 37）
> 读者画像：**完全不了解本项目的第三方运维**，只要会装 Docker 和复制粘贴命令即可。
> 目标：15 分钟内完成安装 + 验收。全程零入站网络要求，只读健康检查接口验收。
> 本文所有路径均相对交付包根目录；所有示例数据均为虚构演示内容。

---

## 0. 你要装的是什么（30 秒读完）

WorkBot 是一套「AI 工单预处理工作台」：AI 只负责**读数据、起草草稿、打标记**，
一切付款 / 审批动作永远由人签字放行（内置物理电闸可 5 秒急停）。
交付形态 = 2 个 Docker 容器：`app`（Next.js 应用）+ `db`（Postgres 17，零公网暴露）。
默认**离线高仿真模式**运行：不接任何大模型 API 也能跑通全部功能，无需任何密钥。

---

## 1. 15 分钟装机总览（打勾清单）

| # | 步骤 | 耗时 | 完成标志 |
|:---:|---|:---:|---|
| 1 | 确认机器前置条件 | 1 分钟 | `docker --version` ≥ 24 |
| 2 | 放置交付包、创建 `.env.prod` | 3 分钟 | 密码变量已填 |
| 3 | 构建并启动双容器 | 5~7 分钟 | `docker compose ps` 两个 healthy |
| 4 | 一键验收（§5 复制粘贴） | 2 分钟 | health 返回 `status: ok` |
| 5 | （可选）电闸急停演习 | 2 分钟 | `killSwitch.effectiveOn: true` |

> 时钟走慢了别慌：第 3 步首次构建要下载依赖，属正常；后续重启均为秒级。

---

## 2. 前置条件

- 1 台 Linux/Windows/macOS 机器：**2 核 CPU / 4 GB 内存 / 20 GB 磁盘**；
- 已安装 **Docker 24+ 与 Docker Compose v2**（`docker compose version` 能出版本号即可）；
- **出站 HTTPS** 可用（拉镜像 / 可选调大模型）。**不需要开放任何入站端口**给外界——
  应用端口只绑本机回环 `127.0.0.1:3000`，对外统一走贵司既有反向代理 / 负载均衡；
- 不需要 Kubernetes、不需要 Terraform、不需要注册任何云账号。

---

## 3. 安装步骤（路线 A · Docker 双容器，推荐）

### Step 1 放置交付包

把交付包解压到任意目录（下文以 `/opt/workbot` 为例），进入根目录：

```bash
cd /opt/workbot
ls   # 应看到 Dockerfile / docker-compose.prod.yml / scripts/ 等
```

### Step 2 创建 `.env.prod`（唯一要动脑的一步）

```bash
cat > .env.prod <<'EOF'
# ---- 必填：数据库密码（自己生成一个强密码，别用下面的占位） ----
POSTGRES_PASSWORD=请改成你的强密码

# ---- 选填：物理急停电闸（1=锁死全部 AI 写操作；默认 0） ----
WORKBOT_KILL_SWITCH=0

# ---- 选填：版本可见性（升级脚本自动维护，首次装可不动） ----
WORKBOT_IMAGE=workbot-app:latest

# ---- 选填：大模型密钥（BYOK 自带密钥；不填=离线高仿真，全部功能照常可用） ----
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=

# ---- 选填：跨组织验真令牌 / Inngest 备胎引擎地址 ----
# EXTERNAL_LOGISTICS_A2A_TOKEN=
# INNGEST_DEV_SERVER_URL=
EOF
chmod 600 .env.prod   # 收紧权限，这是唯一的敏感文件
```

要点：**不填任何大模型密钥也能完整验收**（离线高仿真）；`POSTGRES_PASSWORD` 不填时
系统会**直接拒绝启动**（fail-closed，杜绝弱口令上线），这是设计行为不是故障。

### Step 3 构建并启动

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
```

期望：`app` 与 `db` 两行 STATUS 均含 `(healthy)`。首次启动 db 约 10 秒、
app 约 30 秒（容器内置健康检查每 15 秒自动验活，带病容器不会接入流量）。

### Step 4 （可选）暴露给内网用户

应用只监听 `127.0.0.1:3000`。给内网用户访问时，请在**贵司既有反向代理**上
加一条转发规则（如 `http://<本机IP>:3000`）。**不要**直接修改 compose 去开放 `0.0.0.0`。

---

## 4. 安装步骤（路线 B · 无 Docker 的裸机/开发验证）

适用于想先在笔记本上验证再上服务器，或客户环境暂无 Docker：

```bash
pnpm install          # 需 Node 22+ 与 pnpm（corepack enable 即可获得）
pnpm db:start         # 一键拉起本地零配置 Postgres（端口 5433，数据存 .pgdata/）
pnpm dev              # 启动应用（默认 3000 端口；首次访问会自动建表并写入预置演示工单）
```

然后浏览器打开 `http://localhost:3000`，跳到 §5 验收。
想换贵司自有 Postgres（Neon / Supabase 等云库也行）：在 `.env.local` 里把
`DATABASE_URL` 换成连接串即可，**代码零改动，重启生效**。

---

## 5. 一键验收（复制粘贴即可）

### 5.1 容器侧验收（必做）

```bash
# ① 两个容器都 healthy
docker compose -f docker-compose.prod.yml ps

# ② 三大体检一体通过（数据库 + 双模型网关 + 电闸状态）
curl -s http://127.0.0.1:3000/api/health

# ③ 首页可打开（期望输出 200）
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/

# ④ 容器内部自检口径（与 ② 等价，验证不走宿主网络）
docker compose -f docker-compose.prod.yml exec app node -e \
  "fetch('http://127.0.0.1:3000/api/health').then(r=>r.text()).then(t=>console.log(t))"
```

`/api/health` 期望返回（节选，行数数字以实机为准）：

```json
{
  "status": "ok",
  "release": { "image": "workbot-app:latest" },
  "checks": {
    "db": { "status": "ok", "latencyMs": 3 },
    "auditData": { "status": "ok", "approvalAuditLogs": 12, "llmUsageLogs": 40 },
    "llmGateway": { "status": "ok", "providers": ["openai", "anthropic"] },
    "killSwitch": { "effectiveOn": false, "label": "开闸：AI 写操作放行，仍受 FIN-001 强制人工审批红线约束" }
  }
}
```

判定标准：`status` 必须是 `ok`（`degraded` 时 HTTP 码为 503，容器 HEALTHCHECK 也会判不健康）。
`auditData` 两张台账行数是**回滚/升级的「零删库」比对基准**——升级回滚前后只增不减。

### 5.2 电闸急停演习（强烈建议做一次）

```bash
# 1. 合闸：改 .env.prod 里 WORKBOT_KILL_SWITCH=1，然后重启应用容器
docker compose -f docker-compose.prod.yml up -d --force-recreate app

# 2. 验证电闸已合上（期望 effectiveOn: true）
curl -s http://127.0.0.1:3000/api/health | grep -o '"effectiveOn":[a-z]*'

# 3. 演习完毕：把 WORKBOT_KILL_SWITCH 改回 0，再次 force-recreate 即恢复
```

语义：合闸后**所有 AI 写操作（含 Dry-Run 起草）≤1 秒内全部锁死**，
只读与审计日志不受影响——切断不丢日志，这是合同级红线。

### 5.3 代码侧验收（有完整代码仓库时加做）

```bash
pnpm test              # 全量单元/集成测试全绿（用例数以脚本输出为准）
pnpm eval:ci           # 25 题评测门禁全绿
pnpm eval:security     # 红队 20/20：5 大类攻击全部拦截（report 见 data/evals/red-team-report.json）
pnpm day35:gates       # Terraform 安全面 21 项自检全绿
```

---

## 6. 排障表（症状 → 处置）

| # | 症状 | 根因 | 处置 |
|:---:|---|---|---|
| 1 | app 容器启动即退出，日志含 `POSTGRES_PASSWORD` | `.env.prod` 没填密码（fail-closed 拒绝弱口令上线） | 填好密码后 `up -d` 重启 |
| 2 | `/api/health` 返回 503 `degraded`，`db.status: down` | db 未就绪 / 密码不一致 / 连接串错 | `docker compose logs db` 看错误；确认 `.env.prod` 只有一份且密码一致 |
| 3 | `llmGateway.status: down` | 网关自检失败（罕见） | `docker compose logs app` 截取报错联系交付方；离线模式下此检查不依赖外网 |
| 4 | app 反复重启 / `(unhealthy)` | 健康检查未通过 3 次 | 先看 `curl 127.0.0.1:3000/api/health` 返回体，再按 #2/#3 处理 |
| 5 | `curl localhost:3000` 通但别的机器不通 | **设计如此**：端口只绑回环 | 配置贵司反向代理转发，勿改 compose 开 `0.0.0.0` |
| 6 | 端口 3000 被占 | 宿主机已有服务 | 停掉占用方，或临时改 compose 里映射为 `127.0.0.1:3001:3000` |
| 7 | 构建期 `pnpm install --frozen-lockfile` 失败 | 交付包缺 `pnpm-lock.yaml` / `pnpm-workspace.yaml` | 核对交付包完整性；不要自行升级依赖 |
| 8 | 升级后 `/api/health` 版本号没变 | `WORKBOT_IMAGE` 未注入 | 升级请统一走 `bash scripts/pull-upgrade.sh --image <仓库镜像>`，勿手工 `docker run` |
| 9 | 想查数据库 | db 容器**零端口发布**（设计如此） | 用自带通道：`docker compose -f docker-compose.prod.yml exec db psql -U workbot -d workbot` |
| 10 | AI 突然全部「写不动」 | 电闸被合上（`effectiveOn: true`） | 运维有意状态；确认无误后在 `.env.prod` 改回 0 并重启 app |
| 11 | 本地 Windows 跑 standalone 报 MODULE_NOT_FOUND | Windows 拷贝破坏 pnpm 符号链接 | 本地验证必须在 `.next/standalone` **原地**执行；生产走 Docker 不受影响 |
| 12 | 本地 dev 报 drizzle 表 undefined | dev 进程持有旧模块缓存 | 重启 `pnpm dev` 即恢复 |

> 查容器日志统一命令：`docker compose -f docker-compose.prod.yml logs --tail=100 app`（db 同理）。

---

## 7. 升级与回滚（各 1 条命令）

```bash
# 升级（拉取式，零入站 SSH）：先数据库快照 → 镜像验签 → 旁路验活 → 切换，失败自动回滚
bash scripts/pull-upgrade.sh --image registry.example.com/workbot:v4.1 --digest sha256:xxxx

# 回滚演习（90 秒预算，实测约 2 秒；零删库——只换应用镜像，账本一个字节不碰）
pnpm day35:rollback        # 或 bash scripts/rollback-90s.sh
```

细则见 `infra/README-DEPLOY.md`（含 Terraform 三套着陆区与安全三道闸说明）。

---

## 8. 数据库速查（给 DBA 的 1 分钟版）

- 引擎：PostgreSQL 17；连接串由 compose 自动组装，**唯一密码入口是 `.env.prod` 的 `POSTGRES_PASSWORD`**；
- 建表：应用首次请求时**幂等自动建表**（可重复执行），并写入提示词版本种子与演示工单；无需手工跑迁移脚本；
- 表清单（13 张）：工单 `intake_requests` / 审批审计 `approval_audit_logs` / 用量台账 `llm_usage_logs` /
  记忆 `memory_episodes`、`user_preferences` / 代理追踪 `agent_traces`、`agent_spans` /
  尽调归档 `research_reports` / 审批流 `workflow_runs`、`workflow_events` / 长任务 `mcp_tasks` /
  提示词版本 `prompt_versions` / 监控日志 `monitor_logs` / ERP 只读副本 `erp_scraped_invoices`；
- **只增不改**（7 张，数据库触发器物理拒绝 UPDATE/DELETE）：`approval_audit_logs`、`llm_usage_logs`、
  `agent_traces`、`agent_spans`、`research_reports`、`workflow_events`、`monitor_logs`；
  记忆两张表**可编辑删除**（用户有权遗忘，属设计要求）；
- 多租户：业务表带 `tenant_id` 列，所有访问经唯一入口强制过滤；
- 备份：升级脚本每次先 `pg_dump` 快照 + 可恢复性校验，保留 7 份于 `backups/`。

---

## 9. 红线声明（验收时请一并核对）

1. 镜像与代码中**物理不存在**任何「自动打款 / 直写老 ERP」工具——不是隐藏，是没有；
2. 单笔超 ¥50,000 强制人工审批（FIN-001），AI 任何情况下不充当审批人；
3. 审计日志只增不改，由数据库触发器物理保证；
4. 电闸 `WORKBOT_KILL_SWITCH` 可 ≤1 秒锁死全部 AI 写操作，切断不丢日志；
5. 默认离线高仿真模式零密钥运行；密钥只进 `.env.prod`/环境变量，不进镜像、不进日志。
