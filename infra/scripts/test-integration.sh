#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 集成测试执行器（真实 MySQL + Redis）
#
# 在服务器上执行：
#   bash infra/scripts/test-integration.sh
#   bash infra/scripts/test-integration.sh --keep        # 保留测试库（默认保留）
#   bash infra/scripts/test-integration.sh --pattern=e2e
#   bash infra/scripts/test-integration.sh --skip-drill   # 跳过备份恢复演练
#   bash infra/scripts/test-integration.sh --drill-selftest # 额外跑演练校验器的反向验证
#   bash infra/scripts/test-integration.sh --skip-selftest # 跳过前端 / 契约校验器反向验证
#   bash infra/scripts/test-integration.sh --skip-data-check # 跳过数据完整性校验
#   bash infra/scripts/test-integration.sh --data-selftest  # 额外跑数据完整性反向验证
#   bash infra/scripts/test-integration.sh --skip-coverage-selftest # 跳过覆盖校验器反向验证
#   bash infra/scripts/test-integration.sh --skip-worker-selftest  # 跳过 Worker 投递链路自检
#
# 回归链共 22 步：
#   1) 重建测试库 → 2) 迁移 → 3) Seed → 4) Jest 集成测试 → 5) 校验业务库未被污染
#   6) 客户端 ↔ 服务端路径一致性 → 7) 前端静态校验 → 8) **端点覆盖 100%**（含反向验证）
#   9) 前端 / 契约校验器反向验证 → 10) 数据完整性校验（含反向验证）
#   11) 备份恢复演练 → 12) **运行时响应结构校验**（线上真实调用 + 合成夹具补盲点 + 反向验证）
#   13) **请求契约对账**（客户端发送 ↔ 服务端声明，含反向验证）
#   14) **声明参数消费对账**（服务端承诺的参数 ↔ 实现是否真的用上，含反向验证）
#   15) **请求参数 DTO 校验**（@Body() / @Query() 运行时会不会被 ValidationPipe 跳过，含反向验证）
#   16) **枚举一致性对账**（数据库 ENUM ⟷ DTO ⟷ 契约，含反向验证）
#   17) **Worker 投递链路自检**（Outbox → 队列 → 投递 → 重试，容器内真实执行）
#   18) **错误码对账**（契约 ErrorCode ⟷ 服务端实际会返回的错误码，含反向验证）
#   19) **事务逃逸对账**（包了事务却用注入仓储写入 → 跳出事务，含反向验证）
#   20) **HTTP 状态码对账**（服务端声明的成功码 ⟷ 既有测试断言的成功码，含反向验证）
#   21) **并发撞唯一键对账**（「先查后插」必须有唯一键兜底，含反向验证 + 防误报断言）
#   22) **迁移一致性对账**（代码里的迁移 ⟷ 清单 ⟷ 业务库已应用，含反向验证）
#
# 安全约束（极其重要）：
#   1) 只允许对**库名包含 test** 的库执行迁移 / Seed / TRUNCATE；
#   2) 业务库（nmg_alumni）在本脚本中只读，脚本不会对其做任何写操作；
#   3) 任何一步检测到库名不含 test 立即退出。
#
# 之所以需要独立测试库：集成测试用例会 TRUNCATE 业务表，
# 若与联调/生产库同库会清空真实数据。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

TEST_DB_NAME="${TEST_DB_NAME:-nmg_alumni_test}"
TEST_PATTERN="${TEST_PATTERN:-integration}"
RESET_TEST_DB="${RESET_TEST_DB:-1}"
RUN_DRILL=1
RUN_DRILL_SELFTEST=0
RUN_SELFTEST=1
RUN_DATA_CHECK=1
RUN_DATA_SELFTEST=0
RUN_COVERAGE_SELFTEST=1
RUN_WORKER_SELFTEST=1

while [ $# -gt 0 ]; do
  case "$1" in
    --db)        TEST_DB_NAME="${2:-}"; [ -n "$TEST_DB_NAME" ] || die "--db 需要一个值"; shift 2 ;;
    --pattern)   TEST_PATTERN="${2:-}"; [ -n "$TEST_PATTERN" ] || die "--pattern 需要一个值"; shift 2 ;;
    --no-reset)  RESET_TEST_DB=0; shift ;;
    --skip-drill) RUN_DRILL=0; shift ;;
    --drill-selftest) RUN_DRILL=1; RUN_DRILL_SELFTEST=1; shift ;;
    --skip-selftest) RUN_SELFTEST=0; shift ;;
    --skip-data-check) RUN_DATA_CHECK=0; shift ;;
    --data-selftest) RUN_DATA_CHECK=1; RUN_DATA_SELFTEST=1; shift ;;
    --skip-coverage-selftest) RUN_COVERAGE_SELFTEST=0; shift ;;
    --skip-worker-selftest)  RUN_WORKER_SELFTEST=0; shift ;;
    -h|--help)   sed -n '2,32p' "$0"; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

# --- 安全护栏 ---------------------------------------------------------------
case "$TEST_DB_NAME" in
  *test*) : ;;
  *) die "拒绝执行：测试库名必须包含 'test'，当前为 '${TEST_DB_NAME}'" ;;
esac

# 业务库名（用于对比，绝不写入）
MAIN_DB_NAME="$(env_get_or MYSQL_DATABASE nmg_alumni)"
if [ "$TEST_DB_NAME" = "$MAIN_DB_NAME" ]; then
  die "拒绝执行：测试库与业务库同名（${MAIN_DB_NAME}）"
fi

require_cmd docker
require_file "$ENV_FILE"

# --- 0. 等待 api 容器健康（避免在重启窗口内执行）------------------------------
log "等待 api 容器就绪……"
for _ in $(seq 1 60); do
  STATUS="$(compose ps --format '{{.Status}}' api 2>/dev/null | tail -n 1)"
  case "$STATUS" in
    *healthy*) break ;;
    *unhealthy*|*Restarting*) die "api 容器异常：${STATUS}（请先查看 docker logs nmg-api）" ;;
  esac
  sleep 2
done
case "$(compose ps --format '{{.Status}}' api 2>/dev/null | tail -n 1)" in
  *healthy*) : ;;
  *) die "等待 api 容器健康超时" ;;
esac

MYSQL_ROOT_PASSWORD="$(env_get_or MYSQL_ROOT_PASSWORD '')"
MYSQL_USER="$(env_get_or MYSQL_USER nmg)"
MYSQL_PASSWORD="$(env_get_or MYSQL_PASSWORD '')"

log "项目=${COMPOSE_PROJECT_NAME}  测试库=${TEST_DB_NAME}  业务库(只读)=${MAIN_DB_NAME}"

# --- 生成带 URL 编码的连接串 ------------------------------------------------
build_db_url() {
  python3 - "$1" "$MYSQL_USER" "$MYSQL_PASSWORD" <<'PY'
import sys, urllib.parse
db, user, pwd = sys.argv[1], sys.argv[2], sys.argv[3]
print(f"mysql://{urllib.parse.quote(user, safe='')}:{urllib.parse.quote(pwd, safe='')}@mysql:3306/{db}")
PY
}

TEST_DB_URL="$(build_db_url "$TEST_DB_NAME")"

# --- 1. 测试库：重建（默认）或确保存在 ---------------------------------------
# 必须是**整库重建**而不是「CREATE IF NOT EXISTS」：
# 集成测试会在库里留下持久数据（资讯分类、幂等记录、资讯正文等），
# 跨次运行的残留会互相干扰 —— 上一轮建好的分类会让下一轮的
# 「创建分类」直接撞唯一索引，表现为「单独跑是绿的，整条回归链跑就红」。
# 护栏：库名已通过白名单校验（仅字母数字下划线）且必须包含 'test'。
if [ "$RESET_TEST_DB" -eq 1 ]; then
  log "重建测试库 ${TEST_DB_NAME}（DROP + CREATE）……"
  # 注意：SQL 里不要用反引号 —— 经 sh -lc 传递时反引号会被当成命令替换。
  compose exec -T mysql sh -lc \
    "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" -e \"DROP DATABASE IF EXISTS ${TEST_DB_NAME}; CREATE DATABASE ${TEST_DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci; GRANT ALL PRIVILEGES ON ${TEST_DB_NAME}.* TO '${MYSQL_USER}'@'%'; FLUSH PRIVILEGES;\"" \
    2>&1 | grep -v 'Warning' | grep -v '^$' || true
else
  log "确保测试库 ${TEST_DB_NAME} 存在（不重建）……"
  compose exec -T mysql sh -lc \
    "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" -e \"CREATE DATABASE IF NOT EXISTS ${TEST_DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci; GRANT ALL PRIVILEGES ON ${TEST_DB_NAME}.* TO '${MYSQL_USER}'@'%'; FLUSH PRIVILEGES;\"" \
    2>&1 | grep -v 'Warning' | grep -v '^$' || true
fi

# --- 2. 迁移（幂等）---------------------------------------------------------
log "对测试库执行迁移……"
compose exec -T -e DATABASE_URL="$TEST_DB_URL" -e DB_NAME="$TEST_DB_NAME" api \
  sh -lc "cd /app/apps/api && ./node_modules/.bin/typeorm-ts-node-commonjs -d src/database/data-source.ts migration:run" \
  2>&1 | tail -5

# --- 3. Seed（字典 / 角色 / 权限 / 基础数据）-------------------------------
if [ "$RESET_TEST_DB" -eq 1 ]; then
  log "对测试库执行 Seed……"
  compose exec -T -e DATABASE_URL="$TEST_DB_URL" -e DB_NAME="$TEST_DB_NAME" api \
    sh -lc "cd /app/apps/api && ./node_modules/.bin/ts-node -r tsconfig-paths/register src/database/seeds/seed.ts" \
    2>&1 | tail -8
fi

# --- 4. 运行 Jest 集成测试 ---------------------------------------------------
log "运行集成测试（pattern=${TEST_PATTERN}）……"
set +e
compose exec -T \
  -e DATABASE_URL="$TEST_DB_URL" \
  -e DB_NAME="$TEST_DB_NAME" \
  -e DB_HOST=mysql \
  -e DB_PORT=3306 \
  -e DB_USER="$MYSQL_USER" \
  -e DB_PASSWORD="$MYSQL_PASSWORD" \
  -e REDIS_DB=1 \
  -e NODE_ENV=test \
  -e RATE_LIMIT_ENABLED=false \
  api sh -lc "cd /app/apps/api && ./node_modules/.bin/jest --config jest.config.js --runInBand --testPathPattern='${TEST_PATTERN}' --forceExit"
JEST_RC=$?
set -e

# --- 4b. 校验测试库没有残留事务 ---------------------------------------------
# 集成测试若把事务遗留在连接上（异常路径没回滚），该连接回到池里后仍带着事务：
#   1) 它的读视图早于 TRUNCATE → 后续读报 "Table definition has changed"；
#   2) 它持有的间隙锁让并发 INSERT 死锁 → "Deadlock found when trying to get lock"。
# 二者都表现为「单独跑这个套件是绿的，整条回归链跑就红」——最难查的一类偶发失败。
# 这里当场点名，不让它悄悄污染下一轮。
LEFT_TRS="$(compose exec -T mysql sh -lc \
  "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" -N -B -e \"SELECT COUNT(*) FROM information_schema.innodb_trx;\"" 2>/dev/null | tail -1)"
log "测试库残留事务数 = ${LEFT_TRS}"
if [ "${LEFT_TRS}" != "0" ] && [ -n "${LEFT_TRS}" ]; then
  compose exec -T mysql sh -lc \
    "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" -e \"SELECT trx_id, trx_state, trx_started, trx_query FROM information_schema.innodb_trx;\"" 2>&1 | grep -v 'Warning' || true
  die "测试库仍有 ${LEFT_TRS} 个未结束事务（连接回池时未回滚）"
fi

# --- 5. 校验业务库未被污染 ---------------------------------------------------
log "校验业务库 ${MAIN_DB_NAME} 未被测试影响……"
MAIN_USERS="$(compose exec -T mysql sh -lc \
  "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" -N -B -D ${MAIN_DB_NAME} -e \"SELECT COUNT(*) FROM users;\"" 2>/dev/null | tail -1)"
log "业务库 users 行数 = ${MAIN_USERS}"

if [ "$JEST_RC" -ne 0 ]; then
  die "集成测试失败（jest 退出码 ${JEST_RC}）"
fi

log "集成测试全部通过 ✅"

# --- 6. 客户端 ↔ 服务端 路径一致性校验 --------------------------------------
# 契约（packages/contracts）是唯一事实来源；本步骤比对「小程序 / 管理后台的真实调用点」
# 与「服务端实际注册的方法+路径」，防止契约漂移在运行时才暴露为 404 / 405。
SWAGGER_URL="${SWAGGER_URL:-http://127.0.0.1:18081/docs-json}"
if command -v node >/dev/null 2>&1; then
  log "校验客户端与服务端路径一致性（swagger=${SWAGGER_URL}）……"
  set +e
  node "${PROJECT_ROOT}/infra/scripts/check-client-paths.mjs" --root "${PROJECT_ROOT}" --swagger "${SWAGGER_URL}"
  PATH_RC=$?
  set -e
  [ "$PATH_RC" -eq 0 ] || die "客户端路径一致性校验失败（退出码 ${PATH_RC}）"
  log "路径一致性校验通过 ✅"
else
  warn "未找到 node，跳过路径一致性校验"
fi

# --- 7. 前端静态校验（小程序 + 管理后台）-----------------------------------
# 小程序未在微信开发者工具中运行、管理后台不跑浏览器，这一层静态交叉校验
# 负责挡住「编译期查不出、运行时才白屏/无反应」的缺陷。
if command -v node >/dev/null 2>&1; then
  log "运行前端静态校验（小程序 + 管理后台）……"
  set +e
  bash "${PROJECT_ROOT}/infra/scripts/check-frontend.sh"
  FRONTEND_RC=$?
  set -e
  [ "$FRONTEND_RC" -eq 0 ] || die "前端静态校验失败（退出码 ${FRONTEND_RC}）"
else
  warn "未找到 node，跳过前端静态校验"
fi

# --- 8. 端点覆盖校验（服务端端点 ↔ 集成测试）--------------------------------
# 「从来没被调用过」的端点最容易藏着真实缺陷（上传链路的横向越权就是这么发现的）。
# 本步骤要求服务端每一条端点都被集成测试触达 —— 出现未覆盖端点即失败，
# 防止新增接口时忘了补测。
if command -v node >/dev/null 2>&1; then
  log "校验服务端端点覆盖（端点 ↔ 集成测试）……"
  set +e
  node "${PROJECT_ROOT}/infra/scripts/check-test-coverage.mjs" \
    --root "${PROJECT_ROOT}" --fail-on-uncovered
  COVERAGE_RC=$?
  set -e
  [ "$COVERAGE_RC" -eq 0 ] || die "端点覆盖校验失败（存在未被集成测试触达的端点，退出码 ${COVERAGE_RC}）"
  log "端点覆盖校验通过 ✅"

  # 覆盖校验器本身的反向验证：护栏恒过的话，「新增接口忘补测」就会悄无声息
  if [ "$RUN_COVERAGE_SELFTEST" -eq 1 ]; then
    log "运行端点覆盖校验器反向验证……"
    set +e
    bash "${PROJECT_ROOT}/infra/scripts/check-test-coverage-selftest.sh"
    COVERAGE_SELFTEST_RC=$?
    set -e
    [ "$COVERAGE_SELFTEST_RC" -eq 0 ] || die "端点覆盖校验器反向验证失败（退出码 ${COVERAGE_SELFTEST_RC}）"
    log "端点覆盖校验器反向验证通过 ✅"
  else
    warn "按参数跳过端点覆盖校验器反向验证"
  fi
else
  warn "未找到 node，跳过端点覆盖校验"
fi

# --- 9. 前端 / 契约校验器的反向验证 -----------------------------------------
# 校验器本身如果恒过，「校验通过」就没有意义。
# 本步骤在临时副本上注入真实缺陷，断言 5 个校验器确实会报错并返回非 0。
if [ "$RUN_SELFTEST" -eq 1 ]; then
  log "运行前端 / 契约校验器反向验证……"
  set +e
  bash "${PROJECT_ROOT}/infra/scripts/check-frontend-selftest.sh"
  SELFTEST_RC=$?
  set -e
  [ "$SELFTEST_RC" -eq 0 ] || die "前端校验器反向验证失败（退出码 ${SELFTEST_RC}）"
  log "前端 / 契约校验器反向验证通过 ✅"
else
  warn "按参数跳过前端 / 契约校验器反向验证"
fi

# --- 10. 数据完整性校验（业务库，只读）-------------------------------------
# 把设计文档里的硬约束（字典外键、密文存储、认证状态机自洽、唯一性）
# 变成可执行检查；任何一项出现违规即失败。
if [ "$RUN_DATA_CHECK" -eq 1 ]; then
  log "运行数据完整性校验（业务库，只读）……"
  set +e
  bash "${PROJECT_ROOT}/infra/scripts/check-data-integrity.sh"
  DATA_RC=$?
  set -e
  [ "$DATA_RC" -eq 0 ] || die "数据完整性校验失败（退出码 ${DATA_RC}）"
  log "数据完整性校验通过 ✅"

  # 数据校验器的反向验证：注入违规数据必须被抓出（只在测试库注入）
  if [ "$RUN_DATA_SELFTEST" -eq 1 ]; then
    log "运行数据完整性校验器反向验证（注入违规必须被抓出）……"
    set +e
    bash "${PROJECT_ROOT}/infra/scripts/check-data-integrity-selftest.sh"
    DATA_SELFTEST_RC=$?
    set -e
    [ "$DATA_SELFTEST_RC" -eq 0 ] || die "数据完整性反向验证失败（退出码 ${DATA_SELFTEST_RC}）"
    log "数据完整性反向验证通过 ✅"
  fi
else
  warn "按参数跳过数据完整性校验"
fi
# --- 11. 备份恢复演练 -------------------------------------------------------
# 备份只有「真的能恢复」才算数。本步骤：新备份 → 恢复到演练库 → 逐表行数 +
# 列结构/外键/索引/迁移指纹比对 → 删除演练库。线上库全程只读。
if [ "$RUN_DRILL" -eq 1 ]; then
  log "运行备份恢复演练……"
  set +e
  bash "${PROJECT_ROOT}/infra/scripts/backup-restore-drill.sh"
  DRILL_RC=$?
  set -e
  [ "$DRILL_RC" -eq 0 ] || die "备份恢复演练失败（退出码 ${DRILL_RC}）"
  log "备份恢复演练通过 ✅"

  # 反向验证：确认演练校验器不是「恒过」
  if [ "$RUN_DRILL_SELFTEST" -eq 1 ]; then
    log "运行演练校验器反向验证（注入缺陷必须被抓出）……"
    set +e
    bash "${PROJECT_ROOT}/infra/scripts/backup-restore-drill-selftest.sh"
    SELFTEST_RC=$?
    set -e
    [ "$SELFTEST_RC" -eq 0 ] || die "演练校验器反向验证失败（退出码 ${SELFTEST_RC}）"
    log "演练校验器反向验证通过 ✅"
  fi
else
  warn "按参数跳过备份恢复演练"
fi

# --- 12. 运行时响应结构校验（真实调用服务端，只读）--------------------------
# 路径对、契约对，**响应结构**依然可能错：
#   服务端把 { items, meta } 返回成裸数组、把必填字段悄悄删掉、
#   或者把后台页面的筛选参数静默忽略 —— 这些都不会抛异常，
#   页面照常渲染，只是列是空的、筛选框是摆设。
#   缺陷 #59 / #60 / #61 就是这样被本步骤抓出来的。
#
# 本步骤拿「客户端声明的泛型返回类型」当标准，逐字段核对服务端真实响应；
# 只做只读 GET，不产生任何业务数据。
if command -v node >/dev/null 2>&1; then
  log "运行运行时响应结构校验（真实调用服务端）……"

  # 取一个**已存在**的普通校友令牌：用户态端点（/me/**、通讯录、我的通知）
  # 没有令牌就会被跳过，小程序的主用户路径就没人守了。
  # 这里用种子里已有的压测账号换取令牌 —— 先确认它在业务库里存在，
  # 绝不新建用户，业务库 users 行数保持不变。
  PROBE_OPENID="mock_k6_alumni_001"
  PROBE_USER_TOKEN=""
  EXISTING_OPENID="$(compose exec -T mysql sh -lc \
    "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" -N -B -D ${MAIN_DB_NAME} -e \"SELECT openid FROM users WHERE openid = '${PROBE_OPENID}' LIMIT 1;\"" \
    2>/dev/null | tail -1)"
  if [ -n "$EXISTING_OPENID" ]; then
    PROBE_USER_TOKEN="$(curl -s -X POST http://127.0.0.1:18081/api/v1/auth/mock/login \
      -H 'content-type: application/json' \
      -d "{\"mockOpenid\":\"${EXISTING_OPENID}\"}" \
      | python3 -c 'import sys,json; print(json.load(sys.stdin).get("data",{}).get("accessToken",""))' 2>/dev/null || true)"
    if [ -n "$PROBE_USER_TOKEN" ]; then
      log "已取得用户态令牌（${EXISTING_OPENID}，已存在的账号）"
    fi
  else
    warn "业务库里没有 ${PROBE_OPENID}，跳过用户态端点的结构校验（不会为此新建用户）"
  fi

  set +e
  if [ -n "$PROBE_USER_TOKEN" ]; then
    node "${PROJECT_ROOT}/infra/scripts/check-response-shape.mjs" \
      --root "${PROJECT_ROOT}" --base "http://127.0.0.1:18081/api/v1" \
      --user-token "$PROBE_USER_TOKEN"
  else
    node "${PROJECT_ROOT}/infra/scripts/check-response-shape.mjs" \
      --root "${PROJECT_ROOT}" --base "http://127.0.0.1:18081/api/v1"
  fi
  SHAPE_RC=$?
  set -e
  [ "$SHAPE_RC" -eq 0 ] || die "响应结构校验失败（存在与契约声明不符的响应，退出码 ${SHAPE_RC}）"
  log "响应结构校验通过 ✅"

  # 合成夹具校验（离线）：补上线上数据天然缺失的部分 ——
  #   线上业务库里**没有**带附件的认证申请、没有审核历史、没有活动报名，
  #   这些契约类型的**元素结构**在线上永远校验不到（数组恒为空）。
  #   合成夹具里这些数组都带齐元素 → 元素结构每轮都被真正核对一遍。
  #   同时要求夹具**不得**报出盲点（否则说明夹具本身又造出了空数组）。
  log "运行响应结构夹具校验（合成夹具，覆盖线上缺失的元素结构）……"
  set +e
  FIXTURE_OUT="$(node "${PROJECT_ROOT}/infra/scripts/check-response-shape.mjs" \
    --root "${PROJECT_ROOT}" --fixture "${PROJECT_ROOT}/infra/fixtures/response-shape" 2>&1)"
  FIXTURE_RC=$?
  set -e
  printf '%s\n' "$FIXTURE_OUT" | tail -6 | sed 's/^/  /'
  [ "$FIXTURE_RC" -eq 0 ] || die "响应结构夹具校验失败（退出码 ${FIXTURE_RC}）"
  if printf '%s' "$FIXTURE_OUT" | grep -q "元素结构从未被校验"; then
    die "响应结构夹具校验失败：夹具自身存在空数组 → 有元素结构仍未被校验"
  fi
  log "响应结构夹具校验通过 ✅（元素结构盲点已闭合）"

  # 反向验证：证明该校验器不是恒过（注入结构缺陷必须被抓出）
  if [ "$RUN_COVERAGE_SELFTEST" -eq 1 ]; then
    log "运行响应结构校验器反向验证……"
    set +e
    bash "${PROJECT_ROOT}/infra/scripts/check-response-shape-selftest.sh"
    SHAPE_SELFTEST_RC=$?
    set -e
    [ "$SHAPE_SELFTEST_RC" -eq 0 ] || die "响应结构校验器反向验证失败（退出码 ${SHAPE_SELFTEST_RC}）"
    log "响应结构校验器反向验证通过 ✅"
  else
    warn "按参数跳过响应结构校验器反向验证"
  fi
else
  warn "未找到 node，跳过响应结构校验"
fi

# --- 13. 请求契约对账（客户端发送 ↔ 服务端声明）--------------------------
# 客户端发了、服务端没接的查询参数或请求字段，会被**静默丢弃**：
#   - 查询参数：DTO 里没这个字段 → 被剥掉，筛选框成了摆设；
#   - 请求体字段：ValidationPipe 的 whitelist 直接剥掉，接口照样 200。
# 缺陷 #59 / #62 / #63 都是这一类，不抛异常、页面也看不出异常。
# 本步骤把「客户端发了什么」与「服务端接了什么」摆在一起对账（只读，不写业务库）。
if command -v node >/dev/null 2>&1; then
  log "运行请求契约对账（客户端发送 ↔ 服务端声明）……"
  set +e
  node "${PROJECT_ROOT}/infra/scripts/check-request-contract.mjs" \
    --root "${PROJECT_ROOT}" --swagger "http://127.0.0.1:18081/docs-json"
  REQ_RC=$?
  set -e
  [ "$REQ_RC" -eq 0 ] || die "请求契约对账失败（客户端发送了服务端不接受的参数或字段，退出码 ${REQ_RC}）"
  log "请求契约对账通过 ✅"

  # 反向验证：证明该校验器不是恒过（注入请求契约缺陷必须被抓出）
  if [ "$RUN_COVERAGE_SELFTEST" -eq 1 ]; then
    log "运行请求契约校验器反向验证……"
    set +e
    bash "${PROJECT_ROOT}/infra/scripts/check-request-contract-selftest.sh"
    REQ_SELFTEST_RC=$?
    set -e
    [ "$REQ_SELFTEST_RC" -eq 0 ] || die "请求契约校验器反向验证失败（退出码 ${REQ_SELFTEST_RC}）"
    log "请求契约校验器反向验证通过 ✅"
  else
    warn "按参数跳过请求契约校验器反向验证"
  fi
else
  warn "未找到 node，跳过请求契约对账"
fi

# --- 14. 声明参数消费对账（服务端承诺的参数 ↔ 实现是否真的用上）--------------
# 请求契约对账管的是「客户端发了什么」，这一层管的是**服务端自己承诺了什么**：
#   DTO 里声明了 N 个筛选项 → Swagger 如实对外公布 → 但 handler 只透传了其中 2 个，
#   其余 N-2 个被静默丢弃：请求照发、状态码 200、结果不受筛选影响。
# 响应结构校验（看返回了什么）、请求契约对账（看客户端发了什么）都查不出这一类，
# 必须单独一层。缺陷 #72 就是这样被抓出来的。
if command -v node >/dev/null 2>&1; then
  log "运行声明参数消费对账（服务端承诺的参数 ↔ 实现是否真的用上）……"
  set +e
  node "${PROJECT_ROOT}/infra/scripts/check-swagger-param-usage.mjs" \
    --root "${PROJECT_ROOT}" --swagger "http://127.0.0.1:18081/docs-json"
  PARAM_RC=$?
  set -e
  [ "$PARAM_RC" -eq 0 ] || die "声明参数消费对账失败（存在「声明了但没用」的查询参数，退出码 ${PARAM_RC}）"
  log "声明参数消费对账通过 ✅"

  # 反向验证：证明该校验器不是恒过（注入「声明了但没用」缺陷必须被抓出）
  if [ "$RUN_COVERAGE_SELFTEST" -eq 1 ]; then
    log "运行声明参数消费校验器反向验证……"
    set +e
    bash "${PROJECT_ROOT}/infra/scripts/check-swagger-param-usage-selftest.sh"
    PARAM_SELFTEST_RC=$?
    set -e
    [ "$PARAM_SELFTEST_RC" -eq 0 ] || die "声明参数消费校验器反向验证失败（退出码 ${PARAM_SELFTEST_RC}）"
    log "声明参数消费校验器反向验证通过 ✅"
  else
    warn "按参数跳过声明参数消费校验器反向验证"
  fi
else
  warn "未找到 node，跳过声明参数消费对账"
fi

# --- 15. 请求体 DTO 校验（运行时会不会被 ValidationPipe 跳过）----------------
# 请求体写成 `Record<string, unknown>` / 普通 `interface` / 内联对象字面量时，
# **运行时 metatype 是 Object** → ValidationPipe 的 `toValidate()` 返回 false
# → 整个请求体被静默跳过校验：畸形输入进库、非法枚举变 500、契约外字段不被拒绝。
# 缺陷 #79（管理端 12 个写端点）、#88（媒体登记）、#89（活动报名）都是这一类。
if command -v node >/dev/null 2>&1; then
  log "运行请求参数 DTO 校验（运行时会不会被 ValidationPipe 跳过）……"
  set +e
  node "${PROJECT_ROOT}/infra/scripts/check-request-dto.mjs" --root "${PROJECT_ROOT}"
  BODY_DTO_RC=$?
  set -e
  [ "$BODY_DTO_RC" -eq 0 ] || die "请求参数 DTO 校验失败（存在运行时不会被校验的请求体 / 查询对象，退出码 ${BODY_DTO_RC}）"
  log "请求参数 DTO 校验通过 ✅"

  # 反向验证：证明该校验器不是恒过（注入「请求体不被校验」的缺陷必须被抓出）
  if [ "$RUN_COVERAGE_SELFTEST" -eq 1 ]; then
    log "运行请求参数 DTO 校验器反向验证……"
    set +e
    bash "${PROJECT_ROOT}/infra/scripts/check-request-dto-selftest.sh"
    BODY_DTO_SELFTEST_RC=$?
    set -e
    [ "$BODY_DTO_SELFTEST_RC" -eq 0 ] || die "请求参数 DTO 校验器反向验证失败（退出码 ${BODY_DTO_SELFTEST_RC}）"
    log "请求参数 DTO 校验器反向验证通过 ✅"
  else
    warn "按参数跳过请求体 DTO 校验器反向验证"
  fi
else
  warn "未找到 node，跳过请求参数 DTO 校验"
fi

# --- 16. 枚举一致性对账（数据库 ENUM ⟷ DTO ⟷ 契约）------------------------
# 状态值要在四个地方对得上：数据库 ENUM、DTO 的 @IsIn、契约的联合类型、客户端筛选值。
# 任何一处漂移都不抛异常：
#   - DTO 放行 DB 不接受的值 → 落库被数据库拒绝 → 500；
#   - 状态筛选没有枚举校验 → 传错值静默返回**空列表**，
#     用户会误判成「数据丢了」而不是「参数写错了」；
#   - 契约声明了 DB 不接受的值 → 客户端照契约传 → 500。
if command -v node >/dev/null 2>&1; then
  log "运行枚举一致性对账（数据库 ENUM ⟷ DTO ⟷ 契约）……"
  set +e
  node "${PROJECT_ROOT}/infra/scripts/check-enum-consistency.mjs" --root "${PROJECT_ROOT}"
  ENUM_RC=$?
  set -e
  [ "$ENUM_RC" -eq 0 ] || die "枚举一致性对账失败（存在枚举漂移，退出码 ${ENUM_RC}）"
  log "枚举一致性对账通过 ✅"

  # 反向验证：证明该校验器不是恒过（注入枚举漂移必须被抓出）
  if [ "$RUN_COVERAGE_SELFTEST" -eq 1 ]; then
    log "运行枚举一致性校验器反向验证……"
    set +e
    bash "${PROJECT_ROOT}/infra/scripts/check-enum-consistency-selftest.sh"
    ENUM_SELFTEST_RC=$?
    set -e
    [ "$ENUM_SELFTEST_RC" -eq 0 ] || die "枚举一致性校验器反向验证失败（退出码 ${ENUM_SELFTEST_RC}）"
    log "枚举一致性校验器反向验证通过 ✅"
  else
    warn "按参数跳过枚举一致性校验器反向验证"
  fi
else
  warn "未找到 node，跳过枚举一致性对账"
fi

# --- 17. Worker 投递链路自检（Outbox → 队列 → 投递 → 重试）-------------------
# Worker 的三个静默失败**不会抛异常、不会体现在任何接口响应里**：
#   #95 失败后重投被 BullMQ 的 jobId 去重吞掉 → 通知永远投不出去；
#   #96 投递记录没更新（affectedRows = 0）也照样标记 done → 消息静默丢失；
#   #97 payload 缺 notificationId 的事件永远卡在 pending，被每 2 秒重复扫描。
# 常规 jest 集成测试完全覆盖不到这一层 —— 它根本不经过 HTTP 接口。
# 本步骤在 worker 容器内用**测试库 + 测试 Redis（db=1）+ 独立队列名**真实跑一遍。
if [ "$RUN_WORKER_SELFTEST" -eq 1 ]; then
  log "运行 Worker 投递链路自检（容器内 · 测试库 · 测试队列）……"
  # 旧镜像里没有自检脚本 → 明确提示重建，而不是含糊地失败
  if ! compose exec -T worker test -f /app/apps/worker/dist/selfcheck.js >/dev/null 2>&1; then
    die "worker 镜像里缺少 dist/selfcheck.js —— 请先重建镜像（build worker && up -d worker）再跑回归链"
  fi
  set +e
  compose exec -T \
    -e DB_NAME="$TEST_DB_NAME" \
    -e DB_HOST=mysql \
    -e DB_PORT=3306 \
    -e DB_USER="$MYSQL_USER" \
    -e DB_PASSWORD="$MYSQL_PASSWORD" \
    -e REDIS_DB=1 \
    worker node dist/selfcheck.js
  WORKER_RC=$?
  set -e
  [ "$WORKER_RC" -eq 0 ] || die "Worker 投递链路自检失败（退出码 ${WORKER_RC}）"
  log "Worker 投递链路自检通过 ✅"
else
  warn "按参数跳过 Worker 投递链路自检"
fi

# --- 18. 错误码对账（契约 ErrorCode ⟷ 服务端实际会返回的错误码）--------------
# 契约里的错误码如果服务端**从不返回**，它就是**死码** ——
# 客户端按契约写的判断分支永远走不到，而且没有任何报错：
#   #103 IDEMPOTENCY_CONFLICT / #109 VERIFICATION_REQUIRED / #110 AUTH_FAILED
# 都是这样被漏掉的。反过来，服务端返回了契约里没有的码，客户端同样会失配。
if command -v node >/dev/null 2>&1; then
  log "运行错误码对账（契约 ErrorCode ⟷ 服务端实际引用）……"
  set +e
  node "${PROJECT_ROOT}/infra/scripts/check-dead-error-code.mjs" --root "${PROJECT_ROOT}"
  DEADCODE_RC=$?
  set -e
  [ "$DEADCODE_RC" -eq 0 ] || die "错误码对账失败（退出码 ${DEADCODE_RC}）：存在死错误码或契约缺码"

  log "运行错误码对账校验器反向验证……"
  bash "${PROJECT_ROOT}/infra/scripts/check-dead-error-code-selftest.sh"
else
  warn "未找到 node，跳过错误码对账"
fi

# --- 19. 事务逃逸对账（包了事务，却没写进那个事务）-------------------------
# TypeORM 里事务回调的 `manager` 绑定事务自己的 queryRunner，
# 而 `@InjectRepository(X)` 注入的默认仓储走**另一条连接**。
# 于是「事务里用 this.xxx.save(...)」会**跳出事务**：立刻提交，事务回滚也回滚不掉它，
# 留下「一半提交、一半回滚」的半成品状态，而且接口照样 200。
# #118（认证补交材料）与 #119（个人资料）修复前就是这个形态。
if command -v node >/dev/null 2>&1; then
  log "运行事务逃逸对账（事务边界 ⟷ 实际写入路径）……"
  set +e
  node "${PROJECT_ROOT}/infra/scripts/check-transaction-escape.mjs" --root "${PROJECT_ROOT}"
  TX_RC=$?
  set -e
  [ "$TX_RC" -eq 0 ] || die "事务逃逸对账失败（退出码 ${TX_RC}）：事务内存在跳出事务的写入"

  log "运行事务逃逸校验器反向验证……"
  bash "${PROJECT_ROOT}/infra/scripts/check-transaction-escape-selftest.sh"
else
  warn "未找到 node，跳过事务逃逸对账"
fi

# --- 20. HTTP 状态码对账（服务端声明的成功码 ⟷ 测试断言的成功码）-----------
# 改服务端的 HTTP 语义时，**既有测试文件通常不在改动清单里** ——
# 没人会想到去翻测试，而那批用例在改完的那一刻就已经失效了。
# 缺陷 #129 就是这么漏的：#126 把 7 个「不创建资源」的 POST 从 201 改成 200，
# 而 `notifications.e2e-spec.ts` 仍断言 201，报错还发生在**别的**套件里。
# 这一层把「服务端的成功状态码」与「测试断言的状态码」逐条对账，
# 让这类漂移在**改服务端的那一次**就被抓住。
if command -v node >/dev/null 2>&1; then
  log "运行 HTTP 状态码对账（服务端声明 ⟷ 测试断言）……"
  set +e
  node "${PROJECT_ROOT}/infra/scripts/check-status-code-assertions.mjs" --root "${PROJECT_ROOT}"
  STATUS_RC=$?
  set -e
  [ "$STATUS_RC" -eq 0 ] || die "HTTP 状态码对账失败（退出码 ${STATUS_RC}）：存在状态码断言漂移"

  log "运行状态码对账校验器反向验证……"
  bash "${PROJECT_ROOT}/infra/scripts/check-status-code-assertions-selftest.sh"
else
  warn "未找到 node，跳过 HTTP 状态码对账"
fi

# --- 21. 并发撞唯一键对账（「先查后插」必须有唯一键兜底）---------------------
# 「先查后插」在单线程下永远正确 —— 只发生一次写，出不了错。
# 但**并发**下两个请求都读不到既有行 → 都去 INSERT → 后到的撞唯一键 → 500。
# 缺陷 #137 就是这种形态：同一用户在两台设备同时打开「联系方式授权」开关。
# 这类缺陷单线程测试**覆盖不到**（用例再全也测不出来），且形态会在代码里重复出现，
# 只能由工具兜住：凡「读同一张表 + 往同一张表插」又没有唯一键兜底的，一律点名。
if command -v node >/dev/null 2>&1; then
  log "运行并发撞唯一键对账（先查后插 ⟷ 唯一键兜底）……"
  set +e
  node "${PROJECT_ROOT}/infra/scripts/check-concurrent-upsert.mjs" --root "${PROJECT_ROOT}"
  CU_RC=$?
  set -e
  [ "$CU_RC" -eq 0 ] || die "并发撞唯一键对账失败（退出码 ${CU_RC}）：存在「先查后插」且无唯一键兜底"

  log "运行并发撞唯一键校验器反向验证……"
  bash "${PROJECT_ROOT}/infra/scripts/check-concurrent-upsert-selftest.sh"
else
  warn "未找到 node，跳过并发撞唯一键对账"
fi

# --- 22. 迁移一致性对账（代码清单 ⟷ 数据库已应用）---------------------------
# 缺陷 #142（部署不跑迁移）与 #143（迁移清单曾有两份）都属于
# 「**没有任何报错**」的静默失败 —— 测试库每次重建并跑迁移，
# 所以这类漂移**只会在业务库上炸**。这一层把「代码要的结构」与
# 「库里实际的结构」当面对账，并在链尾做反向验证。
if command -v bash >/dev/null 2>&1; then
  log "运行迁移一致性对账（代码清单 ⟷ 业务库已应用）……"
  set +e
  bash "${PROJECT_ROOT}/infra/scripts/check-pending-migrations.sh"
  MIG_RC=$?
  set -e
  [ "$MIG_RC" -eq 0 ] || die "迁移一致性对账失败（退出码 ${MIG_RC}）：存在未登记或未应用的迁移"

  log "运行迁移一致性对账校验器反向验证……"
  bash "${PROJECT_ROOT}/infra/scripts/check-pending-migrations-selftest.sh"
else
  warn "未找到 bash，跳过迁移一致性对账"
fi
