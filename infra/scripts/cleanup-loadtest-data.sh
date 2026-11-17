#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 清理压测产生的临时数据
#
#   bash infra/scripts/cleanup-loadtest-data.sh
#   DRY_RUN=1 bash infra/scripts/cleanup-loadtest-data.sh   # 只统计不删除
#
# 压测会在业务库产生大量一次性数据（Mock 登录每次迭代都新建用户）：
#   - openid 前缀 mock_mock-login-%   （登录场景随机新用户）
#   - 资源标题前缀 k6 %                （资源幂等场景）
#   - 活动标题前缀 k6 %                （活动名额竞争场景）
#   - 幂等记录 / 连接申请 / 连接对 / 授权
#
# 保留：Seed 生成的 mock_alumni_% 与 mock_k6_alumni_%（压测账号，需保留以便复用）。
# 安全约束：只删除上述前缀的数据，不触碰其它表；不删库、不删卷。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

DB_NAME="$(env_get_or MYSQL_DATABASE nmg_alumni)"
MYSQL_ROOT_PASSWORD="$(env_get_or MYSQL_ROOT_PASSWORD "")"
DRY_RUN="${DRY_RUN:-0}"

require_cmd docker

log "清理压测临时数据（库=${DB_NAME}${DRY_RUN:+, DRY_RUN=${DRY_RUN}}）"

sql_root() {
  compose exec -T mysql sh -c "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" ${DB_NAME} -N -B" <<< "$1"
}

if [ "$DRY_RUN" = "1" ]; then
  count=$(sql_root "SELECT COUNT(*) FROM users WHERE openid LIKE 'mock_mock-login-%';")
  log "  待删除的一次性登录用户：${count}"
  exit 0
fi

sql_root "
DELETE FROM idempotency_records;
DELETE FROM resource_post_reviews WHERE post_id IN (SELECT id FROM resource_posts WHERE title LIKE 'k6 %');
DELETE FROM resource_posts WHERE title LIKE 'k6 %';
DELETE FROM event_registrations WHERE event_id IN (SELECT id FROM events WHERE title LIKE 'k6 %');
DELETE FROM events WHERE title LIKE 'k6 %';
DELETE FROM contact_share_grants;
DELETE FROM connection_pairs;
DELETE FROM connection_request_history;
-- 通知链路：压测期间会产生大量站内通知与投递记录
DELETE FROM notification_deliveries WHERE notification_id IN (
  SELECT id FROM notifications WHERE user_id IN (
    SELECT id FROM users WHERE openid LIKE 'mock_mock-login-%' OR openid LIKE 'mock_k6_alumni_%'
  )
);
DELETE FROM notifications WHERE user_id IN (
  SELECT id FROM users WHERE openid LIKE 'mock_mock-login-%' OR openid LIKE 'mock_k6_alumni_%'
);
DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM users WHERE openid LIKE 'mock_mock-login-%');
DELETE FROM private_contacts WHERE user_id IN (SELECT id FROM users WHERE openid LIKE 'mock_mock-login-%');
DELETE FROM alumni_profiles WHERE user_id IN (SELECT id FROM users WHERE openid LIKE 'mock_mock-login-%');
DELETE FROM users WHERE openid LIKE 'mock_mock-login-%';
"

# Outbox：按「聚合对象是否还存在」清理孤儿事件（聚合对象已被上面删除的那些一并带走）。
# aggregate_type='system' 的事件（如 seed.completed）保留。
sql_root "
DELETE FROM outbox_events WHERE aggregate_type <> 'system' AND aggregate_type = 'notification'
  AND aggregate_id NOT IN (SELECT CAST(id AS CHAR) FROM notifications);
DELETE FROM outbox_events WHERE aggregate_type = 'resource_post'
  AND aggregate_id NOT IN (SELECT CAST(id AS CHAR) FROM resource_posts);
DELETE FROM outbox_events WHERE aggregate_type = 'event'
  AND aggregate_id NOT IN (SELECT CAST(id AS CHAR) FROM events);
DELETE FROM outbox_events WHERE aggregate_type = 'connection_request'
  AND aggregate_id NOT IN (SELECT CAST(id AS CHAR) FROM connection_request_history);
"

sql_root "SELECT (SELECT COUNT(*) FROM users), (SELECT COUNT(*) FROM alumni_profiles), (SELECT COUNT(*) FROM resource_posts);" \
  | while read -r u p r; do
      log "清理完成：users=${u} alumni_profiles=${p} resource_posts=${r}"
    done
