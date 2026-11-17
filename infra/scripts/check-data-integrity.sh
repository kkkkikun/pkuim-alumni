#!/usr/bin/env bash
# =============================================================================
# NMG-PKU-Alumni —— 数据完整性校验
#
#   bash infra/scripts/check-data-integrity.sh
#   bash infra/scripts/check-data-integrity.sh --db nmg_alumni_test
#
# 目的：把「设计文档里写死的约束」变成**可执行的检查**。当前校验体系覆盖了
#       契约 / 路径 / 需求 / 文档，但**数据库里存的数据本身**是否满足设计约束，
#       此前全靠人工抽查。本脚本覆盖四类硬约束：
#
#   A. 字典外键：region_code / industry_code 必须存在于字典表
#   B. 隐私存储：联系方式只能以密文存在（不得出现明文手机号 / 邮箱 / 微信号）
#   C. 状态机自洽：用户认证阶段、资源审核状态必须与对应流程记录一致
#   D. 唯一性与时间戳：openid 唯一、进行中的认证申请唯一、updated_at >= created_at
#
# 安全约束：
#   1) **只读**：脚本只执行 SELECT，不含任何写操作；
#   2) 默认检查业务库，也可用 --db 指定测试库做反向验证；
#   3) 每次输出每项违规数，非 0 即失败（退出码 1）。
# =============================================================================

set -euo pipefail
# shellcheck source=./common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

DB_NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --db) DB_NAME="${2:-}"; [ -n "$DB_NAME" ] || die "--db 需要一个值"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done
[ -n "$DB_NAME" ] || DB_NAME="$(env_get_or MYSQL_DATABASE nmg_alumni)"

require_cmd docker

log "=== 数据完整性校验（库=${DB_NAME}，只读）==="

# 校验 SQL：每一行给出「检查项 → 违规行数」，全部应为 0
read -r -d '' CHECK_SQL <<'SQL' || true
SELECT 'A1 profiles.region_code 不在字典表', COUNT(*) FROM alumni_profiles p WHERE p.region_code IS NOT NULL AND p.region_code <> '' AND NOT EXISTS (SELECT 1 FROM regions r WHERE r.code = p.region_code)
UNION ALL SELECT 'A2 profiles.industry_code 不在字典表', COUNT(*) FROM alumni_profiles p WHERE p.industry_code IS NOT NULL AND p.industry_code <> '' AND NOT EXISTS (SELECT 1 FROM industries i WHERE i.code = p.industry_code)
UNION ALL SELECT 'A3 resources.region_code 不在字典表', COUNT(*) FROM resource_posts r WHERE r.region_code IS NOT NULL AND r.region_code <> '' AND NOT EXISTS (SELECT 1 FROM regions g WHERE g.code = r.region_code)
UNION ALL SELECT 'A4 resources.industry_code 不在字典表', COUNT(*) FROM resource_posts r WHERE r.industry_code IS NOT NULL AND r.industry_code <> '' AND NOT EXISTS (SELECT 1 FROM industries i WHERE i.code = r.industry_code)
UNION ALL SELECT 'A5 events.region_code 不在字典表', COUNT(*) FROM events e WHERE e.region_code IS NOT NULL AND e.region_code <> '' AND NOT EXISTS (SELECT 1 FROM regions r WHERE r.code = e.region_code)
UNION ALL SELECT 'B1 私密切域出现明文手机号', COUNT(*) FROM private_contacts WHERE phone_cipher REGEXP '^[0-9]{7,15}$'
UNION ALL SELECT 'B2 私密切域出现明文邮箱', COUNT(*) FROM private_contacts WHERE email_cipher LIKE '%@%'
UNION ALL SELECT 'B3 私密切域出现明文微信号', COUNT(*) FROM private_contacts WHERE wechat_cipher REGEXP '^[A-Za-z][A-Za-z0-9_-]{5,19}$'
UNION ALL SELECT 'B4 密文非合法 base64', COUNT(*) FROM private_contacts WHERE (phone_cipher IS NOT NULL AND phone_cipher NOT REGEXP '^[A-Za-z0-9+/]+={0,2}$') OR (email_cipher IS NOT NULL AND email_cipher NOT REGEXP '^[A-Za-z0-9+/]+={0,2}$') OR (wechat_cipher IS NOT NULL AND wechat_cipher NOT REGEXP '^[A-Za-z0-9+/]+={0,2}$')
UNION ALL SELECT 'B5 密文长度不足（IV+AuthTag 至少 28 字节）', COUNT(*) FROM private_contacts WHERE (phone_cipher IS NOT NULL AND LENGTH(phone_cipher) < 40) OR (email_cipher IS NOT NULL AND LENGTH(email_cipher) < 40) OR (wechat_cipher IS NOT NULL AND LENGTH(wechat_cipher) < 40)
UNION ALL SELECT 'C1 stage=verified 但无通过认证记录', COUNT(*) FROM users u WHERE u.stage = 'verified' AND NOT EXISTS (SELECT 1 FROM verification_applications a WHERE a.user_id = u.id AND a.status = 'approved')
UNION ALL SELECT 'C2 stage=pending_review 但无在途认证记录', COUNT(*) FROM users u WHERE u.stage = 'pending_review' AND NOT EXISTS (SELECT 1 FROM verification_applications a WHERE a.user_id = u.id AND a.status IN ('pending','resubmitted'))
UNION ALL SELECT 'C3 同一用户存在多条在途认证申请', COUNT(*) FROM (SELECT user_id FROM verification_applications WHERE status IN ('pending','resubmitted') GROUP BY user_id HAVING COUNT(*) > 1) t
UNION ALL SELECT 'C4 资源已发布但无通过审核记录', COUNT(*) FROM resource_posts rp WHERE rp.status = 'published' AND NOT EXISTS (SELECT 1 FROM resource_post_reviews r WHERE r.post_id = rp.id AND r.action = 'approve')
UNION ALL SELECT 'C5 资源状态为 pending 但已有通过审核记录', COUNT(*) FROM resource_posts rp WHERE rp.status = 'pending' AND EXISTS (SELECT 1 FROM resource_post_reviews r WHERE r.post_id = rp.id AND r.action = 'approve')
UNION ALL SELECT 'C6 报名记录指向不存在的活动', COUNT(*) FROM event_registrations er WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = er.event_id)
UNION ALL SELECT 'C7 连接对成员不存在', COUNT(*) FROM connection_pairs cp WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = cp.user_a_id) OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = cp.user_b_id)
UNION ALL SELECT 'C8 活动已报名计数与实际报名记录数不一致', COUNT(*) FROM events e WHERE e.registered_count <> (SELECT COUNT(*) FROM event_registrations er WHERE er.event_id = e.id AND er.status = 'registered')
UNION ALL SELECT 'C9 活动人数上限小于当前已报名人数', COUNT(*) FROM events e WHERE e.capacity > 0 AND e.capacity < e.registered_count
UNION ALL SELECT 'E1 profile.verified=1 但用户 stage 非 verified', COUNT(*) FROM alumni_profiles p JOIN users u ON u.id = p.user_id WHERE p.verified = 1 AND u.stage <> 'verified'
UNION ALL SELECT 'E2 用户 stage=verified 但 profile.verified 不为 1', COUNT(*) FROM alumni_profiles p JOIN users u ON u.id = p.user_id WHERE u.stage = 'verified' AND p.verified <> 1
UNION ALL SELECT 'E3 有通过认证记录但用户 stage 非 verified', COUNT(*) FROM verification_applications a JOIN users u ON u.id = a.user_id WHERE a.status = 'approved' AND u.stage <> 'verified'
UNION ALL SELECT 'E4 有在途认证记录但用户 stage 非 pending_review', COUNT(*) FROM verification_applications a JOIN users u ON u.id = a.user_id WHERE a.status IN ('pending','resubmitted') AND u.stage <> 'pending_review'
UNION ALL SELECT 'E5 已认证用户仍存在在途认证申请', COUNT(*) FROM verification_applications a JOIN users u ON u.id = a.user_id WHERE a.status IN ('pending','resubmitted') AND u.stage = 'verified'
UNION ALL SELECT 'E6 审核通过记录缺失（approved 申请无 approve 审核）', COUNT(*) FROM verification_applications a WHERE a.status = 'approved' AND NOT EXISTS (SELECT 1 FROM verification_reviews r WHERE r.application_id = a.id AND r.action = 'approve')
UNION ALL SELECT 'D1 openid 重复', COUNT(*) FROM (SELECT openid FROM users GROUP BY openid HAVING COUNT(*) > 1) t
UNION ALL SELECT 'D2 updated_at 早于 created_at', COUNT(*) FROM users WHERE updated_at < created_at
UNION ALL SELECT 'D3 用户缺少校友档案', COUNT(*) FROM users u WHERE NOT EXISTS (SELECT 1 FROM alumni_profiles p WHERE p.user_id = u.id)
UNION ALL SELECT 'D4 校友档案没有对应用户', COUNT(*) FROM alumni_profiles p WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p.user_id)
UNION ALL SELECT 'F1 存在 region_code 列但无 regions 外键的表', COUNT(*) FROM (SELECT c.TABLE_NAME FROM information_schema.COLUMNS c WHERE c.TABLE_SCHEMA = DATABASE() AND c.COLUMN_NAME = 'region_code' AND NOT EXISTS (SELECT 1 FROM information_schema.KEY_COLUMN_USAGE k WHERE k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME AND k.COLUMN_NAME = c.COLUMN_NAME AND k.REFERENCED_TABLE_NAME = 'regions')) t
UNION ALL SELECT 'F2 存在 industry_code 列但无 industries 外键的表', COUNT(*) FROM (SELECT c.TABLE_NAME FROM information_schema.COLUMNS c WHERE c.TABLE_SCHEMA = DATABASE() AND c.COLUMN_NAME = 'industry_code' AND NOT EXISTS (SELECT 1 FROM information_schema.KEY_COLUMN_USAGE k WHERE k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME AND k.COLUMN_NAME = c.COLUMN_NAME AND k.REFERENCED_TABLE_NAME = 'industries')) t
UNION ALL SELECT 'F3 存在 user_id 列但无 users 外键的表', COUNT(*) FROM (SELECT c.TABLE_NAME FROM information_schema.COLUMNS c WHERE c.TABLE_SCHEMA = DATABASE() AND c.COLUMN_NAME = 'user_id' AND NOT EXISTS (SELECT 1 FROM information_schema.KEY_COLUMN_USAGE k WHERE k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME AND k.COLUMN_NAME = c.COLUMN_NAME AND k.REFERENCED_TABLE_NAME = 'users')) t
SQL

# SQL 通过 stdin 传给容器内的 mysql，避开多层 shell 对引号与反引号的解析
RESULT="$(printf '%s\n' "$CHECK_SQL" \
  | compose exec -T mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -B "$1"' sh "$DB_NAME" 2>&1 \
  | grep -v 'Using a password on the command line' || true)"

if printf '%s' "$RESULT" | grep -q 'ERROR'; then
  warn "校验 SQL 执行失败："
  printf '%s\n' "$RESULT" | head -5 | sed 's/^/  /'
  die "数据完整性校验无法执行"
fi

FAILED=0
COUNT=0
while IFS=$'\t' read -r label value; do
  [ -n "$label" ] || continue
  COUNT=$((COUNT + 1))
  if [ "$value" = "0" ]; then
    log "  ✓ ${label}：0"
  else
    warn "  ✗ ${label}：${value} 条违规"
    FAILED=1
  fi
done <<<"$RESULT"

log "共检查 ${COUNT} 项"

if [ "$FAILED" -ne 0 ]; then
  die "数据完整性校验失败：存在违规数据"
fi

log "=== 数据完整性校验通过 ✅（${COUNT} 项全部为 0 违规）==="
