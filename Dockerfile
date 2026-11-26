# ============================================================
# WorkBot 生产镜像 · 多阶段构建（Day 34 生产双容器打包）
# 设计目标：
#   1) 精简体积：Next.js standalone 输出（.next/standalone 自带按需追踪的
#      最小 node_modules），运行镜像不装 pnpm、不装 devDependencies；
#   2) 非 root 运行：uid/gid 1001（nextjs:nodejs），容器被攻破也拿不到 root；
#   3) 密钥零入镜：.dockerignore 物理剔除 .env*，构建期不接任何密钥
#      （离线高仿真可跑，运行时密钥只从容器环境变量注入）；
#   4) 红区物理隔离：镜像内不存在任何打款 / 写老 ERP 的工具（继承全站红线）。
#
# 构建：docker build -t workbot-app:latest .
# 运行：docker compose -f docker-compose.prod.yml up -d
# ============================================================

# syntax=docker/dockerfile:1

# ---------- 阶段一：构建（安装依赖 + next build，产物输出 .next/standalone） ----------
FROM node:22-alpine AS builder

WORKDIR /app

# corepack 按 package.json 的 packageManager 字段固定 pnpm 版本（v11.5.2），杜绝版本漂移
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

# 先只拷依赖清单再安装：源代码任何改动都不打断 Docker 层缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store --global \
 && pnpm install --frozen-lockfile

# 再拷源代码与运行时配置，执行生产构建
COPY . .
RUN pnpm run build

# ---------- 阶段二：运行（精简运行镜像，非 root 用户） ----------
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# 非 root 用户（uid/gid 1001）：Next.js 官方推荐口径
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs nextjs

# standalone 产物：server.js + 按需追踪的最小 node_modules（全量依赖不进运行镜像）
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# 静态资源按 Next.js 约定手动补进 standalone
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# 运行时真实读取的目录（不在 NFT 静态追踪范围内，必须显式拷入）：
#   config/            —— model-routing.json（双模型网关路由真源）+ approval-policies.json（ADR-005 规则外置）+ tenants/
#   data/evals         —— 评测门禁 / 红队演习数据集
#   .fde/ 两份体检产物 —— /arch-audit 页面运行时读取（其余契约文档不进镜像）
# data/ 其余为演习台账（容器内按需重建；审计类数据只增不改，长期留存走数据库）
COPY --from=builder --chown=nextjs:nodejs /app/config ./config
COPY --from=builder --chown=nextjs:nodejs /app/data ./data
COPY --from=builder --chown=nextjs:nodejs /app/.fde/ ./.fde/

# 数据目录可写（网关台账 JSONL 只增不改追加写）
RUN mkdir -p /app/data

USER nextjs
EXPOSE 3000

# 容器级健康门禁：直接验活 /api/health（数据库 + 双模型网关 + 电闸三大体检）
# degraded（503）同样判不健康——带病容器绝不接入生产流量（fail-closed）
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(async r=>{const j=await r.json().catch(()=>null);process.exit(r.ok&&j&&j.status==='ok'?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
