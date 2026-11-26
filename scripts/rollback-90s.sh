#!/usr/bin/env bash
# =============================================================================
# Day 35 · 90 秒无损回滚演习（scripts/rollback-90s.sh）
# 溯源：AGENTS.md 红区（严禁直写业务系统正式数据 / 审计日志只增不改 / Kill Switch）
#      + 04 号文档权限边界（回滚只退「应用镜像」，业务数据库一个字节都不碰）。
#
# 【小白导读 · 先看这一段】
#   ▸ 什么是「回滚」？——刚发布的新版本出了问题，把软件退回上一个能正常用的版本。
#     就像手机 App 更新后闪退，卸载更新装回旧版。
#   ▸ 什么是「镜像」？——软件打包好的安装包，带一个版本号（如 workbot:v4.0.34-good）。
#     「回滚镜像」= 只换版本号，不删任何数据。
#   ▸ 什么是「无损」？——工单、客户、审批记录这些业务数据（存在数据库里），
#     回滚全程一个字节都不碰。本脚本用「行数比对」来证明这一点：回滚前后
#     审计台账的行数必须只增不减，少一行就报警。
#   ▸ 什么是「验活」？——回滚后反复戳 /api/health 这个只读体检接口，
#     确认三件事：服务活着、版本号真的退回去了、数据没少。
#   ▸ 为什么限定 90 秒？——真出事时每秒都在烧钱，回滚必须快、必须可控。
#     超过 90 秒没验活通过 = 演习失败，提示人工介入（绝不硬凑「成功」）。
#
# 四步流程：停闸体检 → 只换镜像 → 验活 → 出报告（图解见 infra/README-DEPLOY.md）
#
# 用法：
#   bash scripts/rollback-90s.sh                          # 本地演习（默认，打 dev 服务器）
#   bash scripts/rollback-90s.sh --target k8s --namespace workbot
#   bash scripts/rollback-90s.sh --health-url http://localhost:3000/api/health
#   bash scripts/rollback-90s.sh --budget 90              # 默认预算就是 90 秒
#   （也可以直接用 pnpm day35:rollback，它会自动找到正确的 bash 来执行本脚本）
#
# 本地演习模式说明：用 data/day35/deploy-state.json 模拟「当前/上一版镜像」切换，
# 版本号在 /api/health 的 release.image 肉眼可见；真实 K8s 模式走 kubectl rollout undo。
#
# 【改脚本前必读】本脚本启动时会全文自查，禁止出现任何完整的破坏性数据语句
#   （含注释里！写了连注释都过不了自检）。所以下面所有讲解只用中文描述，
#   想表达「删库类 SQL」时也绝不能把那几个英文关键字完整写出来。
# =============================================================================

# set -euo pipefail 是 bash 的「严格模式」三件套，作用是让脚本一出错就立刻停下，
# 而不是带着错误继续往下跑（小白类比：做菜时尝到变味的食材马上整锅倒掉，
# 而不是硬着头皮吃完才发现有问题）：
#   -e  任何命令执行失败（返回非 0）→ 立即终止脚本
#   -u  用到未定义的变量 → 立即报错（防止变量名拼错却静默传了空值）
#   -o pipefail  管道命令（A | B）中任何一环失败都算整体失败
set -euo pipefail

# ----------------------------- 参数解析 -----------------------------
# 这里给 4 个可调参数设默认值。用户可以在命令后面用 --参数名 值 覆盖，
# 比如：bash scripts/rollback-90s.sh --budget 60 把预算改成 60 秒。
TARGET="local"           # 演习目标：local=打本地 dev 服务器；k8s=打真实 K8s 集群
HEALTH_URL=""            # 健康检查网址；留空 = 自动探测 localhost:3000 / 3001（本地模式）
NAMESPACE="workbot"      # K8s 命名空间（可以理解成集群里的「房间号」，应用住在里面）
BUDGET=90                # 演习总预算（秒）。超过就判失败，对应「90 秒」铁律

# $# 是「参数个数」，$1 是第一个参数…… 这个 while 循环逐个吃掉命令行参数：
# 每匹配一个「--参数名 值」组合就 shift 2（把这两项从队列里移走），直到吃完。
# case 相当于其他语言的 switch，按参数名分发赋值。
# 剩下匹配不上的参数 → 提示用法并退出（exit 1 = 失败退出码，见文末说明）。
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)     TARGET="$2"; shift 2 ;;
    --health-url) HEALTH_URL="$2"; shift 2 ;;
    --namespace)  NAMESPACE="$2"; shift 2 ;;
    --budget)     BUDGET="$2"; shift 2 ;;
    *) echo "未知参数：$1（可选 --target / --health-url / --namespace / --budget）"; exit 1 ;;
  esac
done

# 定位项目根目录和演习数据目录：
#   $0            = 脚本自己的路径（scripts/rollback-90s.sh）
#   dirname "$0"  = 脚本所在目录（scripts/）
#   cd .../.. && pwd = 跳到上一级再报出绝对路径 → 项目根目录（不依赖你在哪个文件夹里执行）
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DAY35_DIR="$ROOT_DIR/data/day35"                 # Day 35 演习数据都放这里
STATE_FILE="$DAY35_DIR/deploy-state.json"        # 本地演习的「当前版本 / 上一版」状态文件
LEDGER="$DAY35_DIR/rollback-logs.jsonl"          # 回滚流水台账（只增不改，见第 4 步）
mkdir -p "$DAY35_DIR"                            # 目录不存在就创建（-p = 已存在也不报错）

# 统一的失败出口：打印失败原因 + 安抚一句「数据没被动过」+ 以失败码退出。
# 全脚本任何一步出问题都走这里，保证失败时用户看到的格式一致。
fail() { echo ""; echo "❌ 演习失败：$1"; echo "   （放心：失败发生在应用层，数据库与审计台账全程未被触碰）"; exit 1; }

# ----------------------------- 零删库物理自证 -----------------------------
# 红线要求「删库能力物理剔除，不是口头承诺」。实现思路很朴素：
#   1) 把几条破坏性语句的关键词列成清单（删表 / 删库 / 批量删行 / 清空表 /
#      kubectl 的删 Deployment 命令——注意这里全用拼接写法，原因见下）；
#   2) 用 grep -qF 在脚本文件自己（$0）里逐条搜；
#   3) 只要搜到任何一条完整的 → 当场自杀退出，拒绝运行。
#
# 为什么清单里的词要拆成两半写（如 "DR""OP TABLE"）？
#   bash 相邻字符串会自动拼起来，运行时清单内容是完整的；但脚本文件里存的是拆开的样子，
#   所以「搜索自己」时永远搜不到完整关键词——否则清单本身就是自检的命中项，逻辑打架。
#   这就是「物理剔除」的小心思：让坏语句在文件里根本无法完整存在。
#
# 【给未来改脚本的人】新增注释时同样不能写出完整关键词，否则自检会拦下你自己。
forbidden_patterns=("DR""OP TABLE" "DR""OP DATABASE" "DE""LETE FROM" "TRU""NCATE" "kubectl de""lete deployment")
for p in "${forbidden_patterns[@]}"; do
  # grep 参数解读：-q 安静模式（不打印，只看找到没）；-F 按字面文本搜（不当正则）
  # "$0" 就是脚本文件自己——「以己之矛攻己之盾」
  if grep -qF "$p" "$0"; then
    fail "自检异常：脚本中出现了破坏性语句「$p」——这违反红线，请立即停用并上报"
  fi
done
echo "🛡  零删库自证：本脚本物理不含任何破坏性数据语句（逐条比对通过）"

# ----------------------------- 工具函数 -----------------------------
# parse_health：把 /api/health 返回的一坨 JSON，浓缩成一行竖线分隔的文本：
#   格式："status|image|审批台账行数|用量台账行数"，例如 "ok|workbot:v4.0.34-good|18|40"
# 为什么要浓缩？bash 处理 JSON 很笨，所以借 Node.js 的手来解析：
#   node -e "..." 表示执行引号里的 JS 代码；
#   末尾的 "$1" 是传给 JS 的参数，JS 里用 process.argv[1] 接住（argv[0] 是 node 自己）。
# JSON.parse 把 JSON 文本变成 JS 对象；(a.xxx === null || undefined) ? 'NA' : 值
# 是「字段缺失就填 NA」的兜底写法，防止某一环挂了导致整个解析崩溃。
parse_health() {
  node -e "
    const j = JSON.parse(process.argv[1] || '{}');
    const a = (j.checks && j.checks.auditData) || {};
    console.log([
      j.status || 'unknown',
      (j.release && j.release.image) || 'unknown',
      (a.approvalAuditLogs === null || a.approvalAuditLogs === undefined) ? 'NA' : a.approvalAuditLogs,
      (a.llmUsageLogs === null || a.llmUsageLogs === undefined) ? 'NA' : a.llmUsageLogs,
    ].join('|'));
  " "$1"
}

# fetch_health：戳一下健康检查接口。
# curl 参数解读：-f 收到 HTTP 错误码（如 503）就当失败；-s 安静模式（不显示进度条）；
#   -S 出错时仍显示错误信息；--max-time 3 最多等 3 秒（体检不能拖后腿）；
#   2>/dev/null 把错误提示扔进黑洞（画面干净）；末尾 || true 表示「戳失败也不中断脚本」——
#   验活本来就是轮询，一次没戳中很正常，下一轮再戳。
fetch_health() {
  curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null || true
}

# ----------------------------- 第 1 步 · 停闸体检 -----------------------------
# SECONDS 是 bash 的内置秒表：脚本启动后自动每秒 +1，赋值 0 = 归零计时。
# 整个演习的「90 秒预算」就靠它算时间。
SECONDS=0
echo ""
echo "════════ Day 35 · 90 秒无损回滚演习 ════════"
echo "模式：$TARGET   预算：$BUDGET 秒   红线：只退镜像，零删库"
echo ""

# 没手动指定 --health-url 且是本地模式时，自动探测 dev 服务器开在哪个端口：
# 依次戳 3000、3001，谁有响应就用谁（> /dev/null 2>&1 表示输出全扔掉，只看通不通）。
if [[ -z "$HEALTH_URL" && "$TARGET" == "local" ]]; then
  for port in 3000 3001; do
    if curl -fsS --max-time 2 "http://localhost:$port/api/health" >/dev/null 2>&1; then
      HEALTH_URL="http://localhost:$port/api/health"
      break   # 找到一个就跳出循环
    fi
  done
fi
# -z 判断字符串为空。两个端口都探不到 → 服务没起，直接失败并给操作提示。
[[ -z "$HEALTH_URL" ]] && fail "探不到健康检查入口（试过 localhost:3000/3001）。请先启动服务：pnpm dev，再跑本演习"

echo "▶ 第 1 步 · 停闸体检（回滚前快照，给数据留指纹）"
# $(...) 是「命令替换」：把命令的输出抓成一个字符串变量。
# 这里抓回滚前的健康检查返回体。
PRE_BODY="$(fetch_health)"
[[ -z "$PRE_BODY" ]] && fail "健康检查无响应：$HEALTH_URL"
# 用工具函数把 JSON 浓缩成 "status|image|行数|行数" 一行文本
PRE_LINE="$(parse_health "$PRE_BODY")"
# IFS='|' read -r A B C D <<< "文本"：按竖线切分，四段分别装进四个变量（小白类比：
# 把「ok|good|18|40」这串快递按竖线拆开，装进四个盒子）。
IFS='|' read -r PRE_STATUS PRE_IMAGE PRE_APPROVALS PRE_USAGE <<< "$PRE_LINE"
echo "   服务状态：$PRE_STATUS   当前镜像：$PRE_IMAGE"
echo "   审批台账：$PRE_APPROVALS 行   用量台账：$PRE_USAGE 行"
# 服务回滚前就不健康 → 拒绝演习。演习要演的是「从好到好」的切换，
# 从「坏」出发没法证明回滚的价值，先排查好基础环境再来。
[[ "$PRE_STATUS" == "ok" ]] || fail "回滚前服务就不健康，先排查再演习（预演要演的是「从好到好」的切换）"

# ----------------------------- 第 2 步 · 只换镜像（零删库） -----------------------------
echo ""
echo "▶ 第 2 步 · 只换镜像（数据库 / 审计台账 / 记忆表零触碰）"

if [[ "$TARGET" == "k8s" ]]; then
  # ---- K8s 真实回退 ----
  # command -v kubectl 检查命令存在与否（不存在输出为空），2>&1 合并错误流
  command -v kubectl >/dev/null 2>&1 || fail "kubectl 不可用（K8s 模式需要集群与 kubectl）"
  # rollout undo = K8s 官方「后悔药」：把 Deployment 逐个 Pod 滚回上一个版本，
  # 滚动期间服务不中断（这也是 workbot-app 模块里 max_unavailable=0 的功劳）
  kubectl rollout undo "deployment/workbot-app" -n "$NAMESPACE"
  # rollout status 盯着回退进度，60 秒内没滚完就报失败
  kubectl rollout status "deployment/workbot-app" -n "$NAMESPACE" --timeout="60s" \
    || fail "滚动回退未在 60 秒内完成"
  # 回头查一眼集群里现在实际跑的镜像标签，作为第 3 步验活的「目标答案」。
  # -o jsonpath='...' 是 kubectl 的取值语法：从资源定义里抠出第一个容器的 image 字段
  EXPECTED_IMAGE="$(kubectl get deployment workbot-app -n "$NAMESPACE" -o jsonpath='{.spec.template.spec.containers[0].image}')"
  ROLLBACK_DESC="kubectl rollout undo（K8s 标准回退，镜像标签退回上一版）"
else
  # ---- 本地演习：没有真容器可换，就用状态文件对调来模拟「换版本号」----
  # deploy-state.json 两个关键字段：currentImage（当前版）/ previousImage（上一版）。
  # 对调后 /api/health 读到的 currentImage 立刻变成旧版 → 版本号肉眼可见地退回去了。
  # /api/health 优先读环境变量 WORKBOT_IMAGE（K8s 注入），本地没设才读这个文件——
  # 所以本地演习的版本切换对验活接口完全生效，不是自说自话。
  SWAP_OUT="$(node -e "
    const fs = require('fs');
    const p = process.argv[1];                       // 状态文件路径（bash 在末尾传入）
    let s = {};
    try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { s = {}; }  // 文件不存在/坏了 → 从零开始
    const cur = (typeof s.currentImage === 'string' && s.currentImage) || 'workbot:v4.0.35-bad';   // 首次运行默认摆一个坏版本
    const prev = (typeof s.previousImage === 'string' && s.previousImage) || 'workbot:v4.0.34-good'; // 首次运行的回滚目标
    const now = new Date().toISOString();
    // 对调写入：当前 ← 上一版；上一版 ← 刚才的当前版。所以连跑两次会一来一回。
    fs.writeFileSync(p, JSON.stringify({ currentImage: prev, previousImage: cur, rolledBackAt: now, updatedAt: now }, null, 2) + '\n');
    console.log(cur + ' -> ' + prev);                // 告诉 bash「从谁换到了谁」
  " "$STATE_FILE")"
  # ${SWAP_OUT##*-> } 的意思：从左往右贪婪地删掉「最后的 ' -> '」及其前面所有内容，
  # 只留箭头右边的目标版本号（bash 取子串的小技巧）
  EXPECTED_IMAGE="${SWAP_OUT##*-> }"
  ROLLBACK_DESC="本地演习状态切换（$SWAP_OUT）"
fi
echo "   已执行：$ROLLBACK_DESC"
echo "   目标版本：$EXPECTED_IMAGE"

# ----------------------------- 第 3 步 · 验活 -----------------------------
echo ""
echo "▶ 第 3 步 · 验活（轮询 /api/health：状态 ok + 版本已退回 + 台账行数不减少）"
# 预算 90 秒，留 5 秒缓冲给第 4 步出报告——轮询最多跑 85 秒
DEADLINE=$(( BUDGET - 5 ))
# 先给循环里要用的变量占好位（防止严格模式 -u 报「未定义变量」）
CUR_STATUS=""
CUR_IMAGE=""
POST_APPROVALS="NA"
POST_USAGE="NA"
# 轮询 = 每 2 秒戳一次体检接口，直到三项全过或超时：
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  BODY="$(fetch_health)"
  if [[ -n "$BODY" ]]; then                          # -n = 非空，戳到了
    IFS='|' read -r CUR_STATUS CUR_IMAGE CUR_APPROVALS CUR_USAGE <<< "$(parse_health "$BODY")"
    POST_APPROVALS="$CUR_APPROVALS"                  # 随手记下最新行数，给第 4 步比对用
    POST_USAGE="$CUR_USAGE"
    if [[ "$CUR_STATUS" == "ok" && "$CUR_IMAGE" == "$EXPECTED_IMAGE" ]]; then
      echo "   ✅ 状态 ok · 版本=$CUR_IMAGE · 用时 $SECONDS 秒"
      break                                          # 两关都过 → 跳出轮询
    fi
    echo "   …等待中 [${SECONDS}s] 状态=$CUR_STATUS 版本=$CUR_IMAGE（目标 $EXPECTED_IMAGE）"
  else
    echo "   …等待中 [${SECONDS}s] 健康检查暂无响应"
  fi
  sleep 2                                            # 喘口气再戳
done

# 超时兜底：轮询跑完 85 秒仍未两关全过 → 判失败，提示人工介入。
# 注意：绝不硬凑「成功」——失败就是失败，这正是演习的价值。
[[ "$CUR_STATUS" == "ok" && "$CUR_IMAGE" == "$EXPECTED_IMAGE" ]] \
  || fail "预算 $BUDGET 秒内未验活通过（状态=$CUR_STATUS 版本=$CUR_IMAGE）——按预案应人工介入，Kill Switch 可 5 秒切断"

# 台账行数比对：只增不减 = 业务数据零损伤的硬证据。
# 数据库字段可空（NA）时跳过该项比对；行数变少（-lt = less than）→ 疑似有人删了数据，
# 立刻报警。正常运行时行数只会持平或增加（审计只增不改）。
data_ok=true
if [[ "$PRE_APPROVALS" != "NA" && "$POST_APPROVALS" != "NA" ]] && [[ "$POST_APPROVALS" -lt "$PRE_APPROVALS" ]]; then
  data_ok=false
fi
if [[ "$PRE_USAGE" != "NA" && "$POST_USAGE" != "NA" ]] && [[ "$POST_USAGE" -lt "$PRE_USAGE" ]]; then
  data_ok=false
fi
[[ "$data_ok" == true ]] || fail "台账行数回滚后变少（审批 $PRE_APPROVALS→$POST_APPROVALS / 用量 $PRE_USAGE→$POST_USAGE）——疑似数据被删，立即上报"

# ----------------------------- 第 4 步 · 出报告（只增不改台账） -----------------------------
echo ""
echo "▶ 第 4 步 · 出报告（回滚流水入台账：JSONL 只增不改）"
ELAPSED=$SECONDS
# 借 Node 组装一条 JSON 流水（时间、模式、退到哪版、用时、数据行数快照），
# NA 传给 JS 前转成 -1（JSON 数值字段不能是文字 NA，-1 表示「该项未知」）
LEDGER_LINE="$(node -e "
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    mode: process.argv[1],
    rolledBackTo: process.argv[2],
    result: process.argv[3],
    elapsedSeconds: Number(process.argv[4]),
    auditRows: { approvalAuditLogs: Number(process.argv[5] === 'NA' ? -1 : process.argv[5]), llmUsageLogs: Number(process.argv[6] === 'NA' ? -1 : process.argv[6]) },
  }));
" "$TARGET" "$EXPECTED_IMAGE" "pass" "$ELAPSED" "$POST_APPROVALS" "$POST_USAGE")"
# >> 是「追加写入」：新流水接在文件末尾，历史行永不覆盖——这就是「只增不改」的落盘动作。
# （对比：单个 > 会覆盖整个文件，这里严禁使用）
printf '%s\n' "$LEDGER_LINE" >> "$LEDGER"

# 最终判决：用时没超预算 → PASS；超了 → FAIL。退出码 0/1 是给调用方（pnpm、CI、
# 定时任务）看的信号：0 = 一切正常，非 0 = 有问题需要关注。
VERDICT="FAIL"
[[ "$ELAPSED" -le "$BUDGET" ]] && VERDICT="PASS"
echo ""
echo "════════ 演习报告 ════════"
echo "结果：$VERDICT   用时 $ELAPSED 秒 / 预算 $BUDGET 秒"
echo "镜像：$PRE_IMAGE → $EXPECTED_IMAGE（应用层回退完成）"
echo "数据：审批台账 $PRE_APPROVALS → $POST_APPROVALS 行 · 用量台账 $PRE_USAGE → $POST_USAGE 行（零删库 ✅）"
echo "台账：data/day35/rollback-logs.jsonl（只增不改）+1 行"
echo "══════════════════════════"
[[ "$VERDICT" == "PASS" ]] || exit 1
# 走到这里 = PASS，脚本自然结束，退出码 0
