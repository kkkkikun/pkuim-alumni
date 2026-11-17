#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 容器与依赖健康检查（服务器侧执行）
#
#   bash infra/scripts/healthcheck.sh                 # 检查一次
#   bash infra/scripts/healthcheck.sh --wait          # 等待全部健康（默认 300s）
#   bash infra/scripts/healthcheck.sh --wait --timeout 600
#   bash infra/scripts/healthcheck.sh --quiet
#
# 检查项：
#   1) 每个容器的运行状态与 healthcheck 状态
#   2) nginx /healthz 探针（经反向代理到 API）
#   3) MySQL ping
#   4) Redis ping
#   5) MinIO 存活探针（通过容器 health 状态判定）
#
# 退出码：0 全部通过；1 存在失败项。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

WAIT=0
QUIET=0
TIMEOUT="${HEALTHCHECK_TIMEOUT:-300}"

while [ $# -gt 0 ]; do
  case "$1" in
    --wait)    WAIT=1; shift ;;
    --timeout) TIMEOUT="${2:-}"; [ -n "$TIMEOUT" ] || die "--timeout 需要一个值"; shift 2 ;;
    --quiet)   QUIET=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

say() { [ "$QUIET" -eq 1 ] || log "$*"; }

# --- 单项检查函数（返回 0/1，不因失败中断整个脚本）---------------------------
check_containers() {
  local failed=0 cid name state health exit_code
  local ids
  ids="$(compose ps -q --all 2>/dev/null || true)"
  if [ -z "$ids" ]; then
    say "FAIL: 未找到本项目容器（compose ps 为空）"
    return 1
  fi
  for cid in $ids; do
    name="$(docker inspect -f '{{.Name}}' "$cid" 2>/dev/null || echo "unknown")"
    state="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || echo "unknown")"
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo "unknown")"
    exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$cid" 2>/dev/null || echo "unknown")"
    name="${name#/}"
    if [ "$state" = "running" ] && { [ "$health" = "healthy" ] || [ "$health" = "none" ]; }; then
      say "OK  : ${name}  state=${state} health=${health}"
    elif [ "$state" = "exited" ] && [ "$exit_code" = "0" ]; then
      # 一次性任务（如 minio-init）正常退出即视为成功
      say "OK  : ${name}  state=${state} exit=${exit_code}（一次性任务已完成）"
    else
      say "FAIL: ${name}  state=${state} health=${health} exit=${exit_code}"
      failed=1
    fi
  done
  return "$failed"
}

check_http() {
  local port url code
  port="$(env_get_or NGINX_HTTP_PORT 18080)"
  url="http://127.0.0.1:${port}/healthz"
  if command -v curl >/dev/null 2>&1; then
    code="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || echo 000)"
  else
    code="$(wget -q -O /dev/null "$url" >/dev/null 2>&1 && echo 200 || echo 000)"
  fi
  if [ "$code" = "200" ]; then
    say "OK  : ${url} → 200"
    return 0
  fi
  say "FAIL: ${url} → ${code}"
  return 1
}

check_mysql() {
  local pass
  pass="$(env_get_or MYSQL_ROOT_PASSWORD "")"
  if compose exec -T mysql mysqladmin ping -h 127.0.0.1 -uroot -p"${pass}" --silent >/dev/null 2>&1; then
    say "OK  : MySQL ping"
    return 0
  fi
  say "FAIL: MySQL ping"
  return 1
}

check_redis() {
  local pass out
  pass="$(env_get_or REDIS_PASSWORD "")"
  out="$(compose exec -T redis redis-cli -a "${pass}" --no-auth-warning ping 2>/dev/null || true)"
  if printf '%s' "$out" | grep -q "PONG"; then
    say "OK  : Redis ping"
    return 0
  fi
  say "FAIL: Redis ping"
  return 1
}

# --- 主流程 -----------------------------------------------------------------
run_once() {
  local rc=0
  check_containers || rc=1
  check_http      || rc=1
  check_mysql     || rc=1
  check_redis     || rc=1
  return "$rc"
}

if [ "$WAIT" -eq 1 ]; then
  log "等待全部服务健康（超时 ${TIMEOUT}s）……"
  deadline=$(( $(date +%s) + TIMEOUT ))
  last=""
  while :; do
    if out="$(run_once 2>&1)"; then
      printf '%s\n' "$out"
      log "全部健康"
      exit 0
    fi
    last="$out"
    if [ "$(date +%s)" -ge "$deadline" ]; then
      printf '%s\n' "$last"
      die "等待超时（${TIMEOUT}s），仍有服务未健康"
    fi
    sleep 5
  done
else
  if run_once; then
    log "健康检查通过"
    exit 0
  fi
  die "健康检查未通过"
fi
