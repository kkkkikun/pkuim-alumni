#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— k6 并发压测执行器
#
# 在服务器上执行：
#   bash infra/scripts/loadtest.sh                        # 全部场景，VUS 20/50/100/200
#   bash infra/scripts/loadtest.sh --scenarios=login,directory
#   bash infra/scripts/loadtest.sh --vus=50 --duration=60s
#   bash infra/scripts/loadtest.sh --base=http://127.0.0.1:18080
#
# 依赖：k6 二进制。安装（学校私网内 Go + goproxy.cn 可达时）：
#   GOPROXY=https://goproxy.cn,direct GOBIN=~/bin go install go.k6.io/k6@v0.50.0
#   或 apt/手动放置到 PATH
#
# 安全约束：
#   - 只对私网 API 发起请求，不修改任何数据卷；
#   - 结果落盘到 tests/concurrency/results/，便于归档到 TEST-REPORT。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

BASE_URL="${BASE_URL:-http://127.0.0.1:18080}"
API_PREFIX="${API_PREFIX:-/api/v1}"
VUS_LEVELS="${VUS_LEVELS:-20 50 100 200}"
DURATION="${DURATION:-60s}"
SCENARIOS="${SCENARIOS:-login directory connection-request event-registration resource-submit}"
RESULTS_DIR="${RESULTS_DIR:-${PROJECT_ROOT}/tests/concurrency/results}"
K6_BIN="${K6_BIN:-$(command -v k6 || true)}"
# 压测期间放宽限流阈值（单机压测所有登录都来自同一 IP，必然触发登录限流；
# 压测目的是测吞吐与业务正确性，不是测保护机制）。压测结束后自动回滚。
RELAX_RATE_LIMIT="${RELAX_RATE_LIMIT:-1}"
RELAX_AUTH="${RELAX_AUTH:-100000}"
RELAX_DEFAULT="${RELAX_DEFAULT:-100000}"
RELAX_WRITE="${RELAX_WRITE:-100000}"

# 同时支持 `--key value` 与 `--key=value` 两种写法
while [ $# -gt 0 ]; do
  case "$1" in
    --base=*)       BASE_URL="${1#*=}" ;;
    --base)         BASE_URL="${2:-}"; shift ;;
    --vus=*)        VUS_LEVELS="${1#*=}" ;;
    --vus)          VUS_LEVELS="${2:-}"; shift ;;
    --duration=*)   DURATION="${1#*=}" ;;
    --duration)     DURATION="${2:-}"; shift ;;
    --scenarios=*)  SCENARIOS="${1#*=}" ;;
    --scenarios)    SCENARIOS="${2:-}"; shift ;;
    --k6=*)         K6_BIN="${1#*=}" ;;
    --k6)           K6_BIN="${2:-}"; shift ;;
    --no-relax)     RELAX_RATE_LIMIT=0 ;;
    -h|--help)      sed -n '2,22p' "$0"; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
  shift
done

[ -n "$K6_BIN" ] || die "未找到 k6 可执行文件（请设置 K6_BIN 或 --k6 /path/to/k6）"
[ -x "$K6_BIN" ] || die "k6 不可执行：$K6_BIN"

# 场景列表支持逗号或空格分隔
SCENARIOS="${SCENARIOS//,/ }"
VUS_LEVELS="${VUS_LEVELS//,/ }"

mkdir -p "$RESULTS_DIR"
log "k6 = $("$K6_BIN" version 2>/dev/null | head -1)"
log "base = $BASE_URL   duration = $DURATION   vus = $VUS_LEVELS"

export BASE_URL API_PREFIX DURATION
export SUMMARY_DIR="$RESULTS_DIR"
# 压测账号数量：必须与 Seed 中的 SEED_LOADTEST_COUNT 一致，
# 否则不同 VU 会复用同一账号（活动报名场景将无法验证名额争抢）。
export LOADTEST_COUNT="${LOADTEST_COUNT:-200}"

FAILED_SCENARIOS=()

# --- 限流放宽（可回滚）-------------------------------------------------------
restore_rate_limit() {
  if [ "$RELAXED" = "1" ] && [ -f "${ENV_FILE}.pre-loadtest" ]; then
    cp -p "${ENV_FILE}.pre-loadtest" "$ENV_FILE"
    log "已恢复 .env.prod 中的限流配置"
    compose up -d api >/dev/null 2>&1 || warn "api 重启失败，请手动检查"
    sleep 12
  fi
}
trap restore_rate_limit EXIT

if [ "$RELAX_RATE_LIMIT" -eq 1 ]; then
  log "放宽限流阈值（压测结束后自动回滚）……"
  cp -p "$ENV_FILE" "${ENV_FILE}.pre-loadtest"
  set_env_var RATE_LIMIT_AUTH "$RELAX_AUTH"
  set_env_var RATE_LIMIT_DEFAULT "$RELAX_DEFAULT"
  set_env_var RATE_LIMIT_WRITE "$RELAX_WRITE"
  compose up -d api >/dev/null 2>&1 || die "api 重启失败"
  sleep 15
  RELAXED=1
fi

run_one() {
  local scenario="$1" vus="$2"
  local script="${PROJECT_ROOT}/tests/concurrency/${scenario}.js"
  [ -f "$script" ] || die "缺少压测脚本：$script"

  log "▶ 场景 ${scenario} · VUS=${vus} · ${DURATION}"
  export VUS="$vus"
  export SUMMARY_PREFIX="${scenario}"

  # 活动报名场景需要容量参数：名额远小于 VU 才能验证不超卖
  if [ "$scenario" = "event-registration" ]; then
    export EVENT_CAPACITY="${EVENT_CAPACITY:-10}"
    export EVENT_ID="${EVENT_ID:-}"
    export ADMIN_USER="${ADMIN_USER:-admin}"
    export ADMIN_PASS="${ADMIN_PASS:-Admin@2026}"
  fi

  local log_file="${RESULTS_DIR}/${scenario}-${vus}vu.log"
  set +e
  "$K6_BIN" run \
    --no-usage-report \
    --summary-export "${RESULTS_DIR}/${scenario}-${vus}vu-summary.json" \
    "$script" > "$log_file" 2>&1
  local rc=$?
  set -e
  # 摘取关键指标行（供日志与交付报告引用）
  grep -E "checks\.|iterations\.|http_req_duration\.|http_req_failed\.|data_points" "$log_file" | head -20 || true

  # 脱敏：k6 会把 setup 阶段拿到的访问令牌明文写进结果文件，
  # 而结果是会被归档 / 同步 / 贴进报告的产物 —— 不能留明文凭据。
  node "${PROJECT_ROOT}/infra/scripts/redact-loadtest-results.mjs" \
    "${RESULTS_DIR}/${scenario}-${vus}vu-summary.json" "$log_file" >/dev/null 2>&1 || true

  if [ "$rc" -ne 0 ]; then
    FAILED_SCENARIOS+=("${scenario}@${vus}vu")
    warn "场景 ${scenario} VUS=${vus} 阈值未通过（k6 退出码 ${rc}）"
  else
    log "场景 ${scenario} VUS=${vus} 阈值全部通过 ✅"
  fi
}

for scenario in $SCENARIOS; do
  for vus in $VUS_LEVELS; do
    run_one "$scenario" "$vus"
  done
done

log "结果目录：${RESULTS_DIR}"

if [ "${#FAILED_SCENARIOS[@]}" -gt 0 ]; then
  die "以下场景未通过阈值：${FAILED_SCENARIOS[*]}"
fi

log "全部压测场景通过 ✅"
