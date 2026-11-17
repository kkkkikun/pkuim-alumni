#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 在公网服务器上准备「隧道专用受限账号」
#
#   bash prep-tunnel-user.sh --public-key "<公钥>"
#
# 作用：
#   建一个只用来跑 SSH 反向隧道的账号，**不给 root**，
#   且 authorized_keys 里限制：
#     - restrict            → 禁止一切交互能力（pty/转发/agent…）
#     - port-forwarding     → 但**保留**端口转发（隧道需要）
#     - permitlisten        → 且**只允许**在指定地址:端口上监听
#   → 即使隧道私钥泄露，攻击者也不能拿它开 shell、也不能乱开端口。
#
# 前置：root 权限（当前脚本在公网服务器上以 root 执行）。
#
# 退出码：0 成功；1 失败。
# =============================================================================

set -euo pipefail

TUNNEL_USER="${TUNNEL_USER:-nmg-tunnel}"
PERMIT_LISTEN="${PERMIT_LISTEN:-127.0.0.1:18081}"
PUBKEY=""
COMMENT="nmg-edge-tunnel"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { printf '[%s] ERROR: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --public-key)    PUBKEY="${2:-}"; shift 2 ;;
    --user)          TUNNEL_USER="${2:-}"; shift 2 ;;
    --permit-listen) PERMIT_LISTEN="${2:-}"; shift 2 ;;
    -h|--help)       sed -n '2,20p' "$0"; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

[ -n "$PUBKEY" ] || die "缺少 --public-key"
case "$PUBKEY" in
  ssh-ed25519*|ecdsa-sha2*|ssh-rsa*) : ;;
  *) die "公钥格式不对：${PUBKEY}" ;;
esac

if ! id "$TUNNEL_USER" >/dev/null 2>&1; then
  log "创建账号 ${TUNNEL_USER}"
  useradd --create-home --shell /bin/bash "$TUNNEL_USER"
else
  log "账号 ${TUNNEL_USER} 已存在"
fi

HOME_DIR="$(getent passwd "$TUNNEL_USER" | cut -d: -f6)"
SSH_DIR="${HOME_DIR}/.ssh"
mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"

# 限制这条 key：只允许端口转发，且只在指定地址:端口监听
LINE="restrict,port-forwarding,permitlisten=\"${PERMIT_LISTEN}\" ${PUBKEY} ${COMMENT}"
AUTH="${SSH_DIR}/authorized_keys"

# 幂等：先删掉同一 comment 的旧行
if [ -f "$AUTH" ]; then
  grep -v "${COMMENT}\$" "$AUTH" > "${AUTH}.tmp" 2>/dev/null || true
  mv "${AUTH}.tmp" "$AUTH"
fi
printf '%s\n' "$LINE" >> "$AUTH"
chmod 600 "$AUTH"
chown -R "${TUNNEL_USER}:${TUNNEL_USER}" "$SSH_DIR"

log "已写入 ${AUTH}："
sed 's/^/    /' "$AUTH"

# sshd 必须允许端口转发（默认就是 yes，但要确认没被关掉）
if grep -rqiE "^\s*AllowTcpForwarding\s+no" /etc/ssh/sshd_config /etc/ssh/sshd_config.d/ 2>/dev/null; then
  die "sshd 显式禁止了端口转发（AllowTcpForwarding no），隧道无法建立"
fi
log "sshd 端口转发：允许"

log "=== 准备完成 ✅ ==="
log "  隧道账号：${TUNNEL_USER}"
log "  允许监听：${PERMIT_LISTEN}"
log "  校园机侧启动命令："
log "    bash infra/scripts/tunnel-public-edge.sh --public-host <公网IP> \\"
log "      --public-port <SSH端口> --remote-user ${TUNNEL_USER} \\"
log "      --local-port 18080 --remote-listen-port ${PERMIT_LISTEN##*:} --daemon"
