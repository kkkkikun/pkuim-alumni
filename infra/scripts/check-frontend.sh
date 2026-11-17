#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 前端静态校验（小程序 + 管理后台）
#
#   bash infra/scripts/check-frontend.sh
#   SWAGGER_URL=http://127.0.0.1:18081/docs-json bash infra/scripts/check-frontend.sh
#
# 为什么需要：
#   小程序尚未在微信开发者工具中运行（需真实 AppID），管理后台也不适合在 CI 里跑浏览器。
#   这两个前端都有同一类「编译期查不出、运行时才白屏/无反应」的缺陷，
#   静态交叉校验可以在没有 GUI、没有微信环境的情况下把它们挡住：
#
#   小程序（check-miniprogram.mjs）：
#     - 页面未在 app.json 注册 / 缺 .ts / .wxml
#     - 跳转地址（utils/navigate.ts 的 URL 构造函数 + 页面内路由表）指向未注册页面
#     - switchTab 跳到非 tabBar 页面
#     - WXML 绑定的方法在对应 TS 中不存在（点击无反应）
#     - WXML 引用的 data 字段在 data/setData 中不存在（永远空白）
#     - usingComponents 指向不存在的组件
#     - 从 services 引入了不存在的导出
#
#   需求覆盖矩阵（check-spec-coverage.mjs，需运行中的 API）：
#     - docs/top.md §3.1 要求的每个页面都必须真实存在（app.json 注册 + .ts + .wxml）
#     - app.json 里不能有矩阵未覆盖的孤儿页面
#     - 管理后台每个视图都要存在且被路由引用
#     - top.md §4.3 要求的每个 API 分组在服务端至少注册了一条路由
#
#   接口文档一致性（check-api-spec-doc.mjs，需运行中的 API）：
#     - docs/API-SPEC.md 写的每个 (方法, 路径) 都必须在服务端真实注册
#     - 服务端注册的业务端点都必须写进 API-SPEC
#
#   契约 ↔ 服务端路由（check-contract-routes.mjs，需运行中的 API）：
#     - 契约 ApiPaths 的每个路径都必须在服务端真实注册
#     - 服务端注册的业务端点都必须在契约 ApiPaths 里声明
#
#   管理后台（check-admin-web.mjs）：
#     - 路由引用了不存在的视图组件
#     - 视图文件没有被任何路由引用（死页面）
#     - 路由声明的权限点不在契约 AdminPermission 中（页面会被权限守卫永远拦下）
#     - 菜单指向的路径不在路由表中
#     - router.push 的路径没有对应路由
#
#   声明参数消费（check-swagger-param-usage.mjs，纯静态）：
#     - 查询 DTO 里声明的参数，handler 是不是真的用上了
#       （整体透传给 service 时会继续追进 service 方法体）
#
# 退出码：0 全部通过；1 存在错误。
# =============================================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=./common.sh
source "${PROJECT_ROOT}/infra/scripts/common.sh"

require_cmd node

FAILED=0

for checker in check-miniprogram.mjs check-admin-web.mjs; do
  log "运行 ${checker} ……"
  set +e
  node "${PROJECT_ROOT}/infra/scripts/${checker}" --root "${PROJECT_ROOT}"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    warn "${checker} 未通过（退出码 ${rc}）"
    FAILED=1
  else
    log "${checker} 通过 ✅"
  fi
done

# 声明参数消费对账（服务端侧，但同样是**纯静态**、不需要运行中的 API）：
#   DTO 里声明了查询参数、Swagger 会如实公布，但 handler 根本没用它 ——
#   请求照发、状态码 200、结果不受筛选影响，筛选框是摆设。
#   放在这里是为了让「快速机器化校验」这条路径也能挡住这一类缺陷。
#   （带 Swagger 的完整版本在回归链第 14 步，会额外做「文档 ⟷ DTO」对账。）
log "运行 check-swagger-param-usage.mjs ……"
set +e
node "${PROJECT_ROOT}/infra/scripts/check-swagger-param-usage.mjs" --root "${PROJECT_ROOT}"
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  warn "check-swagger-param-usage.mjs 未通过（退出码 ${rc}）"
  FAILED=1
else
  log "check-swagger-param-usage.mjs 通过 ✅"
fi

# 需求覆盖矩阵 + 接口文档一致性：都需要运行中的 API（Swagger）作为路由事实来源
SWAGGER_URL="${SWAGGER_URL:-http://127.0.0.1:18081/docs-json}"
if command -v curl >/dev/null 2>&1 && curl -sS --max-time 8 -o /dev/null "${SWAGGER_URL}"; then
  for checker in check-spec-coverage.mjs check-api-spec-doc.mjs check-contract-routes.mjs; do
    log "运行 ${checker} ……"
    set +e
    node "${PROJECT_ROOT}/infra/scripts/${checker}" --root "${PROJECT_ROOT}" --swagger "${SWAGGER_URL}"
    rc=$?
    set -e
    if [ "$rc" -ne 0 ]; then
      warn "${checker} 未通过（退出码 ${rc}）"
      FAILED=1
    else
      log "${checker} 通过 ✅"
    fi
  done
else
  warn "Swagger 不可达（${SWAGGER_URL}），跳过需求覆盖矩阵与接口文档一致性校验"
fi

if [ "$FAILED" -ne 0 ]; then
  die "前端静态校验失败"
fi

log "前端静态校验全部通过 ✅"
