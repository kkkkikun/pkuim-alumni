#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 业务冒烟测试
#
# 对运行中的 API 执行一次真实业务链路：
#   健康检查 → Mock 登录 → 读取本人资料 → 字典 → 管理员登录 → 管理端总览
#
# 用法：
#   bash infra/scripts/smoke.sh [--base http://127.0.0.1:18081/api/v1]
#
# 退出码：0 全部通过；1 存在失败项。
# 不修改任何数据（仅登录与只读查询）。
# =============================================================================
set -euo pipefail

BASE="http://127.0.0.1:18081/api/v1"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-Admin@2026}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

PASS=0
FAIL=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    printf '  ✓ %s\n' "$name"
    PASS=$((PASS + 1))
  else
    printf '  ✗ %s（期望包含 %s，实际 %s）\n' "$name" "$expected" "${actual:0:200}"
    FAIL=$((FAIL + 1))
  fi
}

json_field() {
  # $1=json $2=字段名（python3 提取，失败返回空）
  python3 -c "
import json,sys
try:
    data=json.loads(sys.stdin.read())
except Exception:
    print(''); raise SystemExit
cur=data
for part in sys.argv[1].split('.'):
    if isinstance(cur,list):
        cur=cur[int(part)]
    else:
        cur=cur.get(part) if isinstance(cur,dict) else None
    if cur is None: break
print(cur if not isinstance(cur,(dict,list)) else json.dumps(cur,ensure_ascii=False))
" "$2" <<<"$1" 2>/dev/null || true
}

echo "== NMG-PKU-Alumni 业务冒烟测试（$BASE） =="

# 1. 健康检查
HEALTH=$(curl -sS --max-time 10 "${HEALTH_URL:-http://127.0.0.1:18081/healthz}" || true)
check "健康检查返回 ok" '"status":"ok"' "$HEALTH"

# 2. Mock 登录
LOGIN=$(curl -sS --max-time 10 -X POST "$BASE/auth/mock/login" \
  -H 'Content-Type: application/json' \
  -d '{"mockOpenid":"smoke-tester","nickname":"冒烟校友"}' || true)
check "Mock 登录返回令牌" '"accessToken"' "$LOGIN"
TOKEN=$(json_field "$LOGIN" 'data.accessToken')

# 3. 读取本人资料
ME=$(curl -sS --max-time 10 "$BASE/me" -H "Authorization: Bearer $TOKEN" || true)
check "读取本人资料成功" '"code":"OK"' "$ME"
check "本人资料包含 openid" 'smoke-tester' "$ME"

# 4. 未认证访问被拒绝
UNAUTH=$(curl -sS --max-time 10 "$BASE/me" || true)
check "未登录访问返回 401" 'AUTH_REQUIRED' "$UNAUTH"

# 5. 地区与行业字典
REGIONS=$(curl -sS --max-time 10 "$BASE/system/regions" || true)
check "地区字典非空" 'name' "$REGIONS"
INDUSTRIES=$(curl -sS --max-time 10 "$BASE/system/industries" || true)
check "行业字典非空" 'name' "$INDUSTRIES"

# 6. 首页聚合
HOME=$(curl -sS --max-time 10 "$BASE/home/feed" || true)
check "首页聚合返回快捷入口" 'directory' "$HOME"

# 7. 管理员登录
ADMIN_LOGIN=$(curl -sS --max-time 10 -X POST "$BASE/auth/admin/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASSWORD\"}" || true)
if [[ "$ADMIN_LOGIN" == *'"accessToken"'* ]]; then
  printf '  ✓ 管理员登录成功\n'; PASS=$((PASS + 1))
  ADMIN_TOKEN=$(json_field "$ADMIN_LOGIN" 'data.accessToken')
  STATS=$(curl -sS --max-time 10 "$BASE/admin/stats" -H "Authorization: Bearer $ADMIN_TOKEN" || true)
  check "管理端总览可读" '"code":"OK"' "$STATS"
else
  printf '  · 管理员登录未通过（可能尚未执行 Seed），跳过管理端检查\n'
fi

echo "== 结果：通过 $PASS 项，失败 $FAIL 项 =="
[[ $FAIL -eq 0 ]]
