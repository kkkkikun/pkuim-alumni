# syntax=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/docker/dockerfile:1.7
# =============================================================================
# NMG-PKU-Alumni —— API 镜像（NestJS）
#
# 构建上下文：仓库根目录（需要 pnpm-workspace.yaml + packages/* + apps/*）
#   docker build -f infra/docker/api.Dockerfile \
#     --build-arg NODE_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/node:22-alpine \
#     -t nmg-pku-alumni/api:<tag> .
#
# 说明：
#   - Docker Hub 直连被阻断，所有官方镜像走华为云镜像源前缀（见 .env.prod）。
#   - pnpm 通过 npm 从 registry.npmmirror.com 安装（corepack 直连 npmjs.org 在本网络不可达）。
#   - 运行镜像保留完整 node_modules（含 devDependencies），以便在容器内执行
#     TypeORM 迁移与 Seed（typeorm CLI 通常是 devDependency）。
#   - 运行阶段使用非 root 用户 node(uid 1000)。
# =============================================================================

ARG NODE_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/node:22-alpine
ARG PNPM_VERSION=11.7.0
ARG NPM_REGISTRY=https://registry.npmmirror.com/

# -----------------------------------------------------------------------------
# base：Node + pnpm（npm 全局安装）
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
# deps：安装 workspace 依赖（带 pnpm store 缓存挂载）
# -----------------------------------------------------------------------------
FROM base AS deps
ARG INSTALL_FLAGS=--frozen-lockfile
ENV CI=true
# 仓库级清单 + workspace 子包（先拷贝目录，保证 pnpm 解析到 workspace 包）
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY packages ./packages
COPY apps ./apps
RUN --mount=type=cache,id=nmg-pnpm-store,target=/pnpm/store \
    --mount=type=cache,id=nmg-pnpm-meta,target=/pnpm/store/v3/files \
    pnpm config set store-dir /pnpm/store \
 && pnpm install ${INSTALL_FLAGS} --store-dir /pnpm/store

# ⚠️ 缺陷 #162：集成测试里有 5 个套件要**读仓库里的部署产物与文档**：
#      - infra/scripts/check-rbac-matrix.mjs（权限点矩阵静态对账）
#      - infra/scripts/check-read-visibility.mjs（可见性口径静态对账）
#      - infra/env/env.prod.example、docker-compose.prod.yml（部署模板自检）
#      - docs/API-SPEC.md、docs/KNOWN-ISSUES.md、docs/DATABASE-DESIGN.md（口径 ↔ 文档对账）
#    回归链是**在容器里**跑 jest 的 → 镜像里没有这些文件，这些用例会假红
#    （ENOENT / 找不到小节，跟实现无关）。镜像本来就带 apps/ 与 packages/ 的源码，
#    再带上 infra/、compose 模板与 docs/ 是同一套思路，且这些文件里**没有密钥**
#    （.env.prod 不在仓库里，env.prod.example 只有占位值）。
#    ⚠️ 这三行必须放在 `pnpm install` **之后**：放在前面会把 install 层缓存冲掉，
#    每次改文档都要重装依赖（多花好几分钟）。
COPY infra ./infra
COPY docker-compose.prod.yml ./docker-compose.prod.yml
COPY docs ./docs

# -----------------------------------------------------------------------------
# builder：编译 @nmg/api（含其 workspace 依赖）
# -----------------------------------------------------------------------------
FROM deps AS builder
ARG BUILD_TARGET=@nmg/api
RUN pnpm --filter "${BUILD_TARGET}..." run build

# -----------------------------------------------------------------------------
# runtime：非 root 运行
# -----------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG PNPM_VERSION
ARG NPM_REGISTRY
ARG API_ENTRY=dist/main.js
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:${PATH} \
    COREPACK_NPM_REGISTRY=${NPM_REGISTRY} \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    npm_config_registry=${NPM_REGISTRY} \
    NODE_ENV=production \
    PORT=3000 \
    TZ=Asia/Shanghai
WORKDIR /app
RUN npm install -g pnpm@${PNPM_VERSION} --registry=${NPM_REGISTRY} \
 && mkdir -p /app/apps/api \
 && chown -R node:node /app

# 依赖（含 workspace 软链结构，整体复制以保持 pnpm 软链有效）
COPY --from=deps --chown=node:node /app /app
# 编译产物覆盖
COPY --from=builder --chown=node:node /app/apps/api/dist /app/apps/api/dist

WORKDIR /app/apps/api
USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=10 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
