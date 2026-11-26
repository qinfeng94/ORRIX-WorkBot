#!/usr/bin/env bash
# ============================================================
# scripts/pull-upgrade.sh —— WorkBot 拉取式升级（Day 34）
#
# 「拉取式」三原则：
#   1) 只出不进：客户服务器仅通过出站 HTTPS 从镜像仓库拉取新版本，
#      全程不要求、也绝不配置任何入站 SSH 端口 / 端口转发 / 防火墙开洞；
#   2) 先快照再升级：动应用之前先做数据库快照（pg_dump），校验可恢复性；
#   3) 带健康门禁的平滑滚动：新镜像先在旁路容器（3001 端口）验活，
#      健康通过才切换正式容器；失败自动回滚旧镜像，快照永远是人工兜底。
#
# 镜像验签（fail-closed，任一满足即可，否则拒绝升级）：
#   A. cosign 签名校验：安装 cosign 并设置 WORKBOT_SIGNER_KEY（公钥路径/url）
#      或 WORKBOT_SIGNER_IDENTITY + WORKBOT_SIGNER_OIDC_ISSUER（keyless）；
#   B. 摘要钉死：--digest sha256:xxx（或 WORKBOT_DIGEST）与仓库摘要逐字比对；
#   C. 本地构建豁免：--local 仅用于本机 docker build 出的镜像（显式声明才放行）。
#
# 用法：
#   bash scripts/pull-upgrade.sh --image registry.example.com/workbot:v4.1 --digest sha256:abcd...
#   bash scripts/pull-upgrade.sh --image workbot-app:latest --local
# 可选环境变量：
#   WORKBOT_SIGNER_KEY / WORKBOT_SIGNER_IDENTITY / WORKBOT_SIGNER_OIDC_ISSUER / WORKBOT_DIGEST
#   WORKBOT_COMPOSE_FILE（默认 docker-compose.prod.yml）/ WORKBOT_HEALTH_TIMEOUT（默认 120 秒）
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${WORKBOT_COMPOSE_FILE:-${REPO_ROOT}/docker-compose.prod.yml}"
ENV_FILE="${REPO_ROOT}/.env.prod"
BACKUP_DIR="${REPO_ROOT}/backups"
HEALTH_TIMEOUT="${WORKBOT_HEALTH_TIMEOUT:-120}"
STAGE_PORT=3001
STAGE_NAME="workbot-upgrade-stage"
RETENTION=7

NEW_IMAGE=""
EXPECTED_DIGEST="${WORKBOT_DIGEST:-}"
LOCAL_MODE=0

# ---------------- 通用输出 ----------------
now() { date "+%Y-%m-%d %H:%M:%S"; }
info() { echo "[$(now)] [升级] $*"; }
warn() { echo "[$(now)] [警告] $*" >&2; }
die() { echo "[$(now)] [失败] $*" >&2; exit 1; }

usage() {
  cat <<'USAGE_EOF'
WorkBot 拉取式升级（Day 34）

三原则：
  1) 只出不进：仅出站 HTTPS 拉镜像，零入站 SSH、零防火墙改动；
  2) 先快照再升级：pg_dump 快照 + 可恢复性校验，动应用前先落袋；
  3) 健康门禁平滑滚动：新镜像旁路验活（3001 端口）→ 通过才切换 → 失败自动回滚。

镜像验签（fail-closed，任一满足即可）：
  A. cosign 签名：WORKBOT_SIGNER_KEY（公钥）或
     WORKBOT_SIGNER_IDENTITY + WORKBOT_SIGNER_OIDC_ISSUER（keyless）；
  B. 摘要钉死：--digest sha256:xxx 与仓库摘要逐字比对；
  C. 本地构建豁免：--local（仅限本机 docker build 出的镜像，显式声明才放行）。

用法：
  bash scripts/pull-upgrade.sh --image registry.example.com/workbot:v4.1 --digest sha256:abcd...
  bash scripts/pull-upgrade.sh --image workbot-app:latest --local

可选环境变量：
  WORKBOT_SIGNER_KEY / WORKBOT_SIGNER_IDENTITY / WORKBOT_SIGNER_OIDC_ISSUER / WORKBOT_DIGEST
  WORKBOT_COMPOSE_FILE（默认 docker-compose.prod.yml）/ WORKBOT_HEALTH_TIMEOUT（默认 120 秒）
USAGE_EOF
  exit 0
}

# ---------------- 参数解析 ----------------
while [ $# -gt 0 ]; do
  case "$1" in
    --image)   NEW_IMAGE="${2:-}"; shift 2 ;;
    --digest)  EXPECTED_DIGEST="${2:-}"; shift 2 ;;
    --local)   LOCAL_MODE=1; shift ;;
    --help|-h) usage ;;
    *) die "未知参数：$1（--help 查看用法）" ;;
  esac
done

# ---------------- 清理（任何中途失败都收走旁路验活容器） ----------------
cleanup() {
  if docker ps --format '{{.Names}}' | grep -qx "${STAGE_NAME}"; then
    docker rm -f "${STAGE_NAME}" >/dev/null 2>&1 || true
    info "旁路验活容器已清理"
  fi
}
trap cleanup EXIT

# ---------------- 预检 ----------------
command -v docker >/dev/null 2>&1 || die "未检测到 docker，请先安装 Docker Engine"
docker compose version >/dev/null 2>&1 || die "未检测到 docker compose 插件"
command -v curl >/dev/null 2>&1 || die "未检测到 curl（健康门禁必需）"
[ -f "${COMPOSE_FILE}" ] || die "找不到编排文件：${COMPOSE_FILE}"

COMPOSE="docker compose -f ${COMPOSE_FILE}"

if [ -z "${NEW_IMAGE}" ]; then
  NEW_IMAGE="${WORKBOT_IMAGE:-workbot-app:latest}"
  warn "未指定 --image，使用 ${NEW_IMAGE}（建议显式指定带版本号的镜像）"
fi

if [ "${LOCAL_MODE}" -eq 1 ] && [ -n "${EXPECTED_DIGEST}" ]; then
  die "--local 与 --digest 互斥：本地构建镜像走镜像存在性校验即可"
fi

# .env.prod 必须就位：正式数据库密码只从这里注入（绝不硬编码、绝不走命令行明文传参）
if [ ! -f "${ENV_FILE}" ]; then
  die "找不到 ${ENV_FILE}：请按 docker-compose.prod.yml 头部说明创建（至少包含 POSTGRES_PASSWORD）"
fi
# shellcheck disable=SC1090
set -a; . "${ENV_FILE}"; set +a
[ -n "${POSTGRES_PASSWORD:-}" ] || die "${ENV_FILE} 缺少 POSTGRES_PASSWORD"

echo "============================================================"
info "WorkBot 拉取式升级开始"
info "目标镜像：${NEW_IMAGE}"
info "升级模式：只出不进（出站 HTTPS 拉取），零入站 SSH，防火墙零改动"
echo "============================================================"

# ---------------- 步骤 1：拉取新镜像（出站 HTTPS，客户侧零暴露面） ----------------
info "步骤 1/6 · 拉取镜像（仅出站流量）"
if [ "${LOCAL_MODE}" -eq 1 ]; then
  docker image inspect "${NEW_IMAGE}" >/dev/null 2>&1 \
    || die "本地镜像不存在：${NEW_IMAGE}（请先 docker build -t ${NEW_IMAGE} .）"
  info "本地构建模式：镜像 ${NEW_IMAGE} 已在本机（存在性校验通过）"
else
  if ! ${COMPOSE} pull app >/dev/null 2>&1 && ! ${COMPOSE} pull app; then
    if docker image inspect "${NEW_IMAGE}" >/dev/null 2>&1; then
      warn "仓库拉取失败，但本机已有镜像 ${NEW_IMAGE}（继续验签流程，请确认来源可信）"
    else
      die "镜像拉取失败：${NEW_IMAGE}（请检查出站网络与仓库凭据 docker login）"
    fi
  fi
  docker image inspect "${NEW_IMAGE}" >/dev/null 2>&1 \
    || die "拉取完成但本地找不到镜像 ${NEW_IMAGE}"
fi

# ---------------- 步骤 2：签名 / 摘要校验（fail-closed：验不了就不升） ----------------
info "步骤 2/6 · 镜像验签（cosign 签名 / 摘要钉死，任一通过）"
verify_signature() {
  if command -v cosign >/dev/null 2>&1 && [ -n "${WORKBOT_SIGNER_KEY:-}" ]; then
    info "使用 cosign 公钥验签（${WORKBOT_SIGNER_KEY}）"
    cosign verify --key "${WORKBOT_SIGNER_KEY}" "${NEW_IMAGE}" >/dev/null \
      || die "cosign 公钥验签失败，拒绝升级（绝不带病上线）"
    return 0
  fi
  if command -v cosign >/dev/null 2>&1 && [ -n "${WORKBOT_SIGNER_IDENTITY:-}" ] \
     && [ -n "${WORKBOT_SIGNER_OIDC_ISSUER:-}" ]; then
    info "使用 cosign keyless 验签（identity=${WORKBOT_SIGNER_IDENTITY}）"
    cosign verify \
      --certificate-identity "${WORKBOT_SIGNER_IDENTITY}" \
      --certificate-oidc-issuer "${WORKBOT_SIGNER_OIDC_ISSUER}" \
      "${NEW_IMAGE}" >/dev/null \
      || die "cosign keyless 验签失败，拒绝升级"
    return 0
  fi
  if [ -n "${EXPECTED_DIGEST}" ]; then
    case "${EXPECTED_DIGEST}" in
      sha256:*) ;;
      *) die "--digest 必须是 sha256: 开头的完整摘要" ;;
    esac
    actual="$(docker image inspect --format '{{json .RepoDigests}}' "${NEW_IMAGE}" 2>/dev/null || echo '[]')"
    echo "${actual}" | grep -q "${EXPECTED_DIGEST}" \
      || die "摘要不匹配：期望 ${EXPECTED_DIGEST}，仓库实际 ${actual}（拒绝升级）"
    info "摘要钉死校验通过：${EXPECTED_DIGEST}"
    return 0
  fi
  return 1
}

if verify_signature; then
  info "镜像验签通过"
elif [ "${LOCAL_MODE}" -eq 1 ]; then
  warn "本地构建模式：未做 cosign/摘要校验（显式 --local 豁免，仅限本机自建镜像）"
else
  die "无法验签：请安装 cosign 并配置 WORKBOT_SIGNER_KEY，或提供 --digest sha256:xxx（fail-closed，绝不带病升级）"
fi

# ---------------- 步骤 3：数据库快照（先快照，再动任何应用容器） ----------------
info "步骤 3/6 · 数据库快照（pg_dump · 先快照再升级）"
mkdir -p "${BACKUP_DIR}"
SNAPSHOT="${BACKUP_DIR}/pre-upgrade-$(date +%Y%m%d-%H%M%S).dump"
${COMPOSE} exec -T db pg_dump -U workbot --format=custom workbot > "${SNAPSHOT}" \
  || die "数据库快照失败（应用零改动，请检查 db 容器状态）"
[ -s "${SNAPSHOT}" ] || die "快照文件为空，拒绝升级"
# 快照可恢复性校验：pg_restore --list 能读出目录 = 这份快照真的可用
docker compose -f "${COMPOSE_FILE}" exec -T db sh -c "pg_restore --list /dev/stdin >/dev/null" \
  < "${SNAPSHOT}" || die "快照完整性校验失败（pg_restore 无法读取），拒绝升级"
SNAPSHOT_SHA="$(sha256sum "${SNAPSHOT}" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "${SNAPSHOT}" | cut -d' ' -f1)"
info "快照完成：${SNAPSHOT}（$(du -h "${SNAPSHOT}" | cut -f1) · sha256=${SNAPSHOT_SHA}）"
# 快照保留最近 ${RETENTION} 份
ls -1t "${BACKUP_DIR}"/pre-upgrade-*.dump 2>/dev/null | tail -n +$((RETENTION + 1)) | while read -r old; do
  rm -f "${old}" && info "清理过期快照：${old}"
done

# ---------------- 步骤 4：旁路验活（新镜像先起影子容器，健康门禁通过才算数） ----------------
info "步骤 4/6 · 旁路验活（新镜像影子容器 · 端口 ${STAGE_PORT}）"
if (echo > /dev/tcp/127.0.0.1/${STAGE_PORT}) >/dev/null 2>&1; then
  die "端口 ${STAGE_PORT} 已被占用：请先释放或改 STAGE_PORT"
fi
NETWORK="$(
  docker network ls \
    --filter label=com.docker.compose.project=workbot-prod \
    --filter label=com.docker.compose.network=internal \
    --format '{{.Name}}' | head -n 1
)"
NETWORK="${NETWORK:-workbot-prod_internal}"
docker run -d --rm --name "${STAGE_NAME}" \
  --network "${NETWORK}" \
  -p "127.0.0.1:${STAGE_PORT}:3000" \
  --env-file "${ENV_FILE}" \
  -e NODE_ENV=production \
  -e DATABASE_URL="postgresql://workbot:${POSTGRES_PASSWORD}@db:5432/workbot" \
  -e WORKBOT_IMAGE="${NEW_IMAGE}" \
  "${NEW_IMAGE}" >/dev/null \
  || die "影子容器启动失败（新镜像未接管任何生产流量）"

probe_health() {
  curl -fsS --max-time 5 "http://127.0.0.1:${1}/api/health" | grep -q '"status":"ok"'
}
wait_health() {
  local port="$1" timeout="$2" label="$3"
  local deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "${deadline}" ]; do
    if probe_health "${port}"; then
      info "${label}：健康门禁通过（/api/health = ok）"
      return 0
    fi
    sleep 3
  done
  echo "---- 最近一次健康响应 ----" >&2
  curl -sS --max-time 5 "http://127.0.0.1:${port}/api/health" || echo "（无响应）" >&2
  return 1
}

wait_health "${STAGE_PORT}" "${HEALTH_TIMEOUT}" "影子容器" \
  || die "影子容器健康门禁未通过（数据库 / 双模型网关自检失败）——正式容器零改动，快照已就位"

# ---------------- 步骤 5：切换正式容器（滚动更新 + 自动回滚） ----------------
info "步骤 5/6 · 切换正式容器（健康门禁已过，执行滚动更新）"
APP_CID="$(${COMPOSE} ps -q app || true)"
OLD_IMAGE_ID=""
if [ -n "${APP_CID}" ]; then
  OLD_IMAGE_ID="$(docker inspect --format '{{.Image}}' "${APP_CID}" 2>/dev/null || true)"
fi

if WORKBOT_IMAGE="${NEW_IMAGE}" ${COMPOSE} up -d --no-deps --wait app; then
  info "正式容器已切换到 ${NEW_IMAGE}"
else
  warn "滚动更新失败，开始自动回滚"
  if [ -n "${OLD_IMAGE_ID}" ]; then
    ROLLBACK_TAG="workbot-app:rollback-$(date +%Y%m%d-%H%M%S)"
    docker tag "${OLD_IMAGE_ID}" "${ROLLBACK_TAG}" \
      || die "回滚镜像标记失败（请人工介入；快照：${SNAPSHOT}）"
    WORKBOT_IMAGE="${ROLLBACK_TAG}" ${COMPOSE} up -d --no-deps --wait app \
      || die "自动回滚也失败（请人工介入：docker compose -f ${COMPOSE_FILE} up -d；快照：${SNAPSHOT}）"
    wait_health 3000 "${HEALTH_TIMEOUT}" "回滚容器" \
      || die "回滚后健康门禁未通过（请人工介入；快照：${SNAPSHOT}）"
    warn "已回滚到旧版本 ${ROLLBACK_TAG}，新镜像未上线"
    exit 1
  else
    die "无旧版本可回滚（首次部署失败）：docker compose -f ${COMPOSE_FILE} up -d 可重试；快照：${SNAPSHOT}"
  fi
fi

# ---------------- 步骤 6：终检 ----------------
info "步骤 6/6 · 正式容器终检"
wait_health 3000 "${HEALTH_TIMEOUT}" "正式容器" \
  || die "切换后健康门禁未通过（自动回滚：重新执行本脚本 WORKBOT_IMAGE=旧镜像 即可；快照：${SNAPSHOT}）"

echo "============================================================"
info "升级完成 ✅"
info "  当前版本：${NEW_IMAGE}"
info "  验活端点：http://127.0.0.1:3000/api/health"
info "  数据库快照：${SNAPSHOT}（保留 ${RETENTION} 份，人工恢复命令："
info "    docker compose -f ${COMPOSE_FILE} exec -T db pg_restore -U workbot -d workbot --clean < ${SNAPSHOT}）"
info "  安全程诺：本次升级零入站 SSH、零防火墙改动、零公网暴露面"
echo "============================================================"
