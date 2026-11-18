#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 微信小程序 CI 上传 / 预览（miniprogram-ci）
#
#   bash infra/scripts/miniprogram-ci-upload.sh --check
#   bash infra/scripts/miniprogram-ci-upload.sh --preview --appid wxXXXX --private-key /path/private.wxXXXX.key
#   bash infra/scripts/miniprogram-ci-upload.sh --upload  --appid wxXXXX --private-key /path/private.wxXXXX.key \
#        --version 0.1.0 --desc "测试版本"
#
# 可选的**构建期注入**（改完自动还原，不污染源码）：
#   --api-base-url http://<公网IP>/api/v1   注入 API 基址（真机必须能访问后端）
#   --mock-login false                      关闭 Mock 登录 → 走真实 wx.login
#   --data-mode live|demo|auto              注入数据模式（live=只走真实接口）
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
MOCK_LOGIN_OVERRIDE=""
DATA_MODE_OVERRIDE=""
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
    --mock-login)   MOCK_LOGIN_OVERRIDE="${2:-}"; [ -n "$MOCK_LOGIN_OVERRIDE" ] || die "--mock-login 需要一个值"; shift 2 ;;
    --data-mode)    DATA_MODE_OVERRIDE="${2:-}"; [ -n "$DATA_MODE_OVERRIDE" ] || die "--data-mode 需要一个值"; shift 2 ;;
    --preview) MODE="preview"; shift ;;
    --upload) MODE="upload"; shift ;;
    --write-appid) WRITE_APPID=1; shift ;;
    --check) MODE="check"; shift ;;
    --inject-only) MODE="inject-only"; shift ;;
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
  inject_const "API_BASE_URL" "'${url}'"
}

# 通用注入：把 `export const <NAME>[: <Type>] = <旧值>;` 的**值**换掉，
# 但**保留类型注解**（`DATA_MODE: DataMode` 少了注解就变成 string，
# 赋给 DataMode 类型的参数会直接编译报错）。
#
# 参数：$1=常量名，$2=完整 TS 字面量（含引号，如 "'live'" 或 "false"）。
inject_const() {
  local name="$1"
  local value="$2"
  CONFIG_FILE="${PROJECT_DIR}/src/config/index.ts"
  [ -f "$CONFIG_FILE" ] || die "找不到配置文件：${CONFIG_FILE}"
  if [ -z "$CONFIG_BACKUP" ]; then
    CONFIG_BACKUP="$(mktemp /tmp/nmg-config-index.XXXXXX.ts)"
    cp -p "$CONFIG_FILE" "$CONFIG_BACKUP"
  fi

  # ⚠️ 输入必须是**当前文件**，不能是原始备份。
  #    第一次写成「读备份」→ 三次注入时，后一次注入会从**原始**文件出发，
  #    把前一次注入的结果**冲掉** → 最终产物里基址与 mock 标志都是原值。
  #    （这个 bug 被「上传前产物对账」当场拦下过一次，见 KNOWN-ISSUES #150）
  #    备份只用于**还原**，不参与注入。
  #
  # 只替换声明行里「第一个 = 之后」的部分；前缀（含类型注解）原样保留。
  awk -v name="$name" -v value="$value" '
    $0 ~ ("^export const " name "([[:space:]]*:[[:space:]]*[A-Za-z_][A-Za-z0-9_]*)?" "[[:space:]]*=") {
      idx = index($0, "=")
      prefix = substr($0, 1, idx - 1)
      sub(/[[:space:]]+$/, "", prefix)
      print prefix " = " value ";"
      found = 1
      next
    }
    { print }
    END { if (!found) exit 3 }
  ' "$CONFIG_FILE" > "${CONFIG_FILE}.new" || {
    # awk 因「找不到声明」返回 3 → 原文件未被改动，这里只清理临时文件
    if [ -f "${CONFIG_FILE}.new" ]; then unlink "${CONFIG_FILE}.new" 2>/dev/null || true; fi
    die "配置里找不到 ${name} 声明 —— 注入失败（源文件未改动）"
  }
  mv "${CONFIG_FILE}.new" "$CONFIG_FILE"

  # 反向校验：注入后必须真的能读到这个值（防止 awk 静默写了个别的行）
  local injected
  injected="$(grep -E "^export const ${name}([[:space:]]*:[[:space:]]*[A-Za-z_][A-Za-z0-9_]*)?[[:space:]]*=" \
    "$CONFIG_FILE" | head -1)"
  case "$injected" in
    *"= ${value};"*) : ;;
    *) die "注入 ${name} 后校验失败：${injected:-（未找到声明）}" ;;
  esac
  log "已注入 ${name} = ${value}"
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
# ⚠️ `--inject-only` 只需要**工程**，不需要凭据 ——
#    它的用途是「快速自测注入逻辑」（不联网、不上传）。
if [ "$MODE" != "inject-only" ]; then
  [ -n "$APPID" ] || die "缺少 --appid"
  [ "$APPID" != "touristappid" ] || die "appid 仍是占位值 touristappid，无法上传"
  [ -n "$PRIVATE_KEY" ] || die "缺少 --private-key"
  [ -f "$PRIVATE_KEY" ] || die "上传密钥文件不存在：${PRIVATE_KEY}"

  # 私钥必须放在仓库外 —— 放在仓库里会被 rsync 同步出去
  case "$(cd "$(dirname "$PRIVATE_KEY")" && pwd)" in
    "${PROJECT_ROOT}"*) die "上传密钥不能放在仓库内（会被同步出去）：${PRIVATE_KEY}" ;;
  esac
fi

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

# --- 3.2 构建期注入登录方式与数据模式 ----------------------------------------
# 为什么必须能注入 `USE_MOCK_LOGIN`：
#   源码默认是 `true`（Mock 登录），那是**开发态**的默认值 ——
#   交付给客户的包必须走真实 `wx.login`。
#   以前只能靠「改源码再上传」，极易漏改（改漏了 → 客户看到的是演示账号）。
#   现在改成构建期注入：值写死在命令行里，脚本 trap 保证事后还原源码。
if [ -n "$MOCK_LOGIN_OVERRIDE" ]; then
  case "$MOCK_LOGIN_OVERRIDE" in
    true|false) : ;;
    *) die "--mock-login 只能是 true 或 false：${MOCK_LOGIN_OVERRIDE}" ;;
  esac
  inject_const "USE_MOCK_LOGIN" "$MOCK_LOGIN_OVERRIDE"
else
  log "未指定 --mock-login，沿用工程里的当前设置"
fi

if [ -n "$DATA_MODE_OVERRIDE" ]; then
  case "$DATA_MODE_OVERRIDE" in
    live|demo|auto) : ;;
    *) die "--data-mode 只能是 live / demo / auto：${DATA_MODE_OVERRIDE}" ;;
  esac
  inject_const "DATA_MODE" "'${DATA_MODE_OVERRIDE}'"
else
  log "未指定 --data-mode，沿用工程里的当前设置"
fi

# --- 3.3 聚合校验：三个值必须**同时**生效 ------------------------------------
# ⚠️ 为什么单项校验不够（真实踩到过）：
#   每次 `inject_const` 只校验「自己那一个值在不在」，
#   但**注入是累积的** —— 如果第二次注入从原始备份出发，
#   第一次注入的结果会被冲掉，而两次单项校验**都会通过**。
#   所以必须再验一次「三个值同时在文件里」。
if [ -n "$API_BASE_URL_OVERRIDE" ] && [ -n "$MOCK_LOGIN_OVERRIDE" ] && [ -n "$DATA_MODE_OVERRIDE" ]; then
  MISSING_VALUES=""
  grep -q "API_BASE_URL = '${API_BASE_URL_OVERRIDE}';" "$CONFIG_FILE" || MISSING_VALUES="${MISSING_VALUES} API_BASE_URL"
  grep -q "USE_MOCK_LOGIN = ${MOCK_LOGIN_OVERRIDE};" "$CONFIG_FILE" || MISSING_VALUES="${MISSING_VALUES} USE_MOCK_LOGIN"
  grep -q "DATA_MODE: DataMode = '${DATA_MODE_OVERRIDE}';" "$CONFIG_FILE" || MISSING_VALUES="${MISSING_VALUES} DATA_MODE"
  if [ -n "$MISSING_VALUES" ]; then
    die "构建期注入未全部生效，缺少：${MISSING_VALUES} —— 不会上传"
  fi
  log "构建期注入聚合校验通过（基址 / 登录方式 / 数据模式三者同时生效）"
fi

# --- 3.4 只注入、不上传（用于快速自测注入逻辑，不联网、不需要凭据）------------
if [ "$MODE" = "inject-only" ]; then
  log "=== 只注入不上传（--inject-only）：校验注入逻辑用 ==="
  log "当前注入后的配置（退出时会被 trap 还原）："
  grep -E "^export const (API_BASE_URL|USE_MOCK_LOGIN|DATA_MODE)" "$CONFIG_FILE" | sed 's/^/    /'
  exit 0
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

# --- 4.5 上传前「产物对账」（证明待上传的包配置是对的）------------------------
# ⚠️ 为什么必须做这一步：
#   `ci.upload` 成功只说明「代码传到微信服务器了」，
#   **不代表包里的配置是对的**。以下三种事故它一个都拦不住：
#     1) 基址没注入 → 客户端连的是 127.0.0.1 → 真机一个接口都调不通；
#     2) USE_MOCK_LOGIN 还是 true → 客户用「演示账号」而不是自己的微信身份；
#     3) DATA_MODE 落在 demo → 全是假数据。
#   所以这里在**注入之后、上传之前**离编译一次，
#   直接在**产物**里找这些值 —— 找不到就不上传。
#
# --- 4.6 上传前「源码层」校验：禁止指向目录的 import（缺陷 #153）--------------
#   微信运行时**不做「目录 → index.js」的回退**，
#   `from '../../../services'` 在真机上就是
#   `module 'services.js' is not defined` → 页面 JS 加载失败 → **白屏**。
#   产物层的检查**查不出它**（文件在包里、Node 规则也能解析），
#   必须在**源码层**查。
if [ -f "${SCRIPT_DIR}/check-miniprogram-imports.mjs" ]; then
  log "=== 上传前源码校验：禁止指向目录的 import ==="
  node "${SCRIPT_DIR}/check-miniprogram-imports.mjs" "${PROJECT_DIR}/src" \
    || die "源码里有指向目录的 import —— 微信运行时会直接白屏，已中止上传"
else
  warn "找不到 check-miniprogram-imports.mjs，跳过源码层校验（不推荐）"
fi

if [ -f "${SCRIPT_DIR}/miniprogram-compile-check.mjs" ]; then
  AUDIT_ARGS=("${PROJECT_DIR}")
  [ -n "$API_BASE_URL_OVERRIDE" ] && AUDIT_ARGS+=(--expect-api-base "$API_BASE_URL_OVERRIDE")
  [ -n "$MOCK_LOGIN_OVERRIDE" ] && AUDIT_ARGS+=(--expect-mock-login "$MOCK_LOGIN_OVERRIDE")
  [ -n "$DATA_MODE_OVERRIDE" ] && AUDIT_ARGS+=(--expect-data-mode "$DATA_MODE_OVERRIDE")
  log "=== 上传前产物对账（离线编译 + 在产物里验运行配置）==="
  MINIPROGRAM_CI_DIR="$CI_DIR" node "${SCRIPT_DIR}/miniprogram-compile-check.mjs" "${AUDIT_ARGS[@]}" \
    || die "产物对账未通过 —— 已中止，不会上传一个配置不对的包"
else
  warn "找不到 miniprogram-compile-check.mjs，跳过产物对账（不推荐）"
fi

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
