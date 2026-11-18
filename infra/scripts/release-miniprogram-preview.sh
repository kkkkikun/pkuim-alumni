#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 一键发布「临时预览版」小程序
#
#   bash infra/scripts/release-miniprogram-preview.sh \
#        --appid wxXXXXXXXXXXXXXXXX \
#        --private-key /home/kikun/keys/private.wxXXXXXXXXXXXXXXXX.key \
#        --api-base-url http://<公网IP> \
#        --version 0.1.0 --desc "临时预览版"
#
# 一次做完：
#   1) 预检（AppID / 密钥 / 工程 / API 基址）；
#   2) 把真实 AppID 写进 project.config.json；
#   3) 构建期注入 API 基址（真机必须能访问后端）；
#   4) 上传 → 微信公众平台「版本管理」里点「设为体验版」；
#   5) 再出一张**预览二维码**（客户用微信扫一扫即可直接打开开发版）。
#
# 前提（缺一不可）：
#   - 真实 AppID；
#   - 代码上传密钥 private.<appid>.key（**必须放在仓库外**，脚本会拒绝仓库内的路径）；
#   - 手机能访问到的 API 基址（公网服务器上的 nginx 入口）。
#
# 退出码：0 成功；1 失败。
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "${SCRIPT_DIR}/common.sh"

APPID=""
PRIVATE_KEY=""
API_BASE_URL=""
MOCK_LOGIN="false"
DATA_MODE="auto"
VERSION="0.1.0"
DESC="内蒙古北京大学校友会 · 临时预览版"
QR_OUT="${MINIPROGRAM_QR_OUT:-/tmp/nmg-miniprogram-preview.jpg}"
SKIP_UPLOAD=0
SKIP_PREVIEW=0

while [ $# -gt 0 ]; do
  case "$1" in
    --appid)        APPID="${2:-}"; [ -n "$APPID" ] || die "--appid 需要一个值"; shift 2 ;;
    --private-key)  PRIVATE_KEY="${2:-}"; [ -n "$PRIVATE_KEY" ] || die "--private-key 需要一个值"; shift 2 ;;
    --api-base-url) API_BASE_URL="${2:-}"; [ -n "$API_BASE_URL" ] || die "--api-base-url 需要一个值"; shift 2 ;;
    --mock-login)   MOCK_LOGIN="${2:-}"; [ -n "$MOCK_LOGIN" ] || die "--mock-login 需要一个值"; shift 2 ;;
    --data-mode)    DATA_MODE="${2:-}"; [ -n "$DATA_MODE" ] || die "--data-mode 需要一个值"; shift 2 ;;
    --version)      VERSION="${2:-}"; [ -n "$VERSION" ] || die "--version 需要一个值"; shift 2 ;;
    --desc)         DESC="${2:-}"; [ -n "$DESC" ] || die "--desc 需要一个值"; shift 2 ;;
    --qr-out)       QR_OUT="${2:-}"; [ -n "$QR_OUT" ] || die "--qr-out 需要一个值"; shift 2 ;;
    --skip-upload)  SKIP_UPLOAD=1; shift ;;
    --skip-preview) SKIP_PREVIEW=1; shift ;;
    -h|--help)      sed -n '2,32p' "$0"; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

[ -n "$APPID" ]        || die "缺少 --appid"
[ -n "$PRIVATE_KEY" ]  || die "缺少 --private-key"
[ -n "$API_BASE_URL" ] || die "缺少 --api-base-url"

UPLOAD_SH="${SCRIPT_DIR}/miniprogram-ci-upload.sh"

log "=== 第 1 步：预检 ==="
bash "$UPLOAD_SH" --check --appid "$APPID" --private-key "$PRIVATE_KEY"

log "=== 第 1.5 步：离线编译自检（证明这份工程能编译出包）==="
# 为什么要有这一步：
#   `ci.preview` / `ci.upload` 会先联网「取项目属性」，
#   没有真实凭据或网络异常时会在编译完成前就失败 →
#   「上传成功」并不能证明「包是好的」。
#   离线编译自检不联网，能真正证明：
#     1) 产物能编译出来；
#     2) 产物里没有残留 TypeScript 语法；
#     3) 每个源模块都在包里（防止被编译器误剪掉 → 运行时 module not found）；
#     4) 离线演示兜底模块已入包。
if [ -f "${SCRIPT_DIR}/miniprogram-compile-check.mjs" ]; then
  node "${SCRIPT_DIR}/miniprogram-compile-check.mjs" "${PROJECT_ROOT}/apps/miniprogram" \
    || die "离线编译自检未通过 —— 已中止，不会上传一个坏包"
else
  warn "找不到 miniprogram-compile-check.mjs，跳过离线编译自检"
fi

log "=== 第 2 步：写 AppID + 注入运行配置并上传 ==="
if [ "$SKIP_UPLOAD" -eq 0 ]; then
  bash "$UPLOAD_SH" --upload \
    --appid "$APPID" --private-key "$PRIVATE_KEY" \
    --write-appid --api-base-url "$API_BASE_URL" \
    --mock-login "$MOCK_LOGIN" --data-mode "$DATA_MODE" \
    --version "$VERSION" --desc "$DESC"
else
  warn "跳过上传（--skip-upload）"
fi

log "=== 第 3 步：生成预览二维码 ==="
if [ "$SKIP_PREVIEW" -eq 0 ]; then
  bash "$UPLOAD_SH" --preview \
    --appid "$APPID" --private-key "$PRIVATE_KEY" \
    --api-base-url "$API_BASE_URL" \
    --mock-login "$MOCK_LOGIN" --data-mode "$DATA_MODE" \
    --desc "$DESC" --qr-out "$QR_OUT"
else
  warn "跳过预览二维码（--skip-preview）"
fi

cat <<EOF

=== 临时预览版发布完成 ✅ ===

  版本号：${VERSION}
  备注：  ${DESC}
  API 基址：${API_BASE_URL}
  登录方式：$( [ "$MOCK_LOGIN" = "false" ] && echo '真实微信登录（wx.login）' || echo 'Mock 登录（演示账号）' )
  数据模式：${DATA_MODE}
  二维码：${QR_OUT}

接下来两件事（都在微信公众平台操作）：

  1) 把上传的版本设为体验版
     微信公众平台 →「管理 → 版本管理」→ 找到 ${VERSION} → 点「设为体验版」
     设完后，客户可以从「小程序助手 → 体验版」直接打开，不用扫码。

  2) 让小程序能访问后端（当前是 ${API_BASE_URL}，微信默认会拦）
     ⚠️ 公众平台**没有**「不校验合法域名」这个开关 ——
        它只存在于「微信开发者工具 → 详情 → 本地设置」；
        手机端要跳过校验，只能**开启调试模式**：
          小程序右上角「…」→「开发调试」→「打开调试」→ 重新进入小程序
          （左上角会出现 vConsole 绿色浮标，说明已生效）
        前提：该微信号要在「成员管理 → 体验成员」名单里。
     ⚠️ 正式发布前必须换成「**已备案域名 + HTTPS**」，
        并在后台「开发设置 → 服务器域名」配置 request 合法域名
        （域名不能用 IP、不能用 localhost，且要支持 443 端口）。

  3) 把二维码发给客户
     客户用微信「扫一扫」即可打开开发版（${QR_OUT}）。
EOF
