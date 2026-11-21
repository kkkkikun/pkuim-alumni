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
#   6) **共享失效总线**逐实例自证（多实例部署时「某个实例没订阅上总线」要出现在输出里）
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

# --- 共享失效总线：逐实例自证（第八轮新增）-----------------------------------
#
# 为什么需要它：
#   多实例部署时「跨实例撤权 / 字典失效生效没有」此前只能靠人记得
#   逐个实例去 curl `GET /api/v1/admin/ops/invalidation-bus` ——
#   忘了就没人知道「有个实例压根没订阅上频道」，
#   而那一档的撤权延迟会**回落到 TTL 上界**（≤60 秒 / ≤300 秒），
#   表现成「偶尔撤权不生效」，极难定位。
#   把它接进既有巡检脚本，就是让这件事**出现在巡检输出里**，而不是靠人记得。
#
# 读法（口径见 docs/SECURITY.md 第 2.1.9 节、docs/SERVER-OPERATIONS.md 第 2.1 节）：
#   enabled=0   → 总线被整条关闭（`RBAC_INVALIDATION_ENABLED=false`），不是故障；
#   subscribed=0 且 enabled=1 → **这个实例没订阅上总线** → FAIL
#                                （多实例下这一实例的撤权延迟回落到 TTL 上界）；
#   channel     → 生效频道，**所有实例必须一致**，否则事件互相打不到。
#
# 认证：该端点只对管理员开放，所以这里要一个管理员凭据。
#   取值顺序：`ADMIN_HEALTHCHECK_TOKEN` > `ADMIN_HEALTHCHECK_USERNAME/PASSWORD`
#   > `.env.prod` 里的 `ADMIN_BOOTSTRAP_USERNAME/PASSWORD`。
#   ⚠️ 都取不到时**跳过**这一项（不是失败）——
#      巡检脚本不该因为「运维没配凭据」就把整次巡检判成失败；
#      但跳过这件事本身要**打印出来**，不能静默。
check_invalidation_bus() {
  local token username password cid name out
  local status enabled subscribed degraded channel message
  local failed=0
  local ids
  local CHANNELS=""

  token="$(env_get_or ADMIN_HEALTHCHECK_TOKEN "")"
  username="$(env_get_or ADMIN_HEALTHCHECK_USERNAME "")"
  password="$(env_get_or ADMIN_HEALTHCHECK_PASSWORD "")"
  if [ -z "$token" ] && { [ -z "$username" ] || [ -z "$password" ]; }; then
    username="$(env_get_or ADMIN_BOOTSTRAP_USERNAME "")"
    password="$(env_get_or ADMIN_BOOTSTRAP_PASSWORD "")"
  fi
  if [ -z "$token" ] && { [ -z "$username" ] || [ -z "$password" ]; }; then
    say "SKIP: 共享失效总线自证 —— 未提供管理员凭据（ADMIN_HEALTHCHECK_TOKEN 或 ADMIN_HEALTHCHECK_USERNAME/PASSWORD）"
    return 0
  fi

  ids="$(compose ps -q api 2>/dev/null || true)"
  if [ -z "$ids" ]; then
    say "SKIP: 共享失效总线自证 —— 未找到 API 容器"
    return 0
  fi

  for cid in $ids; do
    name="$(docker inspect -f '{{.Name}}' "$cid" 2>/dev/null || echo unknown)"
    name="${name#/}"
    # 在**容器内部**查这个实例自己 —— 经 nginx 查只会打到负载均衡后的某一个实例，
    # 那样就看不出「到底是哪一台没订阅上」了。
    out="$(
      docker exec \
        -e BUS_TOKEN="$token" \
        -e BUS_USERNAME="$username" \
        -e BUS_PASSWORD="$password" \
        -e BUS_PORT="${API_INTERNAL_PORT:-3000}" \
        -e BUS_PREFIX="${API_PREFIX:-/api/v1}" \
        "$cid" node -e '
          const base = `http://127.0.0.1:${process.env.BUS_PORT}${process.env.BUS_PREFIX}`;
          const emit = (status, enabled, subscribed, degraded, channel, message) =>
            console.log([status, enabled, subscribed, degraded, channel, message].join("\t"));
          (async () => {
            let token = process.env.BUS_TOKEN || "";
            if (!token) {
              const login = await fetch(`${base}/auth/admin/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  username: process.env.BUS_USERNAME,
                  password: process.env.BUS_PASSWORD,
                }),
              });
              const body = await login.json().catch(() => ({}));
              token = body?.data?.accessToken || "";
              if (!token) {
                emit("UNAUTHORIZED", "", "", "", "", `管理员登录失败（HTTP ${login.status}）`);
                return;
              }
            }
            const res = await fetch(`${base}/admin/ops/invalidation-bus`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            const body = await res.json().catch(() => ({}));
            if (res.status !== 200 || !body?.data) {
              emit("ERROR", "", "", "", "", `查询失败（HTTP ${res.status}）`);
              return;
            }
            const d = body.data;
            emit("OK", String(d.enabled), String(d.subscribed), String(d.degraded), String(d.channel ?? ""), String(d.lastError ?? ""));
          })().catch((e) => {
            emit("ERROR", "", "", "", "", String((e && e.message) || e));
          });
        ' 2>&1
    )"

    IFS=$'\t' read -r status enabled subscribed degraded channel message <<<"$out"
    case "$status" in
      OK) ;;
      UNAUTHORIZED)
        # ⚠️ 凭据无效 = 这一项**没查成**，不是「总线坏了」——
        #    报成 FAIL 会让人去查总线，而真实原因是巡检用的管理员口令不对。
        say "WARN: ${name} 共享失效总线自证 —— ${message}（管理员凭据无效，这一项**没查成**；请核对 ADMIN_HEALTHCHECK_* / ADMIN_BOOTSTRAP_*）"
        continue
        ;;
      *)
        say "FAIL: ${name} 共享失效总线自证 —— ${message}"
        failed=1
        continue
        ;;
    esac

    if [ "$enabled" = "1" ] && [ "$subscribed" = "0" ]; then
      say "FAIL: ${name} 共享失效总线 —— enabled=1 但 subscribed=0（本实例没订阅上频道 ${channel}，撤权延迟回落到 TTL 上界）"
      failed=1
      continue
    fi
    if [ "$enabled" = "0" ]; then
      say "OK  : ${name} 共享失效总线 —— 总线已整条关闭（enabled=0，非故障）"
      continue
    fi
    if [ "$degraded" = "1" ]; then
      say "FAIL: ${name} 共享失效总线 —— degraded=1（enabled=1 但没订阅上频道 ${channel}）"
      failed=1
      continue
    fi
    if [ -n "$message" ] && [ "$message" != "null" ]; then
      say "WARN: ${name} 共享失效总线 —— 最近一次总线错误：${message}"
    fi
    CHANNELS="${CHANNELS}${channel}
"
    say "OK  : ${name} 共享失效总线 —— subscribed=1 channel=${channel}"
  done

  # 所有实例的频道名必须一致，否则事件互相打不到
  # （频道名按环境隔离，实例之间不一致 = 事件互相打不到，
  #   表现成「有时生效有时不生效」，比完全失效更难定位）
  local unique_channels
  unique_channels="$(printf '%s\n' $CHANNELS | sort -u | tr -d '\r')"
  local channel_count
  channel_count="$(printf '%s\n' "$unique_channels" | grep -c . || true)"
  if [ "$channel_count" -gt 1 ]; then
    say "FAIL: 共享失效总线 —— 各实例的频道名不一致（$(printf '%s' "$unique_channels" | tr '\n' ' ')），事件互相打不到"
    failed=1
  fi

  return "$failed"
}

# --- 主流程 -----------------------------------------------------------------
run_once() {
  local rc=0
  check_containers || rc=1
  check_http      || rc=1
  check_mysql     || rc=1
  check_redis     || rc=1
  check_invalidation_bus || rc=1
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
