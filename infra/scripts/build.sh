#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 服务器侧镜像构建（BuildKit）
#
# 在服务器上执行（不要在本地执行）：
#   bash infra/scripts/build.sh                       # 使用默认发布标签
#   RELEASE_TAG=20261115-01 bash infra/scripts/build.sh
#
# 产出镜像（本地 tag，不推送任何仓库——服务器无法访问 Docker Hub）：
#   ${IMAGE_REGISTRY}/api:${RELEASE_TAG}
#   ${IMAGE_REGISTRY}/worker:${RELEASE_TAG}
#   ${IMAGE_REGISTRY}/admin-web:${RELEASE_TAG}
#
# 资源预算（top.md §9.4）：Docker 构建 24 核 / 64GB
#   本脚本串行构建三个镜像，避免并发构建互相抢占内存；
#   pnpm store 使用 BuildKit cache mount，重复构建命中缓存。
#
# 安全约束：不执行任何 prune / volume rm / 全局 compose down。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

RELEASE_TAG="${RELEASE_TAG:-$(date '+%Y%m%d-%H%M%S')}"
IMAGE_REGISTRY="${IMAGE_REGISTRY:-$(env_get_or IMAGE_REGISTRY nmg-pku-alumni)}"
NODE_IMAGE="${NODE_IMAGE:-$(env_get_or NODE_IMAGE swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/node:22-alpine)}"
NGINX_IMAGE="${NGINX_IMAGE:-$(env_get_or NGINX_IMAGE swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/nginx:alpine)}"
PNPM_VERSION="${PNPM_VERSION:-$(env_get_or PNPM_VERSION 11.7.0)}"
NPM_REGISTRY="${NPM_REGISTRY:-$(env_get_or NPM_REGISTRY https://registry.npmmirror.com/)}"
INSTALL_FLAGS="${INSTALL_FLAGS:-$(env_get_or INSTALL_FLAGS --frozen-lockfile)}"
BUILD_TARGETS="${BUILD_TARGETS:-api worker admin-web}"

export DOCKER_BUILDKIT=1
export BUILDKIT_PROGRESS=plain

require_cmd docker
require_file "${PROJECT_ROOT}/docker-compose.prod.yml"

log "构建目录：${PROJECT_ROOT}"
log "发布标签：${RELEASE_TAG}"

# --- 1. 环境文件 -------------------------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  log ".env.prod 不存在，执行 init-env.sh 生成"
  bash "${SCRIPT_DIR}/init-env.sh"
fi
require_file "$ENV_FILE"

# --- 2. pnpm 锁文件（Dockerfile COPY 依赖它必须存在）-------------------------
if [ ! -f "${PROJECT_ROOT}/pnpm-lock.yaml" ]; then
  warn "缺少 pnpm-lock.yaml，尝试用 pnpm 生成（需要能访问 ${NPM_REGISTRY}）"
  command -v pnpm >/dev/null 2>&1 || die "服务器未安装 pnpm，请手动生成 pnpm-lock.yaml 后重试"
  ( cd "$PROJECT_ROOT" && pnpm install --lockfile-only --ignore-scripts --registry "$NPM_REGISTRY" )
  warn "已在服务器生成 pnpm-lock.yaml（未提交到仓库，请本地重新生成并提交）"
fi

# --- 3. .npmrc（registry 指向 npmmirror）------------------------------------
if [ ! -f "${PROJECT_ROOT}/.npmrc" ]; then
  warn "缺少 .npmrc，写入 registry.npmmirror.com"
  printf 'registry=%s/\nstrict-peer-dependencies=false\nauto-install-peers=true\nresolution-mode=highest\nlink-workspace-packages=true\n' "$NPM_REGISTRY" > "${PROJECT_ROOT}/.npmrc"
fi

# --- 4. 记录上一版本镜像（供 rollback.sh 使用）--------------------------------
PREV_API="$(env_get_or API_IMAGE "")"
PREV_WORKER="$(env_get_or WORKER_IMAGE "")"
PREV_ADMIN="$(env_get_or ADMIN_WEB_IMAGE "")"
PREV_TAG="$(env_get_or RELEASE_TAG "")"
if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "$RELEASE_TAG" ]; then
  {
    printf 'RELEASE_TAG=%s\n' "$PREV_TAG"
    printf 'API_IMAGE=%s\n' "$PREV_API"
    printf 'WORKER_IMAGE=%s\n' "$PREV_WORKER"
    printf 'ADMIN_WEB_IMAGE=%s\n' "$PREV_ADMIN"
  } > "${PROJECT_ROOT}/.env.prod.prev"
  chmod 600 "${PROJECT_ROOT}/.env.prod.prev"
  log "已记录上一版本镜像到 .env.prod.prev（RELEASE_TAG=${PREV_TAG}）"
fi

# --- 5. 构建 -----------------------------------------------------------------
build_one() {
  local service="$1" dockerfile="$2" image="$3"
  shift 3
  log "构建 ${service} → ${image}"
  docker build \
    --file "${dockerfile}" \
    --tag "${image}" \
    --tag "${image%%:*}:latest" \
    --build-arg "NODE_IMAGE=${NODE_IMAGE}" \
    --build-arg "NGINX_IMAGE=${NGINX_IMAGE}" \
    --build-arg "PNPM_VERSION=${PNPM_VERSION}" \
    --build-arg "NPM_REGISTRY=${NPM_REGISTRY}" \
    --build-arg "INSTALL_FLAGS=${INSTALL_FLAGS}" \
    "$@" \
    "${PROJECT_ROOT}"
}

for target in $BUILD_TARGETS; do
  case "$target" in
    api)
      build_one api "${PROJECT_ROOT}/infra/docker/api.Dockerfile" \
        "${IMAGE_REGISTRY}/api:${RELEASE_TAG}"
      ;;
    worker)
      build_one worker "${PROJECT_ROOT}/infra/docker/worker.Dockerfile" \
        "${IMAGE_REGISTRY}/worker:${RELEASE_TAG}"
      ;;
    admin-web)
      build_one admin-web "${PROJECT_ROOT}/infra/docker/admin-web.Dockerfile" \
        "${IMAGE_REGISTRY}/admin-web:${RELEASE_TAG}"
      ;;
    *)
      die "未知构建目标：${target}"
      ;;
  esac
done

# --- 6. 写回 .env.prod（供 compose 使用具体标签，便于回滚）---------------------
set_env_var RELEASE_TAG      "$RELEASE_TAG"
set_env_var API_IMAGE       "${IMAGE_REGISTRY}/api:${RELEASE_TAG}"
set_env_var WORKER_IMAGE    "${IMAGE_REGISTRY}/worker:${RELEASE_TAG}"
set_env_var ADMIN_WEB_IMAGE "${IMAGE_REGISTRY}/admin-web:${RELEASE_TAG}"

log "构建完成：${RELEASE_TAG}"
log "镜像：${IMAGE_REGISTRY}/api:${RELEASE_TAG} ${IMAGE_REGISTRY}/worker:${RELEASE_TAG} ${IMAGE_REGISTRY}/admin-web:${RELEASE_TAG}"
