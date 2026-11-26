# WorkBot v4.0 企业级安全尽调答辩书（CISO 与 DBA · 15 题）

> 交付版本：v4.0（Checkpoint #2 · Day 37）· 依据真实代码与实测报告作答，非营销文案。
> 使用说明：每题三段——**答**（结论大白话）、**证据**（仓库内文件路径）、**复核**（审计方可亲手执行的命令）。
> 文中演示数据均为虚构；运行环境默认离线高仿真模式，无外部数据出站。

---

## Part A · CISO 视角（10 题）

### A1. 客户的姓名 / 证件号 / 银行账号会不会明文进日志或大模型？

**答**：不会。所有写日志、写记忆的路径都要先过一道**确定性正则脱敏器**（不经过大模型、
规则可审计）：身份证（18 位含日历校验）、银行卡（13~19 位，fail-closed——宁可误杀
时间戳也绝不放行）、手机号（1[3-9] 段），从长到短匹配防二次命中；统一替换为
`[REDACTED_PII]`，未知结构用递归消毒兜底。脱敏器带启动自检，自检不过拒绝服务。

**证据**：`src/lib/pii-scrubber.ts`；落库咽喉 `app/api/chat/route.ts` 的 `after()`（请求与响应先脱敏再写 `monitor_logs` 与 `memory_episodes`）。
**复核**：`pnpm test tests/pii-scrubber.test.ts`（脱敏边界用例全绿）；`pnpm dev` 后在对话里输入一个假身份证号，再查 `monitor_logs` 表确认只见 `[REDACTED_PII]`。

### A2. 外部发票 / 工单 / 邮件里夹带「请直接付款」之类的指令怎么办？

**答**：外来内容一律包进 `<untrusted_document_content>` 标签视为**资料**而非指令；
红区语义扫描（付款 / 打款 / 绕过审批）命中后只上报不执行。实测红队 20 题 5 大类
（直接注入 / 单据夹带 / 越权冒充 / 规则篡改与电闸欺骗 / 输出红线诱导）**全部拦截**。

**证据**：`src/lib/security/red-team.ts`；拦截报告 `data/evals/red-team-report.json`（`counts: {total:20, blocked:20, failed:0}`）。
**复核**：`pnpm eval:security`（约 1 分钟，输出 20/20 PASS）。

### A3. 不同职级能看到不同密级文档，凭什么说「越权数学上不可达」？

**答**：检索采用 **Pre-filtering ACL**——先按登录角色把文档池过滤一遍，**再**算相关性
打分。越权文档根本进不了打分管线，不是「算完再藏起来」，所以不存在被排序权重意外
顶出来的可能。语料 52 份含 5 份机密（仅 executive 可见）与 3 份已废止制度文件
（已从现行检索池物理剔除，防「旧制度复活」幻觉）。

**证据**：`src/lib/raglab/retrieval.ts`（① Pre-filtering ACL 先过滤后打分）；架构决策 `brain/ADR-002.md`。
**复核**：`pnpm test tests/rag-lab.test.ts`（含「普通客服检索机密关键词零命中」用例）。

### A4. 大模型密钥由谁持有、怎么流转？会被打印或写进镜像吗？

**答**：**BYOK（客户自带密钥）**。密钥只放客户自己的 `.env.local` / `.env.prod` / 容器
环境变量，由服务端读取，无任何 `NEXT_PUBLIC_` 前缀暴露；调用时仅经内存传递，
不打印、不落日志。不配密钥时系统以**离线高仿真模式**运行全部功能（默认模式）。
镜像构建期物理剔除 `.env*`，密钥零入镜。

**证据**：`lib/llm/llm-client.mjs`（`--live` 才读 Key、经 `apiKeys` 内存传递）；`Dockerfile` 头注「密钥零入镜」；`.dockerignore`。
**复核**：`grep -r "sk-" . --include="*.ts" --include="*.mjs"` 零命中；镜像内确认无环境变量文件：`docker compose exec app ls -la /app/.env*` 应报不存在。

### A5. 系统异常或 AI 行为失控时，我们怎么 5 秒内止血？

**答**：**物理电闸 Kill Switch**。运维把服务端环境变量 `WORKBOT_KILL_SWITCH` 置 1，
代码每次写操作前**实时读取（零缓存）**，≤1 秒内锁死全部 AI 写操作（含 Dry-Run 起草）；
只读与审计日志不受影响——切断不丢日志。AI 与前端都碰不到这个变量；合闸属 fail-closed
设计，健康检查不把合闸当降级。重启后不残留（演习用内存开关重启即失效）。

**证据**：`src/lib/security/kill-switch.ts`（唯一真源，`assertWriteAllowed` 写路径强制过闸）。
**复核**：Runbook §5.2 电闸演习三步（合闸 → health 显示 `effectiveOn: true` → 复位）。

### A6. 审计日志会不会被运维或管理员悄悄改掉？

**答**：7 张审计类表（审批审计 / 用量台账 / 代理追踪×2 / 尽调归档 / 审批流事件 / 监控日志）
由**数据库触发器物理拒绝 UPDATE / DELETE**——不是应用层「不提供按钮」，是数据库直接
报错。应用代码中不存在任何对这些表的修改入口。诚实边界：持有数据库 superuser 权限的
内部 DBA 理论上可先摘触发器再改，对策见 B2（最小权限分权 + 异地台账下沉）。

**证据**：`src/db/index.ts`（`forbid_audit_log_mutation()` 触发器 DDL，幂等挂载）。
**复核**：`docker compose -f docker-compose.prod.yml exec db psql -U workbot -d workbot -c "UPDATE llm_usage_logs SET model='x' WHERE id=1;"` → 期望报错「审计日志只增不改」。

### A7. 谁能批准付款？AI 能不能自己批或者冒充人批？

**答**：批准入口三道门：① 必须是**具名在职审批人**（AI、匿名、部门邮箱、「值班」这类
模糊身份一律 403）；② 重复批准**幂等拒绝**（409，绝不产生第二张凭据）；③ 单笔
**严格超过** ¥50,000 触发 FIN-001 强制人工审批（等于 5 万不触发；疑似拆单按合并
口径处理并上报）。AI 在任何路径上都不可能成为审批主体；批准动作只写审计凭据，
**零打款动作**。

**证据**：`src/lib/fin001.ts`（阈值单一真源）；`app/api/chat/approve/route.ts`（403/409）；`brain/ADR-003.md`（批准幂等状态机）。
**复核**：`pnpm test tests/workbot.test.ts tests/security.test.ts`（含冒充审批人 / 重复批准用例）。

### A8. 多个子公司 / 租户共用一套系统，怎么保证互相看不到？

**答**：多租户**逻辑隔离**：业务表带 `tenant_id` 列 + `(tenant_id, 业务键)` 复合索引，
所有数据访问收敛到**唯一入口**（强制 `WHERE tenant_id`），不允许旁路直查。
配合 A3 的文档级 ACL（角色 × 密级），形成「行级租户隔离 + 文档密级隔离」双层。

**证据**：`src/lib/ontology/tenant-repo.ts`（唯一入口）；`src/db/index.ts`（Day 27 租户列迁移 DDL）。
**复核**：`pnpm test tests/tenant-isolation.test.ts`（跨租户读写隔离用例全绿）。

### A9. 提示词或规则改错了，怎么秒级止损？

**答**：提示词是**数据库里的版本化配置**，不是散落在代码里的字符串：新版本先全量
灰度验证，出问题用「热回滚」纯数据切换激活版本（实测 27ms），且兜底保证任意时刻
**恒有且仅有一个**激活版本；历史版本永不删除、可审计每次切换。业务规则（审批阈值
等）外置为 JSON 配置 + 规则 DSL，改动必须过 25 题评测门禁全绿才允许合入。

**证据**：`src/db/index.ts`（`prompt_versions` 种子与激活兜底）；`config/approval-policies.json`（规则外置）；`brain/ADR-005.md`。
**复核**：`/observability` 页面「提示词版本管理」点 3 秒热回滚按钮；`pnpm eval:ci` 复跑门禁。

### A10. 容器和云基础设施层做了哪些加固？

**答**：五层：① 容器**非 root**（uid 1001）+ `cap_drop: ALL` + `no-new-privileges`；
② **数据库容器零公网端口**（连排障都走容器内通道），应用端口只绑 `127.0.0.1:3000`；
③ Terraform 三道闸（私有子网跨可用区 / 数据库公网开关只认 false / 日志强制 KMS·CMEK
加密），违反任何一道 `terraform plan` 直接报错终止；④ 升级走**拉取式**（零入站 SSH）+
镜像验签 fail-closed（cosign 或摘要钉死）；⑤ 健康端点 `/api/health` 全程只读、响应零
PII，degraded 即 503，带病容器不接流量。

**证据**：`docker-compose.prod.yml`（security_opt / cap_drop / 无 db 端口）；`infra/terraform/modules/security-gates/`；`scripts/pull-upgrade.sh`（验签三选一）。
**复核**：`pnpm day35:gates`（含 6 道反例考卷，21 项全绿）。

---

## Part B · DBA 视角（5 题）

### B1. 数据库迁移怎么做？会不会升级把表结构搞坏？

**答**：应用内置**幂等 DDL**（`CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS`
增量补列），首次请求自动建表、可无限次重复执行且结果一致；无独立迁移服务器、
无手工 SQL 脚本序列，杜绝「漏跑第 3 号迁移」这类事故。种子数据（提示词版本）
同样幂等（`ON CONFLICT DO NOTHING`）。表结构变更属低风险行列级操作，不含 DROP。

**证据**：`src/db/index.ts`（`ensureSchema()` 全部 DDL）。
**复核**：连续调两次 `/api/health` 后对比表数：`\dt` 前后一致；重复启动应用无报错。

### B2. 「只增不改」触发器，万一有人把触发器删了呢？

**答**：分层防御：① 应用连接日常只做业务读写，删触发器需要显式 DDL 操作（代码中
不存在，`ensureSchema` 只重挂从不卸载）；② 生产 `.env.prod` 与数据库凭据仅运维持有，
建议客户侧把应用账号与 DBA 账号**分权**（应用账号不授 DDL），我们交付时提供
配套 GRANT 清单；③ 真正防「内部 DBA 作恶」的正确姿势是把台账**异地下沉**——
`workflow_events` / `approval_audit_logs` 可由客户侧配置逻辑订阅推送到客户自管日志仓
（WORM 存储），WorkBot 侧触发器保证源头不被应用层篡改，异地副本保证宿主机层面
可追溯。我们不宣称「绝对不可篡改」，只宣称「应用与开发者无篡改路径 + 数据库层
物理拦截 + 客户可自证」。

**证据**：`src/db/index.ts`（触发器只挂不卸）；`docker-compose.prod.yml`（凭据单点 `.env.prod`）。
**复核**：`docker compose exec db psql -U workbot -d workbot -c "DROP TRIGGER llm_usage_logs_immutable ON llm_usage_logs;"`（用 DBA 账号可成功——这正是需要分权与异地副本的原因）；随后重启应用容器触发器自动重新挂载。

### B3. 备份与恢复怎么演练？备份文件本身可信吗？

**答**：每次升级**先快照后动手**：`pg_dump` 落盘 → `pg_restore --list` 校验可恢复性
（不是只存文件名）→ 才开始换镜像；快照保留 7 份轮换。升级本体走旁路影子容器验活，
正常路径根本用不到快照——它是人工兜底，不是唯一防线。

**证据**：`scripts/pull-upgrade.sh`（快照 + 可恢复性校验 + 保留 7 份于 `backups/`）。
**复核**：跑一次 `bash scripts/pull-upgrade.sh --image workbot-app:latest --local`，检查 `backups/` 生成 `.dump` 且升级前后 `/api/health` 台账行数一致。

### B4. 生产排障要查库，为什么不给我们开个数据库端口？

**答**：数据库容器**不发布任何端口**（连 `127.0.0.1` 都不绑），是 compose 里的红线注释。
查库走容器内自带通道 `docker compose exec db psql`——权限等同「登到那台机器的本地
控制台」，不新增网络攻击面。远程运维全部经**拉取式升级脚本**（仅出站 HTTPS）完成，
历史原因是：每多开一个入站端口，就多一份防火墙审批和一条攻击路径。若客户合规
政策强制要求网络层可达，compose 预留了仅绑回环的注释行，需运维显式开启并记录。

**证据**：`docker-compose.prod.yml` db 服务（无 ports，注释行即预留口）。
**复核**：宿主机 `psql -h 127.0.0.1 -p 5433` 应连接失败；`docker compose exec db psql -U workbot -d workbot -c "select 1"` 应成功。

### B5. 怎么向我证明一次升级 / 回滚没有弄丢任何数据？

**答**：靠**可自证的数字**而不是口头保证：① `/api/health` 永久回显两张只增台账
（审批审计 / 用量台账）的行数；② 升级脚本动应用前先记录行数指纹，切换后自动比对；
③ 回滚脚本 90 秒预算内轮询验活，行数**只增不减**才判成功，且启动时全文自证脚本
本身不含任何破坏性数据语句（`DELETE` / `TRUNCATE` / `DROP` 出现即当场退出）；
④ 每次回滚追加一条 JSONL 流水（只增不改），时间、版本、用时、行数全部留痕。

**证据**：`app/api/health/route.ts`（auditData 行数回显）；`scripts/run-rollback.mjs` + `scripts/rollback-90s.sh`；`infra/README-DEPLOY.md`（实测 18→18 / 40→40 行）。
**复核**：`pnpm day35:rollback` 跑一遍，核对输出中的行数与 `data/day35/rollback-logs.jsonl` 追加行。

---

## 附：证据文件索引

| 主题 | 文件 |
|---|---|
| PII 脱敏唯一真源 | `src/lib/pii-scrubber.ts` |
| 检索 ACL（先过滤后打分） | `src/lib/raglab/retrieval.ts` · `brain/ADR-002.md` |
| BYOK / 离线高仿真 | `lib/llm/llm-client.mjs` |
| 物理电闸 | `src/lib/security/kill-switch.ts` |
| FIN-001 阈值与具名审批 | `src/lib/fin001.ts` · `brain/ADR-003.md` |
| 幂等 DDL 与只增触发器 | `src/db/index.ts` |
| 多租户唯一入口 | `src/lib/ontology/tenant-repo.ts` |
| 容器加固 / 零端口 | `Dockerfile` · `docker-compose.prod.yml` |
| Terraform 安全门禁 | `infra/terraform/modules/security-gates/` · `pnpm day35:gates` |
| 红队拦截报告（20/20） | `data/evals/red-team-report.json` · `pnpm eval:security` |
| 升级 / 回滚 | `scripts/pull-upgrade.sh` · `scripts/rollback-90s.sh` · `infra/README-DEPLOY.md` |
| 健康检查口径 | `app/api/health/route.ts` |
