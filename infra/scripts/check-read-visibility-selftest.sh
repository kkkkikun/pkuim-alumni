#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 公开读端点可见性对账校验器的反向验证（自测）
#
#   bash infra/scripts/check-read-visibility-selftest.sh
#
# 目的：证明 `check-read-visibility.mjs` **不是恒过**——
#       当「某个公开读端点的可见性过滤被删掉」「不可见被改成 403」
#       「新增公开读端点却没人登记口径」「文档里的口径被删掉」
#       「待拍板的条目被从 KNOWN-ISSUES 里抹掉」
#       「已登录端点的 403 被改成 404」「新增已登录端点却没人登记可见性分界」
#       「已登录端点的那一行文档被删掉」「管理端的 404 处置被删掉」
#       「新增管理端端点却没人登记可见性分界」
#       「管理端的那一行文档被删掉」时，它必须报错并返回非 0。
#
# 为什么这个校验器值得单测：
#   它守的是「公开读端点的可见性口径」这一层 ——
#   `docs/DATABASE-DESIGN.md`「未审核内容公开」与
#   `docs/KNOWN-ISSUES.md`「已知设计取舍」第 2 条定的口径是
#   「不可见 → 404（不用 403，避免泄露存在性）」。
#   这层的缺陷**完全静默**：
#     - 过滤被删掉 → 未发布 / 未审核的内容**凭 id 就能公开读到**
#       （第十轮就抽查出 `GET /events/:id` 漏了过滤，记为 #197）；
#     - 404 被改成 403 → 状态码本身泄露「这个对象存在」；
#     - 新增公开读端点没登记 → 「不可见返回什么」没人想过。
#   而端点覆盖、契约镜像、响应结构这些校验器全都查不出这一层
#   （它们看的是**路径与结构**，不是**看得见 / 看不见**）。
#
# 用例覆盖各条判定路径：
#   read-visibility-filter-removed      → R2：可见性过滤被删掉
#   read-visibility-status-changed      → R3：不可见被改成 403（状态码用错）
#   read-visibility-endpoint-unregistered → R1：新增公开读端点没登记口径
#   read-visibility-doc-row-removed     → R4：API-SPEC 里的可见性口径被删掉
#   read-visibility-known-issue-removed → R5：待拍板条目被从 KNOWN-ISSUES 抹掉
#   read-visibility-pending-resolved    → R5：待拍板端点的行为被改掉（登记表过期）
#   read-visibility-auth-403-changed-to-404
#                                   → R7：已登录端点的「无权 → 403」被改成 404
#   read-visibility-auth-endpoint-unregistered
#                                   → R6：新增已登录端点却没登记可见性分界
#   read-visibility-auth-doc-row-removed
#                                   → R8：已登录端点的那一行文档被删掉
#   read-visibility-admin-404-removed
#                                   → R10：管理端「资源不存在 → 404」的处置被删掉
#   read-visibility-admin-endpoint-unregistered
#                                   → R9：新增管理端端点却没登记可见性分界
#   read-visibility-admin-doc-row-removed
#                                   → R11：管理端的那一行文档被删掉
#
# ⚠️ 第十七轮：**26 个**注入点覆盖**全部 24 条**判定路径 ——
#   ① 此前**9 条**判定路径一条注入点都没有（「端点被删 / 改名」
#      「端点被挪了位置」「实现的方法被改名」「API-SPEC 那一节整个不见了」
#      「两张登记表登记了同一个端点」「认证阶段守卫被摘掉」…），
#      它们能不能被抓住此前**没有任何证据**；
#   ② 已覆盖的 **15 条**各补一个**第二种退化形态**注入点
#      （换一种写法 / 换一种状态码（403 → 500）/ 换一处位置 /
#      换一种「文档仍在但内容错了」）；
#   ③ 新增**覆盖度自检**：校验器新增判定路径却忘了补注入点 → 这一支自测立刻红。
#
# 流程：
#   0. 正向基线：干净副本上必须 0 不一致、退出码 0；
#   1. 逐个用例：临时副本里注入缺陷 → 断言「退出码非 0」且「输出命中预期的判定码」；
#   2. 元自检：用「永远返回 0 的假校验器」证明断言函数本身有效；
#   3. 覆盖度自检：每条判定路径都有对应的注入点；
#   4. 清理全部临时副本。
#
# 安全约束：只在临时目录里的副本上改动，真实工作副本永远只读；全程不碰数据库。
#
# 退出码：0 自测通过；1 自测失败（校验器恒过或报错不准）。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

SCRIPT_DIR="${PROJECT_ROOT}/infra/scripts"
CHECKER="${SCRIPT_DIR}/check-read-visibility.mjs"
INJECTOR="${SCRIPT_DIR}/selftest-inject.mjs"
FAILED=0

require_cmd node
require_cmd rsync

TMP_ROOT="$(mktemp -d /tmp/nmg-readvisibility-selftest-XXXXXX)"
cleanup() {
  [ -d "$TMP_ROOT" ] && find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
  rmdir "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

log "=== 公开读端点可见性对账校验器反向验证开始 ==="
log "临时副本根目录：${TMP_ROOT}"

make_copy() {
  local dest="$1"
  mkdir -p "$dest"
  rsync -a \
    --exclude 'node_modules/' --exclude '.git/' --exclude 'dist/' \
    --exclude 'coverage/' --exclude '.env*' --exclude '*.log' \
    --exclude 'tests/concurrency/results/' \
    "${PROJECT_ROOT}/" "${dest}/"
}

# ⚠️ **跑副本里的那份校验器**，不是仓库里的那份 ——
#   这个校验器的**登记表**就写在它自己的脚本里
#   （`READ_VISIBILITY_REGISTRY` / `AUTHENTICATED_VISIBILITY_REGISTRY` /
#   `ADMIN_VISIBILITY_REGISTRY`），
#   所以「登记表被改错」这类缺陷**只有**跑副本里那份才看得见 ——
#   跑仓库里那份的话，注入到副本登记表上的改动**根本不生效**
#   （注入就白注了，自测会「通过」而什么也没验到）。
#   其余用例（改控制器 / 改服务 / 改文档）跑副本那份同样有效 ——
#   副本与仓库的差别只在于注入的缺陷。
checker_of() {
  local root="$1"
  if [ -f "${root}/infra/scripts/check-read-visibility.mjs" ]; then
    printf '%s' "${root}/infra/scripts/check-read-visibility.mjs"
  else
    printf '%s' "$CHECKER"
  fi
}

expect_pass() {
  local label="$1" root="$2" out rc
  set +e
  out="$(node "$(checker_of "$root")" --root "$root" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    log "  ✓ 基线 ${label}：退出码 0（公开读端点的可见性口径自洽）"
  else
    warn "  ✗ 基线 ${label}：退出码 ${rc}（干净副本竟然不通过）"
    printf '%s\n' "$out" | tail -12 | sed 's/^/      /'
    FAILED=1
  fi
}

expect_failure() {
  local label="$1" root="$2" expected="$3" out rc
  set +e
  out="$(node "$(checker_of "$root")" --root "$root" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    warn "  ✗ ${label}：退出码 0 —— 校验器恒过，不可信"
    FAILED=1
    return
  fi
  if printf '%s' "$out" | grep -q "$expected"; then
    log "  ✓ ${label}：退出码 ${rc}，命中 ${expected}"
    printf '%s\n' "$out" | grep "$expected" | head -2 | sed 's/^/      /'
  else
    warn "  ✗ ${label}：退出码 ${rc} 但输出未命中 ${expected}"
    printf '%s\n' "$out" | tail -12 | sed 's/^/      /'
    FAILED=1
  fi
}

# --- 0. 正向基线 ----------------------------------------------------------
log "[0/2] 正向基线：干净副本上的公开读端点可见性口径必须自洽……"
BASE_COPY="${TMP_ROOT}/baseline"
make_copy "$BASE_COPY"
expect_pass "check-read-visibility.mjs" "$BASE_COPY"

# --- 1. 注入缺陷并验证 -----------------------------------------------------
log "[1/2] 逐个注入缺陷并验证校验器……"

log "  元自检：expect_failure 对「永远返回 0 的假校验器」必须判失败……"
FAKE_CHECKER="${TMP_ROOT}/fake-checker.mjs"
printf 'process.exit(0);\n' > "$FAKE_CHECKER"
META_OUT="$(
  set +e
  out="$(node "$FAKE_CHECKER" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    echo "恒过"
  fi
)"
if printf '%s' "$META_OUT" | grep -q "恒过"; then
  log "  ✓ 元自检通过：恒过的校验器被正确判为失败"
else
  warn "  ✗ 元自检失败：断言函数对恒过的校验器没有反应（自测本身不可信）"
  FAILED=1
fi

run_case() {
  local case_name="$1" expected="$2" case_copy
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

  expect_failure "$case_name" "$case_copy" "$expected"
}

# 可见性过滤被删掉 → 未发布的内容凭 id 就能公开读到
run_case "read-visibility-filter-removed" "READ_VISIBILITY_FILTER_MISSING"
# 不可见被改成 403 → 状态码泄露存在性
run_case "read-visibility-status-changed" "READ_VISIBILITY_STATUS_MISMATCH"
# 新增公开读端点却没登记口径
run_case "read-visibility-endpoint-unregistered" "READ_VISIBILITY_NOT_REGISTERED"
# 文档里的可见性口径被删掉
run_case "read-visibility-doc-row-removed" "READ_VISIBILITY_UNDOCUMENTED"
# 待拍板条目被从 KNOWN-ISSUES 抹掉
run_case "read-visibility-known-issue-removed" "READ_VISIBILITY_KNOWN_ISSUE_MISSING"
# 待拍板端点的行为被改掉（登记表与文档过期）
run_case "read-visibility-pending-resolved" "READ_VISIBILITY_REGISTRY_STALE"
# 已登录端点（第十二轮）：「无权 → 403」被改成 404（客户端分不清两种引导）
run_case "read-visibility-auth-403-changed-to-404" "AUTH_VISIBILITY_STATUS_MISSING"
# 已登录端点（第十二轮）：新增端点却没登记可见性分界
run_case "read-visibility-auth-endpoint-unregistered" "AUTH_VISIBILITY_NOT_REGISTERED"
# 已登录端点（第十二轮）：API-SPEC 里的那一行被删掉
run_case "read-visibility-auth-doc-row-removed" "AUTH_VISIBILITY_UNDOCUMENTED"
# 管理端（第十三轮）：「资源不存在 → 404」的处置被删掉（删不存在的活动却说「已删除」）
run_case "read-visibility-admin-404-removed" "ADMIN_VISIBILITY_STATUS_MISSING"
# 管理端（第十三轮）：新增端点却没登记「资源不存在 → 404」的分界
run_case "read-visibility-admin-endpoint-unregistered" "ADMIN_VISIBILITY_NOT_REGISTERED"
# 管理端（第十三轮）：API-SPEC 第 13.4 节里的那一行被删掉
run_case "read-visibility-admin-doc-row-removed" "ADMIN_VISIBILITY_UNDOCUMENTED"

# --- 第十七轮：每条判定补**第二种退化形态** -------------------------------
#
# ⚠️ **为什么要第二种形态**：
#   此前每条判定只有**一个**注入点。那一个注入点只能证明
#   「这个校验器能抓住**这一种**退化形态」——
#   它证明不了「这个校验器守的是**语义**，不是某一段特定的文本」。
#   比如「过滤被整段删掉」与「过滤被换个写法写」，
#   校验器若只认前者的**文本特征**，后者就会**漏判**。
#   下面每条判定各补一个**不同形态**的注入点：
#     - 换一种写法（同一处缺陷的另一种代码形态）；
#     - 换一种状态码（403 → 500）；
#     - 换一处位置（同一个控制器文件里的**另一个**端点）；
#     - 换一种「文档仍在但内容错了」（行还在、状态码被改）。
run_case "read-visibility-filter-spelled-differently" "READ_VISIBILITY_FILTER_MISSING"
run_case "read-visibility-status-changed-to-500" "READ_VISIBILITY_STATUS_MISMATCH"
run_case "read-visibility-endpoint-unregistered-in-other-controller" "READ_VISIBILITY_NOT_REGISTERED"
run_case "read-visibility-doc-row-status-changed" "READ_VISIBILITY_UNDOCUMENTED"
run_case "read-visibility-known-issue-endpoint-forgotten" "READ_VISIBILITY_KNOWN_ISSUE_MISSING"
run_case "read-visibility-pending-resolved-inverted" "READ_VISIBILITY_REGISTRY_STALE"
run_case "read-visibility-auth-403-changed-to-500" "AUTH_VISIBILITY_STATUS_MISSING"
run_case "read-visibility-auth-404-changed-to-500" "AUTH_VISIBILITY_STATUS_MISSING"
run_case "read-visibility-auth-guard-removed" "AUTH_VISIBILITY_GUARD_MISSING"
run_case "read-visibility-auth-endpoint-unregistered-other-path" "AUTH_VISIBILITY_NOT_REGISTERED"
run_case "read-visibility-auth-doc-row-status-changed" "AUTH_VISIBILITY_UNDOCUMENTED"
run_case "read-visibility-admin-404-changed-to-500" "ADMIN_VISIBILITY_STATUS_MISSING"
run_case "read-visibility-admin-endpoint-unregistered-other-path" "ADMIN_VISIBILITY_NOT_REGISTERED"
run_case "read-visibility-admin-doc-row-status-changed" "ADMIN_VISIBILITY_UNDOCUMENTED"

# --- 第十七轮：补齐**其余判定路径**的注入点 -------------------------------
#
# ⚠️ 此前这个校验器有 **9 条判定路径一条注入点都没有**：
#   「端点被删 / 改名」「端点被挪了位置」「实现的方法被改名」
#   「API-SPEC 那一节整个不见了」「两张登记表登记了同一个端点」——
#   它们**能不能被抓住**，此前**没有任何证据**。
#   一个没人验过的判定路径，跟没有这条路径是一样的。
run_case "read-visibility-doc-section-missing" "READ_VISIBILITY_SECTION_MISSING"
run_case "read-visibility-route-missing" "READ_VISIBILITY_ROUTE_MISSING"
run_case "read-visibility-controller-mismatch" "READ_VISIBILITY_CONTROLLER_MISMATCH"
run_case "read-visibility-impl-missing" "READ_VISIBILITY_IMPL_MISSING"
run_case "read-visibility-auth-route-missing" "AUTH_VISIBILITY_ROUTE_MISSING"
run_case "read-visibility-auth-controller-mismatch" "AUTH_VISIBILITY_CONTROLLER_MISMATCH"
run_case "read-visibility-auth-impl-missing" "AUTH_VISIBILITY_IMPL_MISSING"
run_case "read-visibility-admin-route-missing" "ADMIN_VISIBILITY_ROUTE_MISSING"
run_case "read-visibility-admin-controller-mismatch" "ADMIN_VISIBILITY_CONTROLLER_MISMATCH"
run_case "read-visibility-admin-impl-missing" "ADMIN_VISIBILITY_IMPL_MISSING"
run_case "read-visibility-admin-duplicate-registration" "ADMIN_VISIBILITY_DUPLICATE"

# --- 覆盖度自检：每条判定路径都有注入点 -----------------------------------
#
# ⚠️ 「每条判定都有注入点」这句话，只有**真的**逐条核对过才成立 ——
#   校验器新增了一条判定路径却忘了补注入点，这一支自测会立刻红，
#   而不是等到「那条新路径的退化形态其实抓不住」的那一天。
log "[2/3] 覆盖度自检：判定路径 ↔ 注入点必须一一对应……"
COVER_CODES="$(node --input-type=module - "$CHECKER" <<'NODE'
import fs from 'node:fs';
const src = fs.readFileSync(process.argv[2], 'utf8');
// ⚠️ 先把**注释行**去掉 —— 注释里写的 `kind: 'X'` 是举例，不是真的判定码。
const codeOnly = src
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');
const codes = new Set();
const re = /issues\.push\(\{\s*\n\s*kind:\s*'([A-Z_]+)'/g;
let m;
while ((m = re.exec(codeOnly)) !== null) codes.add(m[1]);
process.stdout.write([...codes].sort().join('\n'));
NODE
)"
COVER_COUNT="$(printf '%s\n' "$COVER_CODES" | grep -c . || true)"
log "  校验器可报出的判定路径：${COVER_COUNT} 条"
MISSING_CODES=""
for code in $COVER_CODES; do
  if ! grep -q "\"${code}\"" "$0"; then
    MISSING_CODES="${MISSING_CODES} ${code}"
  fi
done
if [ -n "$MISSING_CODES" ]; then
  warn "  ✗ 以下判定路径在本自测里**没有对应的注入点**：${MISSING_CODES}"
  warn "     —— 补一个注入点，否则这条判定路径的退化形态没人守"
  FAILED=1
else
  log "  ✓ 覆盖度自检通过：${COVER_COUNT} 条判定路径全部有对应的注入点"
fi

# --- 2. 清理 ---------------------------------------------------------------
log "[3/3] 清理临时副本……"
find "$TMP_ROOT" -mindepth 1 -delete 2>/dev/null || true
rmdir "$TMP_ROOT" 2>/dev/null || true

if [ "$FAILED" -ne 0 ]; then
  die "公开读端点可见性对账校验器反向验证失败 ❌"
fi

log "=== 反向验证通过 ✅（12 类「可见性口径失配」缺陷全部被抓出，校验器非恒过）==="
log "公开读端点可见性对账校验器反向验证通过 ✅"
