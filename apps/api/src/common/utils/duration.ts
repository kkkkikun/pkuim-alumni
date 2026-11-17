/**
 * 统一的时长解析工具。
 *
 * 背景：`jsonwebtoken` 的 `expiresIn` 若传入字符串会走 `ms()` 语义（"900" 会被当成
 * 900 **毫秒**，导致 `exp === iat`，令牌事实上立即过期）。本项目所有 TTL 配置统一
 * 在此转换为「秒数」后再传给 jwt 签发，避免毫秒/秒歧义。
 *
 * 支持格式：
 *   - 纯数字（无单位）→ 秒，例如 "900" = 900 秒
 *   - 带单位后缀 s / m / h / d → 秒，例如 "2h" = 7200 秒
 */
export type DurationInput = string | number | undefined | null;

const DURATION_PATTERN = /^(\d+)\s*(s|m|h|d)?$/i;

export function parseDurationToSeconds(value: DurationInput, fallbackSeconds = 7200): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallbackSeconds;
  }
  if (typeof value !== 'string') return fallbackSeconds;

  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) return fallbackSeconds;

  const amount = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();
  switch (unit) {
    case 'm':
      return amount * 60;
    case 'h':
      return amount * 3600;
    case 'd':
      return amount * 86400;
    case 's':
    default:
      return amount;
  }
}
