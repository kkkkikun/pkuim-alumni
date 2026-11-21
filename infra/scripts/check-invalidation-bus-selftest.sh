#!/usr/bin/env bash
# 失效总线的**负向验证**门禁（第七轮）。
#
# 目的：把「故意把总线改坏 → 断言守它的用例会红」这件事变成
#   **可重复、可在 CI 里跑**的门禁。
#
# ⚠️ 为什么必须有这个门禁（历史教训）：
#   第五 / 六轮把「撤权跨实例即刻生效」做成了共享失效总线，
#   但**用例会红**这件事此前只靠人工临时改代码 + 手动跑一次
#   （脚本 `.agent/negative-verification.sh`）——
#   于是「以后有人把总线改坏了」这件事，**CI 一声不吭**，
#   全绿放行。缺陷 #186 / #187 就是同一片土壤。
#
# 本门禁做四件事（缺一不可）：
#   1. **基线绿**：不改代码时，守总线的两个套件必须**全绿**
#      —— 否则「红」就失去意义（红可能是本来就红）。
#   2. **改坏必红**：把总线实现改成三种**退化形态**，
#      断言「守它的那条用例」**必须失败**：
#        A. 永不订阅（订阅端形同虚设）
#        B. 永不发布（发布端形同虚设）
#        C. 发布时抛错（总线故障变成 5xx）
#   3. **必须还原**：无论脚本中途怎么失败，退出时都要把被临时改坏的实现**原样还原**
#      （并校验字节级一致）—— 否则会把一个「改坏的实现」留在工作区里。
#   4. **锚点失效即失败**：变异锚点对不上（实现被改写了）时**直接失败**，
#      绝不「跳过」—— 否则门禁会变成一个**恒过**的摆设。
#
# 用法：
#   bash infra/scripts/check-invalidation-bus-selftest.sh
#
# 环境变量（与仓库既有约定一致，**不把口令写进仓库**）：
#   DATABASE_URL / DB_* / REDIS_* / MINIO_* 均可覆盖；
#   缺省值与 `docker-compose.yml` 的开发栈一致。
#
# ⚠️ 为什么**不**接进 `infra/scripts/test-integration.sh`（本地回归链）：
#    那条链在 **docker 容器里**跑，变异会落到**开发机的工作副本**上；
#    本门禁只在 CI（`.github/workflows/ci.yml`）与本地手动路径
#    （`.agent/negative-verification.sh`）里跑 —— 两条路径执行的是**同一个脚本**。
#
# 退出码：0 = 门禁通过（基线绿 + 三种退化形态都被抓到）；1 = 门禁失败。

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# ⚠️ 测试库连接**走环境变量**（不把口令写进仓库）：
#    DATABASE_URL / DB_* / REDIS_* 都可以覆盖；
#    缺省值与仓库自己的 compose 栈一致（`docker-compose.yml`：MySQL 13307 / Redis 16380）。
export DATABASE_URL="${DATABASE_URL:-mysql://${MYSQL_USER:-nmg}:${MYSQL_PASSWORD:-dev_app}@127.0.0.1:${MYSQL_PORT:-13307}/${MYSQL_DATABASE:-nmg_alumni_test}}"
export REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
export REDIS_PORT="${REDIS_PORT:-16380}"

SVC="apps/api/src/common/services/invalidation-bus.service.ts"

if [ ! -f "$SVC" ]; then
  echo "找不到总线实现：$SVC" >&2
  exit 1
fi

BACKUP="$(mktemp /tmp/invalidation-bus.service.ts.orig.XXXXXX)"
cp "$SVC" "$BACKUP"
ORIGINAL_SUM="$(sha256sum "$SVC" | cut -d' ' -f1)"

restore () {
  if [ -f "$BACKUP" ]; then
    cp "$BACKUP" "$SVC"
    rm -f "$BACKUP"
  fi
}
# 退出时**一定**还原被临时改坏的总线实现（哪怕脚本中途失败）。
trap restore EXIT

FAILURES=0

fail () {
  echo "  [FAIL] $*" >&2
  FAILURES=$((FAILURES + 1))
}

pass () {
  echo "  [PASS] $*"
}

# ---------------------------------------------------------------------------
# 变异：把总线实现改成退化形态。
#
# ⚠️ 锚点对不上时**直接失败**（不静默跳过）——
#    锚点失效意味着实现被改写了，本门禁的「三种退化形态」已经名不副实。
# ---------------------------------------------------------------------------
apply_variant () {
  python3 - "$1" "$SVC" <<'PY'
import re
import sys

variant = sys.argv[1]
path = sys.argv[2]
src = open(path, encoding="utf-8").read()


def sub_once(pattern, repl, text, flags=0):
    new_text, count = re.subn(pattern, repl, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(
            f"变异锚点失效（{variant}）：匹配不到 {pattern!r} —— "
            "总线实现已被改写，本门禁必须同步更新（否则它就是个恒过的摆设）。"
        )
    return new_text


if variant == "never-subscribe":
    # 订阅调用被换成空操作（**状态照旧标记为「已订阅」**）——
    # 这是最阴的一种退化：实例以为自己订阅上了，实际上一个事件都收不到。
    # ⚠️ 必须是**类型安全**的变异：早退（`return;`）会让后面的 `try` 变成不可达代码，
    #    TypeScript 在不可达代码里不再做类型收窄 → 整个套件因**编译错误**跑不起来，
    #    那不是「行为被用例守住」的证据（门禁会变成一个假阳性）。
    src = sub_once(
        r"(      await )this\.subscriber\.subscribe\(this\.channel\);",
        r"\1Promise.resolve(); // [负向验证] 永不订阅（订阅调用换成空操作）",
        src,
    )
elif variant == "never-publish":
    # 真正的 PUBLISH 被换成空操作 → 事件永远发不出去。
    src = sub_once(
        r"(      await this\.withTimeout\(\n)"
        r"(        )this\.publisher\.publish\(this\.channel, JSON\.stringify\(event\)\),",
        r"\1\2Promise.resolve(0), // [负向验证] 永不发布（发布调用换成空操作）",
        src,
    )
elif variant == "publish-throws":
    # publish() 的 catch 分支改成抛错 → 总线故障变成管理端写操作的 5xx。
    src = sub_once(
        r"(    \} catch \(error\) \{\n"
        r"      this\.lastError = error instanceof Error \? error\.message : String\(error\);.*?"
        r")      return false;\n",
        r"\1      throw error; // [负向验证] 发布时抛错\n",
        src,
        flags=re.S,
    )
else:
    raise SystemExit(f"未知变异：{variant}")

open(path, "w", encoding="utf-8").write(src)
PY
}

# ---------------------------------------------------------------------------
# 跑一个套件，把 jest 的 JSON 报告落到 $2。
# 退出码：0 = 全绿；1 = 有用例失败；其它 = 套件本身没跑起来（更糟）。
# ---------------------------------------------------------------------------
run_suite () {
  local pattern="$1"
  local out="$2"
  rm -f "$out"
  pnpm --filter @nmg/api exec jest --config jest.config.js --runInBand \
    --testPathPattern="$pattern" --json --outputFile="$out" >/tmp/invalidation-bus-selftest.log 2>&1
  return $?
}

# 从 jest 的 JSON 报告里取「失败用例的完整名字」。
failed_test_names () {
  node -e '
    const fs = require("fs");
    const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const names = [];
    for (const suite of report.testResults ?? []) {
      for (const test of suite.assertionResults ?? []) {
        if (test.status === "failed") names.push(test.fullName);
      }
    }
    process.stdout.write(names.join("\n"));
  ' "$1"
}

# 「套件根本没跑起来」（编译错误 / beforeAll 抛错）。
#
# ⚠️ 这**不算**证据：门禁要证明的是「**行为**被用例守住」，
#    而不是「代码编译不过」。把这一类单列出来，避免门禁变成假阳性。
suite_not_run () {
  node -e '
    const fs = require("fs");
    const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const broken = [];
    for (const suite of report.testResults ?? []) {
      if (suite.status === "failed" && (suite.assertionResults ?? []).length === 0) {
        broken.push(suite.name);
      }
    }
    process.stdout.write(broken.join("\n"));
  ' "$1"
}

# 断言「某个用例失败了」；用例名里可能带 markdown 星号，按包含关系匹配。
assert_failed () {
  local report="$1"
  local needle="$2"
  local label="$3"
  if [ ! -f "$report" ]; then
    fail "$label：没有生成 jest 报告（套件没跑起来？）"
    return
  fi
  if failed_test_names "$report" | grep -qF -- "$needle"; then
    pass "$label：用例「$needle」如期变红"
  else
    fail "$label：期望失败的用例「$needle」并没有失败 —— 这一条承诺**没有用例守着**"
    echo "        实际失败的用例：" >&2
    failed_test_names "$report" | sed 's/^/          - /' >&2
  fi
}

assert_green () {
  local report="$1"
  local label="$2"
  if [ ! -f "$report" ]; then
    fail "$label：没有生成 jest 报告（套件没跑起来？）"
    return
  fi
  local failed
  failed="$(failed_test_names "$report" | grep -c . || true)"
  if [ "$failed" -eq 0 ] && [ -z "$(suite_not_run "$report")" ]; then
    pass "$label：全部用例通过"
  else
    fail "$label：基线不绿（$failed 个用例失败 / 套件没跑起来）—— 红绿就没有意义"
    failed_test_names "$report" | sed 's/^/        - /' >&2
    suite_not_run "$report" | sed 's/^/        (没跑起来) /' >&2
  fi
}

REPORT_DIR="$(mktemp -d /tmp/invalidation-bus-selftest.XXXXXX)"

echo "=== 失效总线 · 负向验证门禁 ==="
echo "实现文件：$SVC"
echo

# ---------------------------------------------------------------------------
# 第 1 步：基线必须绿。
# ---------------------------------------------------------------------------
echo "[1/4] 基线（不改代码）必须全绿"
run_suite "invalidation-bus" "$REPORT_DIR/baseline.json"
BASE_STATUS=$?
if [ "$BASE_STATUS" -ne 0 ] && [ ! -f "$REPORT_DIR/baseline.json" ]; then
  fail "基线套件没跑起来（退出码 $BASE_STATUS）"
  sed 's/^/    /' /tmp/invalidation-bus-selftest.log | tail -40 >&2
else
  assert_green "$REPORT_DIR/baseline.json" "基线"
fi

# 元自检：同一个「判定变红」的函数，用**基线（绿）**的报告去跑，
# 必须判「**没有**失败」—— 否则说明这个判定恒真，门禁就是个摆设。
# ⚠️ 这正是「校验器恒过」这一类缺陷的通用防线（见 docs/KNOWN-ISSUES.md #43 / #44）。
if [ -f "$REPORT_DIR/baseline.json" ]; then
  if failed_test_names "$REPORT_DIR/baseline.json" | grep -qF -- '实例 A 降权'; then
    fail "元自检：基线（应当全绿）里出现了失败用例 —— 报告解析可能写坏了"
  else
    pass "元自检：同一个判定函数对绿报告判「未失败」（不是恒真）"
  fi
fi
echo

# ---------------------------------------------------------------------------
# 第 2~4 步：三种退化形态，每一种都必须被用例抓到。
#
# 每种形态守的用例不同（这是「三种形态各有分工」的原因）：
#   A 永不订阅 → 跨实例立刻失效那条（订阅端形同虚设）
#   B 永不发布 → 同上（发布端形同虚设）+ 「总线上只有失效事件」那条
#   C 发布抛错 → 降级路径那条（Redis 不可用时写操作仍 200、不抛错）
# ---------------------------------------------------------------------------
CROSS_INSTANCE_RBAC='实例 A 降权 → 实例 B 的缓存**立刻**失效（不等 TTL）'
CROSS_INSTANCE_DICT='实例 A 改分类 → 实例 B 的分类缓存**立刻**失效（不等 TTL）'
EVENT_ONLY_RBAC='总线上只有**失效事件**，没有任何权限内容'
DEGRADED_RBAC='总线不可用：写操作**仍 200**，撤权延迟回落到 TTL 上界（**不是永久放行**）'

check_variant () {
  local variant="$1"
  shift
  echo "[变异] $variant"
  if ! apply_variant "$variant"; then
    fail "$variant：变异没生效"
    cp "$BACKUP" "$SVC"
    echo
    return
  fi
  run_suite "invalidation-bus" "$REPORT_DIR/$variant.json"
  local status=$?
  if [ ! -f "$REPORT_DIR/$variant.json" ]; then
    fail "$variant：套件没跑起来（退出码 $status）"
    sed 's/^/    /' /tmp/invalidation-bus-selftest.log | tail -40 >&2
  else
    local broken
    broken="$(suite_not_run "$REPORT_DIR/$variant.json")"
    if [ -n "$broken" ]; then
      fail "$variant：套件**没跑起来**（编译错误 / beforeAll 抛错）—— 这不是证据"
      echo "$broken" | sed 's/^/          - /' >&2
      sed 's/^/    /' /tmp/invalidation-bus-selftest.log | tail -20 >&2
    else
      local failed
      failed="$(failed_test_names "$REPORT_DIR/$variant.json" | grep -c . || true)"
      if [ "$failed" -eq 0 ]; then
        fail "$variant：改坏之后用例**仍然全绿** —— 这一条退化形态**没有用例守着**"
      else
        pass "$variant：有 $failed 个用例变红"
      fi
    fi
    for needle in "$@"; do
      assert_failed "$REPORT_DIR/$variant.json" "$needle" "$variant"
    done
  fi
  cp "$BACKUP" "$SVC"
  echo
}

echo "[2/4] 退化形态 A：永不订阅"
check_variant "never-subscribe" "$CROSS_INSTANCE_RBAC" "$CROSS_INSTANCE_DICT"

echo "[3/4] 退化形态 B：永不发布"
check_variant "never-publish" "$CROSS_INSTANCE_RBAC" "$EVENT_ONLY_RBAC" "$CROSS_INSTANCE_DICT"

echo "[4/4] 退化形态 C：发布时抛错"
check_variant "publish-throws" "$DEGRADED_RBAC"

# ---------------------------------------------------------------------------
# 收尾：实现必须被还原成原样（否则工作区里会留一个改坏的实现）。
# ---------------------------------------------------------------------------
restore
CURRENT_SUM="$(sha256sum "$SVC" | cut -d' ' -f1)"
if [ "$CURRENT_SUM" != "$ORIGINAL_SUM" ]; then
  fail "总线实现没有被还原成原样（$SVC）—— 请检查 git status"
else
  pass "总线实现已还原（字节级一致）"
fi

rm -rf "$REPORT_DIR"

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "=== 负向验证门禁通过：基线绿 + 三种退化形态都被用例抓到 ==="
  exit 0
fi
echo "=== 负向验证门禁失败：$FAILURES 项 ===" >&2
exit 1
