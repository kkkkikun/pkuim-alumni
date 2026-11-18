#!/usr/bin/env bash
# =============================================================================
# 第 18 层校验（禁止指向目录的 import）的反向验证。
#
# 背景（缺陷 #153，真机白屏的真根因）：
#   微信运行时**不做「目录 → index.js」的回退**，
#   `import from '../../../services'` 在真机上就是
#   `module 'services.js' is not defined` → 页面 JS 加载失败 → 白屏。
#
# 本脚本证明：这条校验**不是恒过的** —— 注入一处目录导入必须被判失败。
#
# 退出码：0 全部通过；1 反向验证失败（校验器抓不住缺陷 = 校验器无效）
# =============================================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CHECKER="${SCRIPT_DIR}/check-miniprogram-imports.mjs"
WORK_DIR="$(mktemp -d /tmp/nmg-imports-selftest.XXXXXX)"
PASS=0
FAIL=0

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()  { PASS=$((PASS+1)); printf '  ✓ %s\n' "$*"; }
bad() { FAIL=$((FAIL+1)); printf '  ✗ %s\n' "$*"; }

cleanup() {
  if [ -d "$WORK_DIR" ]; then
    find "$WORK_DIR" -mindepth 1 -delete 2>/dev/null || true
    rmdir "$WORK_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

SRC_DIR="${WORK_DIR}/src"
cp -r "${PROJECT_ROOT}/apps/miniprogram/src" "$SRC_DIR"

log "反向验证开始（临时副本：${SRC_DIR}）"

# --- 1. 正向基线：干净源码必须通过 -------------------------------------------
log "[1/3] 正向基线：干净源码必须通过……"
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

# --- 2. 注入「指向目录的 import」并验证校验器 ---------------------------------
log "[2/3] 注入「指向目录的 import」并验证校验器……"
TARGET_FILE="${SRC_DIR}/pages/home/index/index.ts"
if [ ! -f "$TARGET_FILE" ]; then
  TARGET_FILE="${SRC_DIR}/bootstrap.ts"
fi
cp "$TARGET_FILE" "${TARGET_FILE}.bak"
printf '\n// 反向验证注入：故意写一个指向目录的 import\nimport { listArticles } from "%s";\n' \
  "$(node -e 'const path=require("path");const f=process.argv[1];console.log(path.relative(path.dirname(f),process.argv[2])||".")' "$TARGET_FILE" "$SRC_DIR/services")" \
  >> "$TARGET_FILE"
set +e
node "$CHECKER" "$SRC_DIR" > "${WORK_DIR}/broken.log" 2>&1
BROKEN_RC=$?
set -e
if [ "$BROKEN_RC" -ne 0 ]; then
  ok "目录导入：退出码 ${BROKEN_RC}，校验器判为失败 ✅"
else
  bad "目录导入：退出码 0 —— 校验器没抓到（校验器无效）"
fi
if grep -q "指向目录的 import" "${WORK_DIR}/broken.log"; then
  ok "失败信息点名了问题类型"
else
  bad "失败信息没有点名问题类型"
  tail -10 "${WORK_DIR}/broken.log"
fi
if grep -q "services/index" "${WORK_DIR}/broken.log"; then
  ok "失败信息给出了正确写法（xxx/index）"
else
  bad "失败信息没有给出正确写法"
fi
mv "${TARGET_FILE}.bak" "$TARGET_FILE"

# --- 3. 元自检：恒过的假校验器必须被判为失败 ----------------------------------
log "[3/3] 元自检：恒过的假校验器必须被判失败……"
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
  ok "元自检通过：恒过的假校验器被判为失败（说明上面的判据真的在起作用）"
fi

cleanup
trap - EXIT

log "=============================================="
log "反向验证：${PASS} 项通过 / ${FAIL} 项失败"
if [ "$FAIL" -ne 0 ]; then
  log "=== 反向验证未通过 ❌（校验器抓不住缺陷 = 校验器无效）==="
  exit 1
fi
log "=== 反向验证通过 ✅（目录导入能被抓住，校验器非恒过）==="
