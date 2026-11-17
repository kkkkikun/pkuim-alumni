# syntax=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/docker/dockerfile:1.7
# =============================================================================
# NMG-PKU-Alumni —— 管理后台镜像（Vue3 + Vite → 静态产物 → nginx）
#
# 构建：
#   docker build -f infra/docker/admin-web.Dockerfile \
#     -t nmg-pku-alumni/admin-web:<tag> .
#
# 运行阶段使用官方 nginx:alpine（走华为云镜像源前缀）托管 dist/，
# SPA 路由回退由 infra/nginx/admin-web.conf 提供。
# =============================================================================

ARG NODE_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/node:22-alpine
ARG NGINX_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/nginx:alpine
ARG PNPM_VERSION=11.7.0
ARG NPM_REGISTRY=https://registry.npmmirror.com/

# -----------------------------------------------------------------------------
# base：Node + pnpm
# -----------------------------------------------------------------------------
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

# -----------------------------------------------------------------------------
# deps：安装依赖
# -----------------------------------------------------------------------------
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

# -----------------------------------------------------------------------------
# builder：构建 @nmg/admin-web
# -----------------------------------------------------------------------------
FROM deps AS builder
ARG BUILD_TARGET=@nmg/admin-web
ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN pnpm --filter "${BUILD_TARGET}..." run build

# -----------------------------------------------------------------------------
# runtime：nginx 静态托管
# -----------------------------------------------------------------------------
FROM ${NGINX_IMAGE} AS runtime
ARG ADMIN_DIST=apps/admin-web/dist
COPY --from=builder /app/${ADMIN_DIST} /usr/share/nginx/html
COPY infra/nginx/admin-web.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=10 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
