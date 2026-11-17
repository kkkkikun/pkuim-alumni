#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 公网边缘反向隧道（在**校园机**上执行）
#
#   bash tunnel-public-edge.sh --public-host <公网IP或域名> --remote-user root
#   bash tunnel-public-edge.sh --public-host <公网IP> --remote-user root --install-systemd
#   bash tunnel-public-edge.sh --check
#
# 为什么是「校园机主动出站」而不是「公网机连进来」：
#   校园机在 NAT 后面且只放行了 SSH 的转发端口（其它端口从公网不可达），
#   而它的**出站**是通的 → 让校园机主动向公网机建立 SSH 反向隧道最稳。
#
# 隧道效果：
#   公网机 127.0.0.1:18080  ──隧道──▶  校园机 127.0.0.1:18080（compose nginx）
#   公网机上的 nginx 再把 /  与 /api/ 反代过去。
#
# 前置条件：
#   1) 公网机已安装 sshd 且允许远程端口转发（默认 AllowTcpForwarding yes）；
#   2) 把本脚本打印的**公钥**加到公网机的 ~/.ssh/authorized_keys；
#   3) 公网机的防火墙放行 80/443。
#
# 幂等：可重复执行；密钥缺失时生成；systemd 单元可重复安装。
#
# 退出码：0 成功；1 失败。
# =============================================================================

set -euo pipefail

PUBLIC_HOST=""
PUBLIC_PORT="22"
REMOTE_USER="root"
LOCAL_PORT="18080"
REMOTE_LISTEN_PORT=""
KEY_PATH="${HOME}/.ssh/nmg_edge_key"
UNIT_NAME="nmg-edge-tunnel.service"
INSTALL_SYSTEMD=0
RUN_DAEMON=0
CHECK_ONLY=0
STOP_ONLY=0
RUN_DIR="${HOME}/.cache/nmg-edge-tunnel"
PID_FILE="${RUN_DIR}/tunnel.pid"
LOG_FILE="${RUN_DIR}/tunnel.log"

log()  { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
warn() { printf '[%s] WARN: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; }
die()  { printf '[%s] ERROR: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; exit 1; }

usage() {
  sed -n '2,40p' "$0"
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --public-host)   PUBLIC_HOST="${2:-}"; [ -n "$PUBLIC_HOST" ] || die "--public-host 需要一个值"; shift 2 ;;
    --public-port)   PUBLIC_PORT="${2:-}"; [ -n "$PUBLIC_PORT" ] || die "--public-port 需要一个值"; shift 2 ;;
    --remote-user)   REMOTE_USER="${2:-}"; [ -n "$REMOTE_USER" ] || die "--remote-user 需要一个值"; shift 2 ;;
    --local-port)    LOCAL_PORT="${2:-}"; [ -n "$LOCAL_PORT" ] || die "--local-port 需要一个值"; shift 2 ;;
    --remote-listen-port) REMOTE_LISTEN_PORT="${2:-}"; [ -n "$REMOTE_LISTEN_PORT" ] || die "--remote-listen-port 需要一个值"; shift 2 ;;
    --key)           KEY_PATH="${2:-}"; [ -n "$KEY_PATH" ] || die "--key 需要一个值"; shift 2 ;;
    --install-systemd) INSTALL_SYSTEMD=1; shift ;;
    --daemon)         RUN_DAEMON=1; shift ;;
    --check)         CHECK_ONLY=1; shift ;;
    --stop)          STOP_ONLY=1; shift ;;
    -h|--help)       usage ;;
    *) die "未知参数：$1" ;;
  esac
done

# 隧道两端端口：默认相同（公网侧 18080 → 校园侧 18080）；
# 用 --remote-listen-port 可以让公网侧监听另一个端口（端口冲突时用）。
REMOTE_LISTEN_PORT="${REMOTE_LISTEN_PORT:-$LOCAL_PORT}"

# --- 停止模式：正式停掉守护进程 + ssh 子进程（否则端口会一直被占）-----------
if [ "$STOP_ONLY" -eq 1 ]; then
  STOPPED=0
  if [ -f "$PID_FILE" ]; then
    OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
      kill "$OLD_PID" 2>/dev/null || true
      sleep 1
      if kill -0 "$OLD_PID" 2>/dev/null; then
        kill -9 "$OLD_PID" 2>/dev/null || true
      fi
      log "已停止守护进程（pid ${OLD_PID}）"
      STOPPED=1
    fi
  fi
  if [ -f "${RUN_DIR}/ssh.pid" ]; then
    SSH_PID_OLD="$(cat "${RUN_DIR}/ssh.pid" 2>/dev/null || true)"
    if [ -n "$SSH_PID_OLD" ] && kill -0 "$SSH_PID_OLD" 2>/dev/null; then
      kill "$SSH_PID_OLD" 2>/dev/null || true
      sleep 1
      kill -9 "$SSH_PID_OLD" 2>/dev/null || true
      log "已停止 ssh 子进程（pid ${SSH_PID_OLD}）"
      STOPPED=1
    fi
    unlink "${RUN_DIR}/ssh.pid" 2>/dev/null || true
  fi
  [ -f "$PID_FILE" ] && unlink "$PID_FILE" 2>/dev/null || true
  if [ "$STOPPED" -eq 1 ]; then
    log "=== 隧道已停止 ==="
  else
    log "没有正在运行的隧道守护进程"
  fi
  exit 0
fi

# --- 自检模式 -----------------------------------------------------------------
if [ "$CHECK_ONLY" -eq 1 ]; then
  log "检查本机后端 ${LOCAL_PORT} ……"
  if curl -fsS --max-time 8 "http://127.0.0.1:${LOCAL_PORT}/api/v1/system/health" >/dev/null 2>&1; then
    log "  ✓ 校园机后端 127.0.0.1:${LOCAL_PORT} 可达"
  else
    warn "  ✗ 校园机后端 127.0.0.1:${LOCAL_PORT} 不可达 —— compose nginx 是否在跑？"
    exit 1
  fi
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active "$UNIT_NAME" >/dev/null 2>&1; then
    log "  ✓ ${UNIT_NAME} 运行中"
  elif [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
    log "  ✓ 后台隧道守护进程运行中（pid $(cat "$PID_FILE")）"
  else
    warn "  ⚠️ 隧道守护进程未运行"
    exit 1
  fi
  exit 0
fi

[ -n "$PUBLIC_HOST" ] || die "缺少 --public-host"

command -v ssh >/dev/null 2>&1 || die "缺少 ssh 命令"
command -v ssh-keygen >/dev/null 2>&1 || die "缺少 ssh-keygen 命令"

# --- 1. 专用密钥（不放仓库）--------------------------------------------------
mkdir -p "$(dirname "$KEY_PATH")"
chmod 700 "$(dirname "$KEY_PATH")"
if [ ! -f "$KEY_PATH" ]; then
  log "生成隧道专用密钥：${KEY_PATH}"
  ssh-keygen -t ed25519 -N '' -C "nmg-edge-tunnel" -f "$KEY_PATH" >/dev/null
fi
chmod 600 "$KEY_PATH"
PUBKEY="$(cat "${KEY_PATH}.pub")"

log "隧道专用公钥（请加到**公网机** ${REMOTE_USER} 用户的 ~/.ssh/authorized_keys）："
printf '%s\n' "$PUBKEY"

# --- 2. 连通性预检 -----------------------------------------------------------
log "预检 ${REMOTE_USER}@${PUBLIC_HOST}:${PUBLIC_PORT} ……"
if ssh -i "$KEY_PATH" -p "$PUBLIC_PORT" \
      -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new \
      "${REMOTE_USER}@${PUBLIC_HOST}" true 2>/dev/null; then
  log "  ✓ SSH 可达且密钥已被接受"
else
  warn "  ⚠️ SSH 不可达或公钥尚未被接受。"
  warn "     请把上面的公钥加到公网机：${REMOTE_USER}@${PUBLIC_HOST} 的 ~/.ssh/authorized_keys"
  warn "     （如果还没加公钥，这一步必然失败，属预期）"
fi

SSH_OPTS="-i ${KEY_PATH} -p ${PUBLIC_PORT} -o BatchMode=yes -o ExitOnForwardFailure=yes \
-o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new"

# --- 3. 后台守护（不需要 root；校园机账号没有免密 sudo）---------------------
if [ "$RUN_DAEMON" -eq 1 ]; then
  mkdir -p "$RUN_DIR"
  RUNNER="${RUN_DIR}/run-tunnel.sh"
  cat > "$RUNNER" <<EOF
#!/usr/bin/env bash
# 由 tunnel-public-edge.sh 生成：隧道重连守护循环
LOG="${LOG_FILE}"
SSH_PID=""
cleanup() {
  # 必须连 ssh 子进程一起收掉 —— 只 kill 父 bash 会把端口留在那儿（真实踩过）
  if [ -n "\$SSH_PID" ]; then
    kill "\$SSH_PID" 2>/dev/null
    wait "\$SSH_PID" 2>/dev/null
  fi
}
trap cleanup EXIT
# 收到停止信号：收尾并**退出循环**。
# ⚠️ 只 kill 子进程而不 exit 的话，while true 会立刻把隧道重新拉起来（真实踩过）。
on_stop() { cleanup; exit 0; }
trap on_stop TERM INT
while true; do
  echo "\$(date '+%Y-%m-%d %H:%M:%S') [tunnel] 建立隧道 ${REMOTE_USER}@${PUBLIC_HOST}:${PUBLIC_PORT} ..."
  /usr/bin/ssh -NT ${SSH_OPTS} -R 127.0.0.1:${REMOTE_LISTEN_PORT}:127.0.0.1:${LOCAL_PORT} ${REMOTE_USER}@${PUBLIC_HOST} &
  SSH_PID=\$!
  echo "\$SSH_PID" > "${RUN_DIR}/ssh.pid"
  wait "\$SSH_PID"
  echo "\$(date '+%Y-%m-%d %H:%M:%S') [tunnel] 断开（exit=\$?），10 秒后重连"
  SSH_PID=""
  sleep 10
done
EOF
  chmod 700 "$RUNNER"

  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
    log "已有守护进程在跑（pid $(cat "$PID_FILE")），先停掉旧的"
    kill "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null || true
    # 等它真的死（它的 TERM trap 会收掉 ssh 子进程）
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null || break
      sleep 0.5
    done
  fi
  # 兜底：万一旧守护没把 ssh 子进程收掉，这里再杀一次并等它死
  # （否则远端监听端口会被一直占住，新隧道起不来 —— 真实踩过）
  if [ -f "${RUN_DIR}/ssh.pid" ]; then
    OLD_SSH="$(cat "${RUN_DIR}/ssh.pid" 2>/dev/null || true)"
    if [ -n "$OLD_SSH" ] && kill -0 "$OLD_SSH" 2>/dev/null; then
      kill "$OLD_SSH" 2>/dev/null || true
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        kill -0 "$OLD_SSH" 2>/dev/null || break
        sleep 0.5
      done
      kill -9 "$OLD_SSH" 2>/dev/null || true
    fi
  fi

  nohup "$RUNNER" >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 2
  if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    log "  ✓ 后台隧道守护已启动（pid $(cat "$PID_FILE")）"
  else
    warn "  ✗ 守护进程启动失败，日志见 ${LOG_FILE}"
    exit 1
  fi
  log "  日志：${LOG_FILE}"
  log "  自检：bash $(basename "$0") --check"
  exit 0
fi

# --- 4. systemd 单元（有 root 时更稳：崩溃自动拉起 + 开机自启）--------------
if [ "$INSTALL_SYSTEMD" -eq 1 ]; then
  command -v systemctl >/dev/null 2>&1 || die "本机没有 systemd"
  if [ ! -w "/etc/systemd/system" ]; then
    die "无权写 /etc/systemd/system（需要 root）。
     本机账号若无免密 sudo，请改用不需要 root 的后台模式：
       bash $(basename "$0") --public-host ${PUBLIC_HOST} --remote-user ${REMOTE_USER} --daemon"
  fi
  UNIT_PATH="/etc/systemd/system/${UNIT_NAME}"
  [ -f "$UNIT_PATH" ] && cp -p "$UNIT_PATH" "${UNIT_PATH}.bak.$(date +%Y%m%d-%H%M%S)"

  cat > "$UNIT_PATH" <<EOF
[Unit]
Description=NMG-PKU-Alumni 公网边缘反向隧道
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/ssh -NT ${SSH_OPTS} -R 127.0.0.1:${REMOTE_LISTEN_PORT}:127.0.0.1:${LOCAL_PORT} ${REMOTE_USER}@${PUBLIC_HOST}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

  chmod 644 "$UNIT_PATH"
  systemctl daemon-reload
  systemctl enable "$UNIT_NAME" >/dev/null 2>&1 || true
  systemctl restart "$UNIT_NAME"
  sleep 2
  if systemctl is-active "$UNIT_NAME" >/dev/null 2>&1; then
    log "  ✓ ${UNIT_NAME} 已启动"
  else
    warn "  ✗ ${UNIT_NAME} 启动失败："
    systemctl status "$UNIT_NAME" --no-pager -l 2>&1 | head -20 >&2 || true
    exit 1
  fi
  log "  查看隧道日志：journalctl -u ${UNIT_NAME} -f"
else
  # --- 4. 前台模式（调试用）----------------------------------------------
  log "前台建立隧道（Ctrl-C 断开）……"
  # shellcheck disable=SC2086
  exec ssh -NT ${SSH_OPTS} -R "127.0.0.1:${REMOTE_LISTEN_PORT}:127.0.0.1:${LOCAL_PORT}" "${REMOTE_USER}@${PUBLIC_HOST}"
fi
