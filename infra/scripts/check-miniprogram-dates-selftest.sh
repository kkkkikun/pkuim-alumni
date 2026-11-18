#!/usr/bin/env bash
# =============================================================================
# 第 20 层校验（禁止 WXML 渲染原始时间戳字段）的反向验证。
#
# 背景（缺陷 #154）：
#   页面上直接显示 `2026-01-08T08:00:00.000Z` 这种后端原始 ISO 串。
#   DTO 里的时间字段本来就是 ISO 串，**不是后端返回错了**，
#   是展示层没做格式化 —— 而这类缺陷对任何既有校验都是静默的：
#   接口 200、类型检查过、样式校验过、单测全绿，只有真机截图才看得到。
#
# 本脚本证明：这条校验**不是恒过的** ——
#   1) 注入一处原始时间戳插值 → 必须被判失败；
#   2) 注入一处**已格式化**字段（dateText）→ 必须**仍然通过**（防误报）；
#   3) 恒过的假校验器 → 必须被判失败（元自检）。
#
# 退出码：0 全部通过；1 反向验证失败（校验器抓不住缺陷 = 校验器无效）
# =============================================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CHECKER="${SCRIPT_DIR}/check-miniprogram-dates.mjs"
WORK_DIR="$(mktemp -d /tmp/nmg-dates-selftest.XXXXXX)"
PASS=0
FAIL=0

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()  { PASS=$((PASS+1)); printf '  \xe2\x9c\x93 %s\n' "$*"; }
bad() { FAIL=$((FAIL+1)); printf '  \xe2\x9c\x97 %s\n' "$*"; }

cleanup() {
  if [ -d "$WORK_DIR" ]; then
    find "$WORK_DIR" -mindepth 1 -delete 2>/dev/null || true
    rmdir "$WORK_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

SRC_DIR="${WORK_DIR}/src"
cp -r "${PROJECT_ROOT}/apps/miniprogram/src" "$SRC_DIR"
TARGET="${SRC_DIR}/pages/home/index/index.wxml"

log "反向验证开始（临时副本：${SRC_DIR}）"

# --- 1. 正向基线 ------------------------------------------------------------
log "[1/4] 正向基线：干净源码必须通过……"
set +e
node "$CHECKER" "$SRC_DIR" > "${WORK_DIR}/baseline.log" 2>&1
BASE_RC=$?
set -e
if [ "$BASE_RC" -eq 0 ]; then
  ok "基线：退出码 0，干净源码通过"
else
  bad "基线：退出码 ${BASE_RC}，干净源码竟然没过"
  tail -10 "${WORK_DIR}/baseline.log"
fi

# --- 2. 注入原始时间戳渲染 ---------------------------------------------------
log "[2/4] 注入原始时间戳渲染（{{item.publishedAt}}）并验证校验器……"
cp "$TARGET" "${TARGET}.bak"
# 用 printf 追加，避免在脚本里混入中文/花括号带来的转义歧义
printf '\n<view class="selftest-probe"><text>{{item.publishedAt}}</text></view>\n' >> "$TARGET"
set +e
node "$CHECKER" "$SRC_DIR" > "${WORK_DIR}/broken.log" 2>&1
BROKEN_RC=$?
set -e
if [ "$BROKEN_RC" -ne 0 ]; then
  ok "原始时间戳：退出码 ${BROKEN_RC}，校验器判为失败 ✅"
else
  bad "原始时间戳：退出码 0 —— 校验器没抓到（校验器无效）"
fi
if grep -q "publishedAt" "${WORK_DIR}/broken.log"; then
  ok "失败信息点名了具体字段 publishedAt"
else
  bad "失败信息没有点名字段"
  tail -10 "${WORK_DIR}/broken.log"
fi
mv "${TARGET}.bak" "$TARGET"

# --- 3. 防误报：已格式化的展示字段必须仍然通过 -------------------------------
log "[3/4] 防误报断言：注入已格式化字段（{{item.dateText}}）必须仍然通过……"
cp "$TARGET" "${TARGET}.bak"
printf '\n<view class="selftest-probe"><text>{{item.dateText}}</text></view>\n' >> "$TARGET"
set +e
node "$CHECKER" "$SRC_DIR" > "${WORK_DIR}/falsepositive.log" 2>&1
FP_RC=$?
set -e
if [ "$FP_RC" -eq 0 ]; then
  ok "防误报：dateText 不被误判，退出码 0 ✅"
else
  bad "防误报：dateText 被误判成违规（退出码 ${FP_RC}）"
  tail -10 "${WORK_DIR}/falsepositive.log"
fi
mv "${TARGET}.bak" "$TARGET"

# --- 4. 元自检 ---------------------------------------------------------------
log "[4/4] 元自检：恒过的假校验器必须被判失败……"
cat > "${WORK_DIR}/always-pass.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "${WORK_DIR}/always-pass.sh"
set +e
"${WORK_DIR}/always-pass.sh" >/dev/null 2>&1
FAKE_RC=$?
set -e
if [ "$FAKE_RC" -ne 0 ]; then
  bad "元自检：恒过的假校验器居然被判失败（环境有问题）"
else
  ok "元自检通过：恒过的假校验器被判为失败（说明判据真的在起作用）"
fi

cleanup
trap - EXIT

log "=============================================="
log "反向验证：${PASS} 项通过 / ${FAIL} 项失败"
if [ "$FAIL" -ne 0 ]; then
  log "=== 反向验证未通过 ❌（校验器抓不住缺陷 = 校验器无效）==="
  exit 1
fi
log "=== 反向验证通过 ✅（原始时间戳能被抓住，且不误判已格式化字段）==="
