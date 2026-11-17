# syntax=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/docker/dockerfile:1.7
# =============================================================================
# NMG-PKU-Alumni —— Worker 镜像（BullMQ 消费者）
#
# 与 API 同源同族（同一份 monorepo 构建），仅入口与运行参数不同：
#   CMD ["node", "dist/index.js"]   ← apps/worker/dist/main.js
#
# 构建：
#   docker build -f infra/docker/worker.Dockerfile \
#     -t nmg-pku-alumni/worker:<tag> .
# =============================================================================

ARG NODE_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/node:22-alpine
ARG PNPM_VERSION=11.7.0
ARG NPM_REGISTRY=https://registry.npmmirror.com/

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ARG NPM_REGISTRY
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:${PATH} \
    COREPACK_NPM_REGISTRY=${NPM_REGISTRY} \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    npm_config_registry=${NPM_REGISTRY}
WORKDIR /app
RUN npm install -g pnpm@${PNPM_VERSION} --registry=${NPM_REGISTRY} \
 && node -v \
 && pnpm -v

FROM base AS deps
ARG INSTALL_FLAGS=--frozen-lockfile
ENV CI=true
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY packages ./packages
COPY apps ./apps
RUN --mount=type=cache,id=nmg-pnpm-store,target=/pnpm/store \
    --mount=type=cache,id=nmg-pnpm-meta,target=/pnpm/store/v3/files \
    pnpm config set store-dir /pnpm/store \
 && pnpm install ${INSTALL_FLAGS} --store-dir /pnpm/store

FROM deps AS builder
ARG BUILD_TARGET=@nmg/worker
RUN pnpm --filter "${BUILD_TARGET}..." run build

FROM ${NODE_IMAGE} AS runtime
ARG PNPM_VERSION
ARG NPM_REGISTRY
ARG WORKER_ENTRY=dist/main.js
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:${PATH} \
    COREPACK_NPM_REGISTRY=${NPM_REGISTRY} \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    npm_config_registry=${NPM_REGISTRY} \
    NODE_ENV=production \
    TZ=Asia/Shanghai
WORKDIR /app
RUN npm install -g pnpm@${PNPM_VERSION} --registry=${NPM_REGISTRY} \
 && mkdir -p /app/apps/worker \
 && chown -R node:node /app

COPY --from=deps --chown=node:node /app /app
COPY --from=builder --chown=node:node /app/apps/worker/dist /app/apps/worker/dist

WORKDIR /app/apps/worker
USER node

# Worker 无对外 HTTP 端口：健康检查确认容器主进程仍是 node（未崩溃退出）
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "const fs=require('fs');const c=fs.readFileSync('/proc/1/cmdline','utf8');process.exit(c.includes('node')?0:1)"

CMD ["node", "dist/index.js"]
