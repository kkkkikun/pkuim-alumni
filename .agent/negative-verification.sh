#!/usr/bin/env bash
# 负向验证（第六轮 · 复核第五轮产出）
#
# 把共享失效总线的实现改成三种**退化形态**，确认第五轮（与本轮）的用例**确实会红**：
#   A. 永不订阅（订阅端形同虚设）
#   B. 永不发布（发布端形同虚设）
#   C. 发布时抛错（总线故障变成 5xx）
#
# 每个形态跑两个套件：
#   rbac-invalidation-bus（第五轮） / dict-invalidation-bus（第六轮）
set -u
cd "$(dirname "$0")/.."

# ⚠️ 测试库连接**走环境变量**（不把口令写进仓库）：
#    DATABASE_URL / DB_* / REDIS_* 都可以覆盖；
#    缺省值与仓库自己的 compose 栈一致（`docker-compose.yml`：MySQL 13307 / Redis 16380）。
export DATABASE_URL="${DATABASE_URL:-mysql://${MYSQL_USER:-nmg}:${MYSQL_PASSWORD:-dev_app}@127.0.0.1:${MYSQL_PORT:-13307}/${MYSQL_DATABASE:-nmg_alumni_test}}"
export REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
export REDIS_PORT="${REDIS_PORT:-16380}"

SVC="apps/api/src/common/services/invalidation-bus.service.ts"
BACKUP="$(mktemp /tmp/invalidation-bus.service.ts.orig.XXXXXX)"
cp "$SVC" "$BACKUP"
# 退出时**一定**还原被临时改坏的总线实现（哪怕脚本中途失败）。
trap 'cp "$BACKUP" "$SVC"; rm -f "$BACKUP"' EXIT

run_suite () {
  local pattern="$1"
  pnpm --filter @nmg/api exec jest --config jest.config.js --runInBand \
    --testPathPattern="$pattern" 2>&1 | grep -E "^(Tests:|Test Suites:)|✓|✕" | sed 's/^/    /'
}

apply_variant () {
  cp "$BACKUP" "$SVC"
  python3 - "$1" <<'PY'
import sys
path = "apps/api/src/common/services/invalidation-bus.service.ts"
variant = sys.argv[1]
src = open(path, encoding="utf-8").read()

if variant == "never-subscribe":
    anchor = "  private async ensureSubscribed(): Promise<void> {\n    if (this.closed || !this.enabled || this.subscribed) return;\n"
    assert anchor in src
    src = src.replace(
        anchor,
        anchor + "    if (Date.now() > 0) return; // [负向验证] 永不订阅\n",
        1,
    )
elif variant == "never-publish":
    anchor = "  async publish(event: InvalidationEvent): Promise<boolean> {\n    if (!this.enabled || this.closed) return false;\n"
    assert anchor in src
    src = src.replace(
        anchor,
        anchor + "    if (Date.now() > 0) return false; // [负向验证] 永不发布\n",
        1,
    )
elif variant == "publish-throws":
    anchor = "      this.logger.warn(\n        `失效事件发布失败（${this.channel}）：${this.lastError}。` +"
    assert anchor in src
    idx = src.index(anchor)
    tail = src[idx:]
    assert "      return false;\n" in tail
    tail = tail.replace("      return false;\n", "      throw error; // [负向验证] 发布时抛错\n", 1)
    src = src[:idx] + tail
else:
    raise SystemExit("unknown variant")

open(path, "w", encoding="utf-8").write(src)
PY
}

for variant in never-subscribe never-publish publish-throws; do
  echo "==================== 退化形态：${variant} ===================="
  apply_variant "$variant"
  echo "  --- rbac-invalidation-bus（第五轮） ---"
  run_suite rbac-invalidation-bus
  echo "  --- dict-invalidation-bus（第六轮） ---"
  run_suite dict-invalidation-bus
  echo
done

cp "$BACKUP" "$SVC"
echo "已还原：$SVC"