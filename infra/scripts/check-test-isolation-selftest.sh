#!/usr/bin/env bash
# =============================================================================
# 「集成测试隔离性自检」的反向验证。
#
# 背景（缺陷 #158）：
#   `admin_user_roles` 是**保留表**（resetDatabase 不清），
#   而 `admin-test` 被十几个套件共用 → 权限跨套件累积。
#   某个套件若**没有显式授予自己需要的权限**，
#   它能不能拿到那个权限就取决于 **jest 的执行顺序**。
#   现场：上一轮整链 295/295 全绿，下一轮同一个用例就红了。
#
# 本脚本证明：隔离性自检**不是恒过的** ——
#   把 `alumni:manage` 的授权改掉（精确复现 #158 的原貌），
#   单独跑必须判红；改回来必须判绿。
#
# 注入方式：直接在**容器内**改测试文件（jest 跑的就是容器里那份）。
#
# 退出码：0 全部通过；1 反向验证失败
# =============================================================================
set -Eeuo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

CHECKER="${SCRIPT_DIR}/check-test-isolation.sh"
SPEC_NAME="http-status-semantics.e2e-spec.ts"
SPEC_PATH="/app/apps/api/test/integration/${SPEC_NAME}"
PASS=0
FAIL=0

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()  { PASS=$((PASS+1)); printf '  \xe2\x9c\x93 %s\n' "$*"; }
bad() { FAIL=$((FAIL+1)); printf '  \xe2\x9c\x97 %s\n' "$*"; }

log "反向验证开始（注入在容器内进行，jest 跑的就是那份）"

# --- 1. 基线：单独跑必须绿 ---------------------------------------------------
log "[1/5] 基线：单独跑该套件必须绿……"
set +e
bash "$CHECKER" --filter "http-status-semantics" > /tmp/nmg-isolation-baseline.log 2>&1
BASE_RC=$?
set -e
if [ "$BASE_RC" -eq 0 ]; then
  ok "基线：退出码 0，单独跑通过"
else
  bad "基线：退出码 ${BASE_RC}，单独跑竟然没过"
  tail -15 /tmp/nmg-isolation-baseline.log
fi

# --- 2. 注入缺陷（复现 #158 原貌）-------------------------------------------
log "[2/5] 注入缺陷：把 alumni:manage 授权换成 event:manage……"
compose exec -T api sh -lc "cp '${SPEC_PATH}' '${SPEC_PATH}.bak'"
INJECTED="$(compose exec -T api sh -lc "sed -i \"s/permissionCode: 'alumni:manage'/permissionCode: 'event:manage'/\" '${SPEC_PATH}' && grep -c \"permissionCode: 'event:manage'\" '${SPEC_PATH}'" | tr -d '\r')"
if [ "${INJECTED:-0}" -ge 1 ]; then
  ok "缺陷已注入（容器内 ${SPEC_NAME} 的 alumni:manage 授权已被替换）"
else
  bad "缺陷注入失败：容器里没找到 permissionCode: 'alumni:manage'"
fi

# --- 3. 必须被判红 -----------------------------------------------------------
log "[3/5] 验证隔离性自检能把注入的缺陷判红……"
set +e
bash "$CHECKER" --filter "http-status-semantics" > /tmp/nmg-isolation-broken.log 2>&1
BROKEN_RC=$?
set -e
if [ "$BROKEN_RC" -ne 0 ]; then
  ok "注入缺陷：退出码 ${BROKEN_RC}，被判红 ✅"
else
  bad "注入缺陷：退出码 0 —— 校验器没抓到（校验器无效）"
fi
if grep -q "单独跑会红" /tmp/nmg-isolation-broken.log; then
  ok "失败信息点名了「单独跑会红」"
else
  bad "失败信息没有点名"
  tail -15 /tmp/nmg-isolation-broken.log
fi

# --- 4. 还原并确认判绿 -------------------------------------------------------
log "[4/5] 还原注入并确认恢复为绿……"
compose exec -T api sh -lc "mv -f '${SPEC_PATH}.bak' '${SPEC_PATH}'"
set +e
bash "$CHECKER" --filter "http-status-semantics" > /tmp/nmg-isolation-restored.log 2>&1
RESTORED_RC=$?
set -e
if [ "$RESTORED_RC" -eq 0 ]; then
  ok "还原后：退出码 0，恢复为绿 ✅"
else
  bad "还原后仍然红（退出码 ${RESTORED_RC}）"
  tail -15 /tmp/nmg-isolation-restored.log
fi

# --- 5. 「包根目录残留副本」守卫 ---------------------------------------------
# 这是 #158 的姊妹问题：调试残留被烘进镜像后，
# jest 会把它和正式套件**同时**匹配 → 整链报「Test suite failed to run」。
log "[5/5] 验证「包根目录残留副本」守卫……"
STRAY_FILE="${PROJECT_ROOT}/apps/api/zz-selftest-stray.e2e-spec.ts"
cleanup_stray() { [ -f "$STRAY_FILE" ] && unlink "$STRAY_FILE" 2>/dev/null; }
trap cleanup_stray EXIT
printf '// 反向验证注入：模拟调试残留副本\n' > "$STRAY_FILE"
set +e
bash "$CHECKER" --filter "http-status-semantics" > /tmp/nmg-isolation-stray.log 2>&1
STRAY_RC=$?
set -e
if [ "$STRAY_RC" -ne 0 ]; then
  ok "根目录残留：退出码 ${STRAY_RC}，被判失败 ✅"
else
  bad "根目录残留：退出码 0 —— 守卫没抓到"
fi
if grep -q "测试文件残留" /tmp/nmg-isolation-stray.log; then
  ok "失败信息点名了「测试文件残留」"
else
  bad "失败信息没有点名"
  tail -15 /tmp/nmg-isolation-stray.log
fi
cleanup_stray
trap - EXIT
set +e
bash "$CHECKER" --filter "http-status-semantics" > /tmp/nmg-isolation-stray-restored.log 2>&1
STRAY_RESTORED_RC=$?
set -e
if [ "$STRAY_RESTORED_RC" -eq 0 ]; then
  ok "清理残留后：退出码 0，恢复为绿 ✅"
else
  bad "清理残留后仍然红（退出码 ${STRAY_RESTORED_RC}）"
  tail -15 /tmp/nmg-isolation-stray-restored.log
fi

log "=============================================="
log "反向验证：${PASS} 项通过 / ${FAIL} 项失败"
if [ "$FAIL" -ne 0 ]; then
  log "=== 反向验证未通过 ❌（隔离性自检抓不住跨套件依赖 = 它无效）==="
  exit 1
fi
log "=== 反向验证通过 ✅（跨套件权限依赖能被单独跑抓出）==="
