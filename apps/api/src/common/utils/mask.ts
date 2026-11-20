/**
 * 学号脱敏。
 *
 * ⚠️ 缺口（本轮修复）：`docs/SECURITY.md` 第 3 节第 6 条承诺
 *    「学号脱敏存储（`student_id_masked`）」，但此前**服务端完全不脱敏** ——
 *    DTO 只校验「4~32 个字符的字符串」，客户端把**完整学号**提交上来，
 *    服务端原样落库，字段名写着 `masked` 却存着明文。
 *
 *    现在由**服务端**统一脱敏：无论客户端传什么，落库的都是脱敏后的值。
 *    保留首尾各 2 位（便于人工核对），中间一律用 `*` 代替。
 *
 *    ⚠️ 脱敏是**幂等**的：对已经是 `20*****67` 这样的值再脱敏，结果不变 ——
 *       因此重复提交不会把掩码越抹越多。
 */

/** 保留的首位字符数。 */
export const MASK_PREFIX_LENGTH = 2;

/** 保留的末位字符数。 */
export const MASK_SUFFIX_LENGTH = 2;

/**
 * 把学号脱敏。
 *
 * - 长度 > 4：保留首 2 位 + 末 2 位，中间全部替换为 `*`（长度不变）；
 * - 长度 ≤ 4：只保留末 1 位，其余替换为 `*`（短学号没有「首尾都露」的意义）；
 * - 空值：返回 null。
 */
export function maskStudentId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (trimmed.length <= MASK_SUFFIX_LENGTH) {
    return '*'.repeat(trimmed.length);
  }
  if (trimmed.length <= MASK_PREFIX_LENGTH + MASK_SUFFIX_LENGTH) {
    return '*'.repeat(trimmed.length - 1) + trimmed.slice(-1);
  }
  const head = trimmed.slice(0, MASK_PREFIX_LENGTH);
  const tail = trimmed.slice(-MASK_SUFFIX_LENGTH);
  const middle = '*'.repeat(trimmed.length - MASK_PREFIX_LENGTH - MASK_SUFFIX_LENGTH);
  return `${head}${middle}${tail}`;
}

/**
 * 判断一个值是否**已经**是脱敏形态（含 `*`）。
 *
 * 用于「关键字搜索学号」：只有当关键字看起来像**完整学号**时才需要按同样规则脱敏后匹配，
 * 否则（姓名片段、年份前缀等）按原样做前缀匹配。
 */
export function looksMasked(value: string): boolean {
  return value.includes('*');
}
