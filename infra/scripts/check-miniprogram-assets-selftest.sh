#!/usr/bin/env bash
# =============================================================================
# 第 21 层校验（本地图片引用有效性 + 禁止单字占位图标）的反向验证。
#
# 背景（缺陷 #154，用户反馈「细节没有 HTML 那么精致」的真根因之一）：
#   小程序端不支持 SVG data URI，原型的描边图标与塔楼线描插画必须先栅格化
#   成 PNG。项目此前**一张图片资源都没有**，所有图标要么是 CSS 伪元素手绘的
#   三角形 / 圆圈，要么直接拿一个汉字当图标（首页「人/连/历/燕」、
#   我的页「名/历/连/知/发/隐/燕/设」、通知类型「认/连/审/活/通」）。
#   同样，这类缺陷对所有既有校验都是**静默的**：不报错、不影响接口。
#
# 本脚本证明：这条校验**不是恒过的** ——
#   1) 注入一处失效的图片引用 → 必须被判失败；
#   2) 注入一处「单字占位图标」→ 必须被判失败；
#   3) 注入一处**有效**的图片引用 → 必须**仍然通过**（防误报）；
#   4) 恒过的假校验器 → 必须被判失败（元自检）。
#
# 退出码：0 全部通过；1 反向验证失败（校验器抓不住缺陷 = 校验器无效）
# =============================================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CHECKER="${SCRIPT_DIR}/check-miniprogram-assets.mjs"
WORK_DIR="$(mktemp -d /tmp/nmg-assets-selftest.XXXXXX)"
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
log "[1/5] 正向基线：干净源码必须通过……"
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

# --- 2. 注入失效的图片引用 ---------------------------------------------------
log "[2/5] 注入失效的图片引用并验证校验器……"
cp "$TARGET" "${TARGET}.bak"
printf '\n<image class="selftest-probe" src="/assets/icons/__does-not-exist__.png"></image>\n' >> "$TARGET"
set +e
node "$CHECKER" "$SRC_DIR" > "${WORK_DIR}/broken-ref.log" 2>&1
BROKEN_RC=$?
set -e
if [ "$BROKEN_RC" -ne 0 ]; then
  ok "失效引用：退出码 ${BROKEN_RC}，校验器判为失败 ✅"
else
  bad "失效引用：退出码 0 —— 校验器没抓到（校验器无效）"
fi
if grep -q "__does-not-exist__" "${WORK_DIR}/broken-ref.log"; then
  ok "失败信息点名了失效路径"
else
  bad "失败信息没有点名失效路径"
  tail -10 "${WORK_DIR}/broken-ref.log"
fi
mv "${TARGET}.bak" "$TARGET"

# --- 3. 注入单字占位图标 -----------------------------------------------------
log "[3/5] 注入单字占位图标并验证校验器……"
cp "$TARGET" "${TARGET}.bak"
# \xe4\xba\xba = 「人」，用八进制转义避免脚本里的中文编码歧义
printf '\n<text class="selftest-glyph">\xe4\xba\xba</text>\n' >> "$TARGET"
set +e
node "$CHECKER" "$SRC_DIR" > "${WORK_DIR}/broken-glyph.log" 2>&1
GLYPH_RC=$?
set -e
if [ "$GLYPH_RC" -ne 0 ]; then
  ok "占位图标：退出码 ${GLYPH_RC}，校验器判为失败 ✅"
else
  bad "占位图标：退出码 0 —— 校验器没抓到（校验器无效）"
fi
if grep -q "selftest-glyph" "${WORK_DIR}/broken-glyph.log"; then
  ok "失败信息点名了占位图标所在位置"
else
  bad "失败信息没有点名占位图标"
  tail -10 "${WORK_DIR}/broken-glyph.log"
fi
mv "${TARGET}.bak" "$TARGET"

# --- 4. 防误报：有效的图片引用必须仍然通过 -----------------------------------
log "[4/5] 防误报断言：注入有效图片引用必须仍然通过……"
cp "$TARGET" "${TARGET}.bak"
printf '\n<image class="selftest-probe" src="/assets/icons/home.png"></image>\n' >> "$TARGET"
set +e
node "$CHECKER" "$SRC_DIR" > "${WORK_DIR}/falsepositive.log" 2>&1
FP_RC=$?
set -e
if [ "$FP_RC" -eq 0 ]; then
  ok "防误报：有效引用不被误判，退出码 0 ✅"
else
  bad "防误报：有效引用被误判成失效（退出码 ${FP_RC}）"
  tail -10 "${WORK_DIR}/falsepositive.log"
fi
mv "${TARGET}.bak" "$TARGET"

# --- 5. 元自检 ---------------------------------------------------------------
log "[5/5] 元自检：恒过的假校验器必须被判失败……"
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
log "=== 反向验证通过 ✅（失效引用与占位图标都能抓住，且不误判有效引用）==="
