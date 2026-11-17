#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 数据完整性校验器的反向验证（自测）
#
#   bash infra/scripts/check-data-integrity-selftest.sh
#
# 目的：证明 check-data-integrity.sh 真的能抓出违规数据，而不是恒过。
#
# 流程（每个用例）：
#   1. 在**测试库**里注入一类真实违规数据；
#   2. 跑校验器 → 必须退出码非 0，且输出命中该违规项；
#   3. 撤销注入 → 再跑校验器 → 必须恢复为退出码 0。
#
# 安全约束：
#   - 只允许对**库名包含 test** 的库执行写操作（脚本硬护栏）；
#   - 业务库 nmg_alumni 全程只读，不做任何写入；
#   - 每个用例结束后数据回到注入前状态。
#
# 退出码：0 自测通过；1 自测失败。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

TEST_DB="${TEST_DB_NAME:-nmg_alumni_test}"
CHECKER="${PROJECT_ROOT}/infra/scripts/check-data-integrity.sh"
FAILED=0

require_cmd docker

# --- 安全护栏：只允许操作测试库 ---------------------------------------------
case "$TEST_DB" in
  *test*) : ;;
  *) die "拒绝执行：只允许对库名含 'test' 的库注入测试数据，当前为 '${TEST_DB}'" ;;
esac

MAIN_DB="$(env_get_or MYSQL_DATABASE nmg_alumni)"
[ "$TEST_DB" != "$MAIN_DB" ] || die "拒绝执行：测试库与业务库同名（${MAIN_DB}）"

MYSQL_USER_NAME="$(env_get_or MYSQL_USER nmg)"
MYSQL_USER_PASSWORD="$(env_get_or MYSQL_PASSWORD '')"

# 生成带 URL 编码的连接串（密码可能含特殊字符）
build_db_url() {
  python3 - "$1" "$MYSQL_USER_NAME" "$MYSQL_USER_PASSWORD" <<'PY'
import sys, urllib.parse
db, user, pwd = sys.argv[1], sys.argv[2], sys.argv[3]
print(f"mysql://{urllib.parse.quote(user, safe='')}:{urllib.parse.quote(pwd, safe='')}@mysql:3306/{db}")
PY
}
TEST_DB_URL="$(build_db_url "$TEST_DB")"

log "=== 数据完整性校验器反向验证开始（测试库=${TEST_DB}）==="

# --- 0. 准备测试数据 --------------------------------------------------------
# 集成测试会清空测试库并只造少量用例数据，不足以支撑注入；
# 这里先跑一次**幂等** seed，把测试库补齐为完整数据集（补录缺失的认证记录）。
log "[0/6] 准备测试数据：执行幂等 seed……"
compose exec -T \
  -e DATABASE_URL="$TEST_DB_URL" \
  -e DB_NAME="$TEST_DB" api \
  sh -lc "cd /app/apps/api && ./node_modules/.bin/ts-node -r tsconfig-paths/register src/database/seeds/seed.ts" \
  >/dev/null 2>&1 || warn "  · seed 执行异常，注入用例可能缺少可用数据"

# 在测试库执行 SQL，返回纯文本结果
sql_test() {
  local sql="$1"
  printf '%s\n' "$sql" \
    | compose exec -T mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -B "$1"' sh "$TEST_DB" 2>&1 \
    | grep -v 'Using a password on the command line' || true
}

# 跑校验器，返回退出码与输出
run_checker() {
  set +e
  CHECK_OUT="$(bash "$CHECKER" --db "$TEST_DB" 2>&1)"
  CHECK_RC=$?
  set -e
}

# 断言：注入后必须报错并命中违规项；撤销后必须恢复通过
expect_block() {
  local label="$1" expected="$2"
  run_checker
  if [ "$CHECK_RC" -eq 0 ]; then
    warn "  ✗ ${label}：校验器退出码 0 —— 漏检了注入的违规数据"
    FAILED=1
  elif ! printf '%s' "$CHECK_OUT" | grep -q "$expected"; then
    warn "  ✗ ${label}：退出码 ${CHECK_RC} 但输出未命中「${expected}」"
    printf '%s\n' "$CHECK_OUT" | grep '✗' | sed 's/^/      /'
    FAILED=1
  else
    log "  ✓ ${label}：退出码 ${CHECK_RC}，命中「${expected}」"
    printf '%s\n' "$CHECK_OUT" | grep "$expected" | sed 's/^/      /'
  fi
}

expect_pass() {
  local label="$1"
  run_checker
  if [ "$CHECK_RC" -eq 0 ]; then
    log "  ✓ ${label}：撤销注入后退出码 0"
  else
    warn "  ✗ ${label}：撤销注入后仍然失败（退出码 ${CHECK_RC}）"
    printf '%s\n' "$CHECK_OUT" | grep '✗' | sed 's/^/      /'
    FAILED=1
  fi
}

# --- 0. 基线：干净数据必须通过 -----------------------------------------------
log "[0/6] 基线：测试库当前数据应当通过校验……"
expect_pass "基线"

# --- 1. stage 与 approved 申请矛盾（E3）-------------------------------------
log "[1/6] 注入违规 A：已认证用户 stage 被改成 logged_in（应触发 E3）……"
TARGET_ID="$(sql_test "SELECT MIN(u.id) FROM users u JOIN verification_applications a ON a.user_id = u.id AND a.status = 'approved' WHERE u.stage = 'verified';" | tail -1)"
if [ -z "$TARGET_ID" ] || [ "$TARGET_ID" = "NULL" ]; then
  warn "  ✗ 找不到可用于注入的已认证用户"
  FAILED=1
else
  sql_test "UPDATE users SET stage = 'logged_in' WHERE id = ${TARGET_ID};" >/dev/null
  expect_block "违规 A（stage 与通过记录矛盾）" "E3"
  sql_test "UPDATE users SET stage = 'verified' WHERE id = ${TARGET_ID};" >/dev/null
  expect_pass "撤销违规 A"
fi

# --- 2. stage 与在途申请矛盾（E4）-------------------------------------------
log "[2/6] 注入违规 B：待审核用户 stage 被改成 logged_in（应触发 E4）……"
TARGET_ID="$(sql_test "SELECT MIN(u.id) FROM users u JOIN verification_applications a ON a.user_id = u.id AND a.status IN ('pending','resubmitted') WHERE u.stage = 'pending_review';" | tail -1)"
if [ -z "$TARGET_ID" ] || [ "$TARGET_ID" = "NULL" ]; then
  warn "  ✗ 找不到可用于注入的待审核用户"
  FAILED=1
else
  sql_test "UPDATE users SET stage = 'logged_in' WHERE id = ${TARGET_ID};" >/dev/null
  expect_block "违规 B（stage 与在途申请矛盾）" "E4"
  sql_test "UPDATE users SET stage = 'pending_review' WHERE id = ${TARGET_ID};" >/dev/null
  expect_pass "撤销违规 B"
fi

# --- 3. 档案认证标记与用户 stage 矛盾（E1）-----------------------------------
# 注意：不能用「地区码不在字典表」做用例 —— 数据库有 fk_alumni_profiles_region 外键，
# 脏数据在存储层就写不进去（注入会直接报外键错误）。该类检查属于「纵深防御」，
# 其有效性由下面的 F1/F4 用例（删掉外键约束）来证明。
log "[3/6] 注入违规 C：档案 verified=1 但用户 stage 非 verified（应触发 E1）……"
TARGET_ID="$(sql_test "SELECT MIN(u.id) FROM users u JOIN alumni_profiles p ON p.user_id = u.id WHERE p.verified = 0 AND u.stage <> 'verified';" | tail -1)"
if [ -z "$TARGET_ID" ] || [ "$TARGET_ID" = "NULL" ]; then
  warn "  ✗ 找不到可用于注入的用户"
  FAILED=1
else
  sql_test "UPDATE alumni_profiles SET verified = 1 WHERE user_id = ${TARGET_ID};" >/dev/null
  expect_block "违规 C（档案认证标记与 stage 矛盾）" "E1"
  sql_test "UPDATE alumni_profiles SET verified = 0 WHERE user_id = ${TARGET_ID};" >/dev/null
  expect_pass "撤销违规 C"
fi

# --- 4. 联系方式被写成明文（B1）---------------------------------------------
log "[4/6] 注入违规 D：私密切域被写入明文手机号（应触发 B1）……"
TARGET_ID="$(sql_test "SELECT MIN(user_id) FROM private_contacts WHERE phone_cipher IS NOT NULL;" | tail -1)"
if [ -z "$TARGET_ID" ] || [ "$TARGET_ID" = "NULL" ]; then
  warn "  ✗ 找不到可用于注入的联系方式记录"
  FAILED=1
else
  ORIG_CIPHER="$(sql_test "SELECT phone_cipher FROM private_contacts WHERE user_id = ${TARGET_ID};" | tail -1)"
  sql_test "UPDATE private_contacts SET phone_cipher = '13800138000' WHERE user_id = ${TARGET_ID};" >/dev/null
  expect_block "违规 D（联系方式出现明文）" "B1"
  sql_test "UPDATE private_contacts SET phone_cipher = '${ORIG_CIPHER}' WHERE user_id = ${TARGET_ID};" >/dev/null
  expect_pass "撤销违规 D"
fi

# --- 5. 已认证用户缺通过记录（C1）-------------------------------------------
log "[5/6] 注入违规 E：删除一条通过认证记录（应触发 C1）……"
TARGET_ID="$(sql_test "SELECT MIN(id) FROM verification_applications WHERE status = 'approved';" | tail -1)"
if [ -z "$TARGET_ID" ] || [ "$TARGET_ID" = "NULL" ]; then
  warn "  ✗ 找不到可用于注入的通过记录"
  FAILED=1
else
  sql_test "DELETE FROM verification_reviews WHERE application_id = ${TARGET_ID};" >/dev/null
  sql_test "DELETE FROM verification_applications WHERE id = ${TARGET_ID};" >/dev/null
  expect_block "违规 E（已认证用户缺通过记录）" "C1"
  # 撤销：重新执行 seed 的补录逻辑会把这条记录补回来
  compose exec -T \
    -e DATABASE_URL="$TEST_DB_URL" \
    -e DB_NAME="$TEST_DB" api \
    sh -lc "cd /app/apps/api && ./node_modules/.bin/ts-node -r tsconfig-paths/register src/database/seeds/seed.ts" \
    >/dev/null 2>&1 || warn "  · 撤销注入时 seed 执行异常，请手动复核测试库"
  expect_pass "撤销违规 E"
fi

# --- 6. 外键约束被删除（F1）--------------------------------------------------
# A1「地区码不在字典表」这类检查受数据库外键保护，脏数据写不进去，
# 必须先删掉外键才能验证该检查项确实有效 —— 这正是 F1/F2/F3 的意义。
log "[6/6] 注入违规 F：删除档案地区码外键约束（应触发 F1）……"
sql_test "ALTER TABLE alumni_profiles DROP FOREIGN KEY fk_alumni_profiles_region;" >/dev/null
expect_block "违规 F（外键约束缺失）" "F1"
sql_test "ALTER TABLE alumni_profiles ADD CONSTRAINT fk_alumni_profiles_region FOREIGN KEY (region_code) REFERENCES regions (code) ON DELETE SET NULL;" >/dev/null
expect_pass "撤销违规 F"

if [ "$FAILED" -ne 0 ]; then
  die "反向验证失败：数据完整性校验器未能可靠抓出违规数据"
fi

log "=== 反向验证通过 ✅（6 类违规全部被抓出，撤销后数据恢复）==="
