#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— API-SPEC 文档 ↔ 服务端实现 一致性校验器的反向验证（自测）
#
#   bash infra/scripts/check-api-spec-doc-selftest.sh [--swagger <url-or-file>]
#
# 目的：证明 `check-api-spec-doc.mjs` **不是恒过**——
#       当「API-SPEC 文档里写了服务端根本没实现的端点」时，
#       它必须报错并返回非 0。
#
# 为什么这个校验器值得单测：
#   它守的是「对外说明书 docs/API-SPEC.md 与服务端真实路由一致」这一层。
#   文档漂移的后果**完全静默**：接口照着文档调，运行时就 404；
#   上一轮就手工发现过一处（文档写着 GET /resources/:id/reviews，服务端根本没有）。
#   而端点覆盖、响应结构、错误码对账看的是「有没有 / 字段对不对」，
#   全都查不出「文档多写了一个根本不存在的端点」。
#
# 用例覆盖的判定路径：
#   doc-endpoint-missing → R1：文档声明的端点服务端没注册 → DOC_ENDPOINT_MISSING
#   （另一方向「服务端注册了但文档没写」在该校验器里是 **warning** 级，
#     不影响退出码，属于「盲点提示」而非失败判定，因此不在本自测的失败断言范围内。）
#
# 流程：
#   0. 取 Swagger 基线（--swagger 参数 > SWAGGER_URL 环境变量 > 默认地址），
#      取不到就直接 die —— 读不到服务端路由的校验器会「什么都没报」，
#      那正是恒过假象，必须让自测当场失败，而不是默默放过；
#      （默认地址上若跑的是**旧构建**的 API，基线会因为「代码里新增了路由、
#        旧 API 还没有」而不一致 —— 这是真实的基线漂移，
#        自测会当场把错误行打出来并以非 0 退出，不会默默放行。）
#   1. 正向基线：干净副本 + 基线 Swagger 必须退出码 0；
#   2. 逐个用例：临时副本里注入缺陷 → 断言「退出码非 0」且「输出命中预期的判定码」；
#   3. 元自检：用「永远返回 0 的假校验器」证明断言函数本身有效；
#   4. 清理全部临时副本。
#
# 安全约束：
#   - 只在临时目录（mktemp -d）里的副本上改动，真实工作副本永远只读；
#   - Swagger 文档只被**复制**进副本（<copyRoot>/swagger.json），源文件不改动；
#   - 全程不碰数据库、不碰正在运行的 API 进程。
#
# 退出码：0 自测通过；1 自测失败（校验器恒过、报错不准或取不到 Swagger 文档）。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

SCRIPT_DIR="${PROJECT_ROOT}/infra/scripts"
CHECKER="${SCRIPT_DIR}/check-api-spec-doc.mjs"
INJECTOR="${SCRIPT_DIR}/selftest-inject.mjs"
FAILED=0

require_cmd node
require_cmd rsync

# --- Swagger 文档来源（参数 > 环境变量 > 默认地址）----------------------------
SWAGGER_SOURCE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --swagger)
      [ "$#" -ge 2 ] || die "--swagger 缺少参数值（应为 url 或本地文件路径）"
      SWAGGER_SOURCE="$2"
      shift 2
      ;;
    --swagger=*)
      SWAGGER_SOURCE="${1#*=}"
      shift
      ;;
    -h|--help)
      log "用法: bash $(basename "$0") [--swagger <url-or-file>]"
      exit 0
      ;;
    *)
      die "未知参数：$1"
      ;;
  esac
done
if [ -z "$SWAGGER_SOURCE" ]; then
  SWAGGER_SOURCE="${SWAGGER_URL:-http://127.0.0.1:18081/docs-json}"
fi

TMP_ROOT="$(mktemp -d /tmp/nmg-api-spec-doc-selftest-XXXXXX)"
cleanup() {
  [ -d "$TMP_ROOT" ] && find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
  rmdir "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

log "=== API-SPEC 文档 ↔ 服务端实现 一致性校验器反向验证开始 ==="
log "临时副本根目录：${TMP_ROOT}"

# --- 取 Swagger 基线：取不到就当场失败，绝不静默放行 --------------------------
SWAGGER_FILE="${TMP_ROOT}/swagger-baseline.json"
if [[ "$SWAGGER_SOURCE" =~ ^https?:// ]]; then
  if ! node -e '
    const fs = require("node:fs");
    const url = process.argv[1];
    const out = process.argv[2];
    (async () => {
      const res = await fetch(url);
      if (!res.ok) { console.error(`HTTP ${res.status} ${res.statusText}`); process.exit(1); }
      const text = await res.text();
      JSON.parse(text);
      fs.writeFileSync(out, text);
    })().catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });
  ' "$SWAGGER_SOURCE" "$SWAGGER_FILE"; then
    die "无法获取 Swagger 文档：${SWAGGER_SOURCE}（请用 --swagger 指定可访问的地址或本地文件）"
  fi
else
  if [ ! -f "$SWAGGER_SOURCE" ]; then
    die "Swagger 文件不存在：${SWAGGER_SOURCE}"
  fi
  cp -p "$SWAGGER_SOURCE" "$SWAGGER_FILE"
fi
# 文档里必须真的有 paths，否则等于「服务端没有路由」，校验器会变成空转
if ! ROUTE_COUNT="$(node -e '
  const fs = require("node:fs");
  const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const count = Object.keys(doc.paths ?? {}).length;
  if (count === 0) { console.error("paths 为空"); process.exit(1); }
  console.log(count);
' "$SWAGGER_FILE")"; then
  die "Swagger 文档不可用或不含任何 paths：${SWAGGER_SOURCE}"
fi
log "Swagger 基线：${SWAGGER_SOURCE}（服务端路由 ${ROUTE_COUNT} 条）"

make_copy() {
  local dest="$1"
  mkdir -p "$dest"
  rsync -a \
    --exclude 'node_modules/' --exclude '.git/' --exclude 'dist/' \
    --exclude 'coverage/' --exclude '.env*' --exclude '*.log' \
    --exclude 'tests/concurrency/results/' \
    "${PROJECT_ROOT}/" "${dest}/"
  # 每个副本都必须带上同一份 Swagger 基线（校验器读的是副本里的这份文档）
  cp -p "$SWAGGER_FILE" "${dest}/swagger.json"
}

run_checker() {
  local root="$1"; shift
  node "$CHECKER" --root "$root" --swagger "${root}/swagger.json" "$@"
}

expect_pass() {
  local label="$1" root="$2" out rc
  set +e
  out="$(run_checker "$root" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    log "  ✓ 基线 ${label}：退出码 0（文档与实现一致）"
  else
    warn "  ✗ 基线 ${label}：退出码 ${rc}（干净副本竟然不通过）"
    printf '%s\n' "$out" | tail -12 | sed 's/^/      /'
    FAILED=1
  fi
}

# 断言函数：校验器必须失败**且**命中预期判定码。
# 第 5 个参数是「注入缺陷的特征串」：基线本身就带着同款错误时，
# 只看判定码会被基线错误顶替，所以还必须点名注入的那条路径。
# 返回 0 = 断言成立；返回 1 = 断言不成立（校验器恒过 / 报错不准）。
assert_checker_fails() {
  local label="$1" root="$2" expected="$3" checker="$4" evidence="$5" out rc
  set +e
  out="$(node "$checker" --root "$root" --swagger "${root}/swagger.json" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    warn "  ✗ ${label}：退出码 0 —— 校验器恒过，不可信"
    return 1
  fi
  if printf '%s' "$out" | grep -q "$expected"; then
    if [ -n "$evidence" ] && ! printf '%s' "$out" | grep -q -- "$evidence"; then
      warn "  ✗ ${label}：命中 ${expected} 但输出未点名注入缺陷 ${evidence}（疑似被基线里的同款错误顶替）"
      printf '%s\n' "$out" | tail -12 | sed 's/^/      /'
      return 1
    fi
    log "  ✓ ${label}：退出码 ${rc}，命中 ${expected}"
    printf '%s\n' "$out" | grep -E "$expected|$evidence" | head -3 | sed 's/^/      /'
    return 0
  fi
  warn "  ✗ ${label}：退出码 ${rc} 但输出未命中 ${expected}"
  printf '%s\n' "$out" | tail -12 | sed 's/^/      /'
  return 1
}

expect_failure() {
  local label="$1" root="$2" expected="$3" evidence="$4"
  if ! assert_checker_fails "$label" "$root" "$expected" "$CHECKER" "$evidence"; then
    FAILED=1
  fi
}

# --- 0. 正向基线 ------------------------------------------------------------
log "[0/3] 正向基线：干净副本上 API-SPEC 必须与服务端实现一致……"
BASE_COPY="${TMP_ROOT}/baseline"
make_copy "$BASE_COPY"
expect_pass "check-api-spec-doc.mjs" "$BASE_COPY"

# --- 1. 逐个注入缺陷并验证 ---------------------------------------------------
log "[1/3] 逐个注入缺陷并验证校验器……"

# 元自检：断言函数本身必须能识破「恒过的校验器」。
# 若 assert_checker_fails 写坏了（哪怕校验器永远返回 0 也算通过），本自测就失去意义。
log "  元自检：assert_checker_fails 对「永远返回 0 的假校验器」必须判失败……"
FAKE_CHECKER="${TMP_ROOT}/fake-checker.mjs"
printf 'process.exit(0);\n' > "$FAKE_CHECKER"
META_COPY="${TMP_ROOT}/meta"
make_copy "$META_COPY"
META_RC=0
assert_checker_fails "元自检（恒过的假校验器）" "$META_COPY" "__meta_never_matches__" "$FAKE_CHECKER" "" \
  >"${TMP_ROOT}/meta.log" 2>&1 || META_RC=$?
if [ "$META_RC" -ne 0 ]; then
  log "  ✓ 元自检通过：恒过的校验器被正确判为失败（下面这行是**预期**的断言失败日志）"
  sed 's/^/      [预期失败] /' "${TMP_ROOT}/meta.log"
else
  warn "  ✗ 元自检失败：断言函数对恒过的校验器没有反应（自测本身不可信）"
  sed 's/^/      /' "${TMP_ROOT}/meta.log"
  FAILED=1
fi

run_case() {
  local case_name="$1" expected="$2" evidence="$3" case_copy
  case_copy="${TMP_ROOT}/case-${case_name}"
  make_copy "$case_copy"

  if ! node "$INJECTOR" "$case_name" "$case_copy" >/dev/null 2>&1; then
    warn "  ✗ ${case_name}：缺陷注入失败"
    node "$INJECTOR" "$case_name" "$case_copy" 2>&1 | sed 's/^/      /'
    FAILED=1
    find "$case_copy" -mindepth 1 -delete 2>/dev/null || true
    rmdir "$case_copy" 2>/dev/null || true
    return
  fi

  expect_failure "$case_name" "$case_copy" "$expected" "$evidence"
}

# R1：API-SPEC 里多写了一个服务端根本不存在的端点
run_case "doc-endpoint-missing" "DOC_ENDPOINT_MISSING" "/selftest/missing"

# --- 2. 清理 -----------------------------------------------------------------
log "[2/3] 清理临时副本……"
find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
rmdir "$TMP_ROOT" 2>/dev/null || true

if [ "$FAILED" -ne 0 ]; then
  die "API-SPEC 文档 ↔ 服务端实现一致性校验器反向验证失败 ❌"
fi

log "=== 反向验证通过 ✅（1 类「文档 ↔ 实现漂移」缺陷被抓出，校验器非恒过）==="
log "API-SPEC 文档 ↔ 服务端实现一致性校验器反向验证通过 ✅"
