#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 微信小程序 CI 上传 / 预览（miniprogram-ci）
#
#   bash infra/scripts/miniprogram-ci-upload.sh --check
#   bash infra/scripts/miniprogram-ci-upload.sh --preview --appid wxXXXX --private-key /path/private.wxXXXX.key
#   bash infra/scripts/miniprogram-ci-upload.sh --upload  --appid wxXXXX --private-key /path/private.wxXXXX.key \
#        --version 0.1.0 --desc "测试版本"
#
# 作用：
#   1) **预览**（preview）：生成二维码，扫码就能在手机上打开**开发版**；
#   2) **上传**（upload）：把代码传到微信公众平台，之后在后台点「设为体验版」即可。
#
# 前置条件（缺一不可）：
#   - **AppID**：小程序（在哪个账号下注册由客户决定）的 AppID；
#   - **代码上传密钥**：微信公众平台 →「管理 → 开发管理 → 开发设置 → 小程序代码上传」
#     → 生成并下载的 `private.<appid>.key`（**不会明文留存，遗失只能重置**）；
#   - **IP 白名单**：开启后只有白名单里的 IP 才能调用上传接口
#     → 把**执行本脚本这台机器的公网出口 IP** 加进去（或临时关闭白名单）。
#
# 安全约束：
#   1) **私钥不进仓库**：只接受仓库外的路径；放在仓库里会被 rsync 同步出去；
#   2) **不打印私钥内容**；
#   3) miniprogram-ci 装在**临时目录**（默认 /tmp/nmg-miniprogram-ci），
#      不写进 workspace 依赖（与「playwright 不得进 workspace 依赖」同理）；
#   4) 只上传 apps/miniprogram 下的产物，不碰服务端代码。
#
# 退出码：0 成功；1 失败。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

APPID=""
PRIVATE_KEY=""
VERSION="0.1.0"
DESC="内蒙古北京大学校友会 · 测试版本"
MODE="check"
WRITE_APPID=0
API_BASE_URL_OVERRIDE=""
PROJECT_DIR="${PROJECT_ROOT}/apps/miniprogram"
CI_DIR="${MINIPROGRAM_CI_DIR:-/tmp/nmg-miniprogram-ci}"
QR_OUT="${MINIPROGRAM_QR_OUT:-/tmp/nmg-miniprogram-preview.jpg}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"

while [ $# -gt 0 ]; do
  case "$1" in
    --appid) APPID="${2:-}"; [ -n "$APPID" ] || die "--appid 需要一个值"; shift 2 ;;
    --private-key) PRIVATE_KEY="${2:-}"; [ -n "$PRIVATE_KEY" ] || die "--private-key 需要一个值"; shift 2 ;;
    --version) VERSION="${2:-}"; [ -n "$VERSION" ] || die "--version 需要一个值"; shift 2 ;;
    --desc) DESC="${2:-}"; shift 2 ;;
    --project) PROJECT_DIR="${2:-}"; [ -n "$PROJECT_DIR" ] || die "--project 需要一个值"; shift 2 ;;
    --qr-out) QR_OUT="${2:-}"; [ -n "$QR_OUT" ] || die "--qr-out 需要一个值"; shift 2 ;;
    --api-base-url) API_BASE_URL_OVERRIDE="${2:-}"; [ -n "$API_BASE_URL_OVERRIDE" ] || die "--api-base-url 需要一个值"; shift 2 ;;
    --preview) MODE="preview"; shift ;;
    --upload) MODE="upload"; shift ;;
    --write-appid) WRITE_APPID=1; shift ;;
    --check) MODE="check"; shift ;;
    -h|--help) sed -n '2,38p' "$0"; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

# --- 构建期注入：改完一定还原（trap 保证异常路径也还原）----------------------
CONFIG_FILE=""
CONFIG_BACKUP=""

restore_config() {
  if [ -n "$CONFIG_BACKUP" ] && [ -f "$CONFIG_BACKUP" ] && [ -n "$CONFIG_FILE" ]; then
    cp -p "$CONFIG_BACKUP" "$CONFIG_FILE"
    log "已还原 ${CONFIG_FILE}"
  fi
}
trap restore_config EXIT

inject_api_base_url() {
  local url="$1"
  CONFIG_FILE="${PROJECT_DIR}/src/config/index.ts"
  [ -f "$CONFIG_FILE" ] || die "找不到配置文件：${CONFIG_FILE}"
  CONFIG_BACKUP="$(mktemp /tmp/nmg-config-index.XXXXXX.ts)"
  cp -p "$CONFIG_FILE" "$CONFIG_BACKUP"

  # 整行替换（原来用单引号还是双引号都无所谓）
  awk -v url="$url" '
    /^export const API_BASE_URL[[:space:]]*=/ {
      print "export const API_BASE_URL = \x27" url "\x27;"
      found = 1
      next
    }
    { print }
    END { if (!found) exit 3 }
  ' "$CONFIG_BACKUP" > "${CONFIG_FILE}.new" || {
    # awk 因「找不到声明」返回 3 → 原文件未被改动，这里只清理临时文件
    [ -f "${CONFIG_FILE}.new" ] && mv "${CONFIG_FILE}.new" "$CONFIG_FILE"
    die "配置里找不到 API_BASE_URL 声明 —— 注入失败（源文件未改动）"
  }
  mv "${CONFIG_FILE}.new" "$CONFIG_FILE"

  grep -q "API_BASE_URL = '${url}'" "$CONFIG_FILE" \
    || die "API 基址注入后校验失败"
  log "已注入 API 基址：${url}"
}

log "=== 小程序 CI（${MODE}）==="

# --- 1. 工程检查 -------------------------------------------------------------
[ -d "$PROJECT_DIR" ] || die "小程序工程目录不存在：${PROJECT_DIR}"
[ -f "${PROJECT_DIR}/project.config.json" ] || die "缺少 project.config.json：${PROJECT_DIR}"
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
log "工程目录：${PROJECT_DIR}"

CURRENT_APPID="$(sed -n 's/.*"appid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  "${PROJECT_DIR}/project.config.json" | head -1)"
log "project.config.json 里的 appid：${CURRENT_APPID:-（未设置）}"

if [ "$MODE" = "check" ]; then
  MISSING=0
  if [ -z "$APPID" ] || [ "$APPID" = "touristappid" ]; then
    warn "  ✗ 缺少真实 AppID —— 当前是「${CURRENT_APPID:-未设置}」（游客/占位）"
    warn "      小程序注册在哪个账号下由客户决定；拿到 AppID 后用 --appid 传入"
    MISSING=1
  fi
  if [ -z "$PRIVATE_KEY" ] || [ ! -f "$PRIVATE_KEY" ]; then
    warn "  ✗ 缺少代码上传密钥（private.<appid>.key）"
    warn "      微信公众平台 →「管理 → 开发管理 → 开发设置 → 小程序代码上传」→ 生成并下载"
    MISSING=1
  fi
  # --- 2. 后端可达性提示 ----------------------------------------------------
  API_BASE="$(sed -n "s/^export const API_BASE_URL = '\([^']*\)'.*/\1/p" \
    "${PROJECT_DIR}/src/config/index.ts" | head -1)"
  log "  小程序当前 API 基址：${API_BASE:-（未找到）}"
  warn "  ⚠️ 真机/体验版必须能访问 API："
  warn "     · 127.0.0.1 / 局域网地址在手机上**不可达**；"
  warn "     · 微信会校验「request 合法域名」，必须是 **HTTPS + 已配置域名**；"
  warn "     · 体验版可在后台「开发设置 → 服务器域名」临时关闭域名校验，或配置正式域名。"
  if [ "$MISSING" -ne 0 ]; then
    die "小程序 CI 预检未通过（缺 AppID 或上传密钥）"
  fi
  log "=== 预检通过 ✅（可以执行 --preview / --upload）==="
  exit 0
fi

# --- 3. 上传 / 预览的真实前置条件 -------------------------------------------
[ -n "$APPID" ] || die "缺少 --appid"
[ "$APPID" != "touristappid" ] || die "appid 仍是占位值 touristappid，无法上传"
[ -n "$PRIVATE_KEY" ] || die "缺少 --private-key"
[ -f "$PRIVATE_KEY" ] || die "上传密钥文件不存在：${PRIVATE_KEY}"

# 私钥必须放在仓库外 —— 放在仓库里会被 rsync 同步出去
case "$(cd "$(dirname "$PRIVATE_KEY")" && pwd)" in
  "${PROJECT_ROOT}"*) die "上传密钥不能放在仓库内（会被同步出去）：${PRIVATE_KEY}" ;;
esac

if [ "$WRITE_APPID" -eq 1 ] && [ "$CURRENT_APPID" != "$APPID" ]; then
  log "把 appid 写入 project.config.json：${CURRENT_APPID} → ${APPID}"
  sed -i "s/\"appid\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"appid\": \"${APPID}\"/" \
    "${PROJECT_DIR}/project.config.json"
fi

# --- 3.1 构建期注入 API 基址（真机必须能访问后端）----------------------------
if [ -n "$API_BASE_URL_OVERRIDE" ]; then
  case "$API_BASE_URL_OVERRIDE" in
    http://*|https://*) : ;;
    *) die "--api-base-url 必须以 http:// 或 https:// 开头：${API_BASE_URL_OVERRIDE}" ;;
  esac
  case "$API_BASE_URL_OVERRIDE" in
    */api/v1|*/api/v1/) : ;;
    *) warn "⚠️ API 基址通常要带 /api/v1 前缀，当前是：${API_BASE_URL_OVERRIDE}" ;;
  esac
  inject_api_base_url "$API_BASE_URL_OVERRIDE"
else
  log "未指定 --api-base-url，沿用工程里的当前基址（真机若连不上请显式指定）"
fi

# --- 4. 安装 miniprogram-ci（临时目录，不进 workspace）----------------------
require_cmd node
require_cmd npm
if [ ! -d "${CI_DIR}/node_modules/miniprogram-ci" ]; then
  log "安装 miniprogram-ci 到临时目录（${CI_DIR}）……"
  mkdir -p "$CI_DIR"
  ( cd "$CI_DIR" && npm init -y >/dev/null 2>&1 || true )
  ( cd "$CI_DIR" && npm install --registry "$NPM_REGISTRY" --no-audit --no-fund miniprogram-ci >/dev/null )
fi
CI_MODULE="${CI_DIR}/node_modules/miniprogram-ci"
[ -d "$CI_MODULE" ] || die "miniprogram-ci 安装失败：${CI_MODULE}"
log "miniprogram-ci：${CI_MODULE}"

# --- 5. 执行 -----------------------------------------------------------------
cat > "${CI_DIR}/run.js" <<'JS'
const ci = require('miniprogram-ci');
const project = new ci.Project({
  appid: process.env.MP_APPID,
  type: 'miniProgram',
  projectPath: process.env.MP_PROJECT,
  privateKeyPath: process.env.MP_KEY,
  ignores: ['node_modules/**/*'],
});
const setting = { es6: true, enhance: true, minified: true, codeProtect: false };
(async () => {
  if (process.env.MP_MODE === 'preview') {
    const res = await ci.preview({
      project,
      desc: process.env.MP_DESC,
      setting,
      qrcodeFormat: 'image',
      qrcodeOutputDest: process.env.MP_QR,
      onProgressUpdate: (info) => process.stdout.write(`[preview] ${info}\n`),
    });
    console.log('预览成功：');
    console.log(JSON.stringify(res, null, 2));
    console.log('二维码文件：' + process.env.MP_QR);
  } else {
    const res = await ci.upload({
      project,
      version: process.env.MP_VERSION,
      desc: process.env.MP_DESC,
      setting,
      onProgressUpdate: (info) => process.stdout.write(`[upload] ${info}\n`),
    });
    console.log('上传成功：');
    console.log(JSON.stringify(res, null, 2));
  }
})().catch((err) => {
  console.error('失败：' + (err && err.message ? err.message : err));
  process.exit(1);
});
JS

export MP_APPID="$APPID"
export MP_PROJECT="$PROJECT_DIR"
export MP_KEY="$PRIVATE_KEY"
export MP_MODE="$MODE"
export MP_VERSION="$VERSION"
export MP_DESC="$DESC"
export MP_QR="$QR_OUT"

if [ "$MODE" = "preview" ]; then
  log "生成预览二维码（${QR_OUT}）……"
else
  log "上传版本 ${VERSION}（${DESC}）……"
fi

node "${CI_DIR}/run.js"

if [ "$MODE" = "preview" ]; then
  log "=== 预览完成 ✅ ==="
  log "  二维码：${QR_OUT}（用微信「扫一扫」即可打开开发版）"
  log "  ⚠️ 手机必须能访问 API（见上），否则页面能开但接口会失败"
else
  log "=== 上传完成 ✅ ==="
  log "  微信公众平台 →「管理 → 版本管理」→ 找到该版本 → 点「设为体验版」"
fi
