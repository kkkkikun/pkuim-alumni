#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 公网接入链路端到端自测 v2（端口可配，避免与既有服务冲突）
#
#   用法： bash nmg-e2e-edge-test.sh [公网侧端口] [边缘nginx端口]
#   默认 38080 / 38081
#
# 链路：边缘 nginx → SSH 反向隧道 → 校园机 compose nginx → API / 管理后台
# 自检点：
#   1. 校园机后端可达
#   2. 隧道密钥与公钥授权
#   3. 隧道口能拿到 API（**且内容是 JSON 而不是 SPA**）
#   4. 边缘 nginx 起来
#   5. 经边缘入口访问 API / 管理后台 / 业务列表
#   6. 端口冲突要能被发现（反向验证）
#   7. 清理
# =============================================================================
set -uo pipefail

cd ~/MyProject/pkuim-alumni || exit 1

TUNNEL_PORT="${1:-38080}"
EDGE_PORT="${2:-38081}"
FAIL=0

say() { printf '\n=== %s ===\n' "$*"; }
ok()  { printf '  ✓ %s\n' "$*"; }
bad() { printf '  ✗ %s\n' "$*"; FAIL=1; }

port_free() {
  ! timeout 1 bash -c "cat < /dev/null > /dev/tcp/127.0.0.1/$1" 2>/dev/null
}

say "0. 前置：端口与后端"
if port_free "$TUNNEL_PORT"; then ok "隧道公网侧端口 ${TUNNEL_PORT} 空闲"; else bad "端口 ${TUNNEL_PORT} 已被占用"; exit 1; fi
if port_free "$EDGE_PORT"; then ok "边缘 nginx 端口 ${EDGE_PORT} 空闲"; else bad "端口 ${EDGE_PORT} 已被占用"; exit 1; fi
if curl -fsS --max-time 8 http://127.0.0.1:18080/api/v1/system/health >/dev/null 2>&1; then
  ok "校园机 compose nginx 127.0.0.1:18080 健康检查通过"
else
  bad "校园机 compose nginx 127.0.0.1:18080 不可达"; exit 1
fi

say "1. 隧道密钥"
cp -p ~/.ssh/authorized_keys /tmp/nmg-authorized_keys.orig 2>/dev/null || true
if [ ! -f ~/.ssh/nmg_edge_key ]; then
  ssh-keygen -t ed25519 -N '' -C "nmg-edge-tunnel" -f ~/.ssh/nmg_edge_key >/dev/null
  ok "已生成隧道密钥 ~/.ssh/nmg_edge_key"
else
  ok "隧道密钥已存在"
fi
grep -q -F "$(cat ~/.ssh/nmg_edge_key.pub)" ~/.ssh/authorized_keys 2>/dev/null \
  || cat ~/.ssh/nmg_edge_key.pub >> ~/.ssh/authorized_keys
ok "公钥已加入本机 authorized_keys（模拟公网机，结束时还原）"

say "2. 启动反向隧道（公网侧 ${TUNNEL_PORT} → 校园侧 18080）"
bash infra/scripts/tunnel-public-edge.sh --public-host 127.0.0.1 --remote-user kikun \
  --local-port 18080 --remote-listen-port "$TUNNEL_PORT" --daemon >/tmp/nmg-tunnel-start.log 2>&1
sleep 3
PID_FILE="$HOME/.cache/nmg-edge-tunnel/tunnel.pid"
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
  ok "隧道守护进程运行中（pid $(cat "$PID_FILE")）"
else
  bad "隧道守护进程未运行"
  tail -5 /tmp/nmg-tunnel-start.log
fi

say "3. 隧道口取 API（必须拿到 JSON，不能是 SPA 页面）"
BODY="$(curl -sS --max-time 8 "http://127.0.0.1:${TUNNEL_PORT}/api/v1/system/health" 2>/dev/null)"
case "$BODY" in
  *'"status":"ok"'*) ok "隧道贯通：拿到 API 的 JSON 响应" ;;
  '') bad "隧道口无响应" ;;
  *) bad "隧道口返回的不是 API JSON：$(echo "$BODY" | head -c 120)" ;;
esac

say "4. 启动边缘 nginx（host 网络，监听 ${EDGE_PORT}，后端指向隧道口）"
sed "s|server 127.0.0.1:18080;|server 127.0.0.1:${TUNNEL_PORT};|; s|listen 80;|listen ${EDGE_PORT};|" \
  /tmp/edge-http.conf > /tmp/edge-test.conf
docker run --rm -d --name nmg-edge-test-nginx --network host \
  -v /tmp/edge-test.conf:/etc/nginx/conf.d/default.conf:ro \
  swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/nginx:alpine \
  nginx -g 'daemon off;' >/dev/null 2>&1
sleep 2
if docker ps --format '{{.Names}}' | grep -q '^nmg-edge-test-nginx$'; then
  ok "边缘 nginx 已启动"
else
  bad "边缘 nginx 启动失败"
fi

say "5. 端到端：模拟客户访问边缘入口"
CODE="$(curl -sS -o /tmp/nmg-edge-api.json -w '%{http_code}' --max-time 10 \
  "http://127.0.0.1:${EDGE_PORT}/api/v1/system/health" 2>/dev/null)"
if [ "$CODE" = "200" ] && grep -q '"status":"ok"' /tmp/nmg-edge-api.json; then
  ok "API 经边缘入口返回 200 且内容正确"
else
  bad "API 经边缘入口异常：code=${CODE} body=$(head -c 120 /tmp/nmg-edge-api.json)"
fi

CODE="$(curl -sS -o /tmp/nmg-edge-web.html -w '%{http_code}' --max-time 10 \
  "http://127.0.0.1:${EDGE_PORT}/" 2>/dev/null)"
if [ "$CODE" = "200" ] && grep -qi "<div id=\"app\"" /tmp/nmg-edge-web.html; then
  ok "管理后台经边缘入口返回 200 且是 SPA 入口页"
else
  bad "管理后台经边缘入口异常：code=${CODE}（$(wc -c < /tmp/nmg-edge-web.html) 字节）"
fi

CODE="$(curl -sS -o /tmp/nmg-edge-list.json -w '%{http_code}' --max-time 10 \
  "http://127.0.0.1:${EDGE_PORT}/api/v1/events?page=1&pageSize=2" 2>/dev/null)"
if [ "$CODE" = "200" ] && grep -q '"items"' /tmp/nmg-edge-list.json; then
  ok "业务列表接口经边缘入口返回 200 且含 items"
else
  bad "业务列表接口经边缘入口异常：code=${CODE}"
fi

say "6. 反向验证：端口真被占用时，必须报错且不能静默打错服务"
CONFLICT_PORT=38086
if port_free "$CONFLICT_PORT"; then
  # 先占住端口，再让隧道去抢 —— 应当明确失败
  python3 -m http.server "$CONFLICT_PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
  SQUATTER_PID=$!
  sleep 1
  LOG_MARK="$(wc -l < "$HOME/.cache/nmg-edge-tunnel/tunnel.log" 2>/dev/null || echo 0)"
  bash infra/scripts/tunnel-public-edge.sh --public-host 127.0.0.1 --remote-user kikun \
    --local-port 18080 --remote-listen-port "$CONFLICT_PORT" --daemon >/tmp/nmg-tunnel-conflict.log 2>&1
  sleep 4
  NEW_LINES="$(tail -n +$((LOG_MARK + 1)) "$HOME/.cache/nmg-edge-tunnel/tunnel.log" 2>/dev/null)"
  if echo "$NEW_LINES" | grep -qi "cannot listen to port\|address already in use\|remote port forwarding failed"; then
    ok "端口被占用 → 隧道日志里明确报错（没有静默连到别的服务）"
  else
    bad "端口被占用但日志里没有明确报错：$(echo "$NEW_LINES" | head -c 200)"
  fi
  # 守护进程必须还活着（自动重连），但那个端口上不能出现我们的隧道
  CONFLICT_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$CONFLICT_PID" ] && kill -0 "$CONFLICT_PID" 2>/dev/null; then
    ok "守护进程存活（ssh 退出后自动重连）"
  else
    bad "守护进程意外退出"
  fi
  kill "$SQUATTER_PID" 2>/dev/null
  sleep 1
else
  warn "${CONFLICT_PORT} 不空闲，跳过冲突用例"
fi

say "7. 清理"
docker stop nmg-edge-test-nginx >/dev/null 2>&1 && ok "边缘 nginx 容器已停止"
if [ -f "$PID_FILE" ]; then
  kill "$(cat "$PID_FILE")" 2>/dev/null && ok "隧道守护进程已停止"
fi
if [ -f /tmp/nmg-authorized_keys.orig ]; then
  cp -p /tmp/nmg-authorized_keys.orig ~/.ssh/authorized_keys && ok "authorized_keys 已还原"
fi

say "结果"
if [ "$FAIL" -eq 0 ]; then echo "全链路通过 ✅"; exit 0; fi
echo "存在失败环节 ❌"; exit 1
