import { QueryFailedError } from 'typeorm';

/**
 * 判断一个错误是不是 **MySQL 唯一键冲突**（`ER_DUP_ENTRY` / 1062）。
 *
 * 用途：**并发写同一行**时的兜底判断 ——
 * 「先查后插」在并发下必然有一个撞唯一键，
 * 这时正确的处置是**重试整个写**（而不是甩 500 给用户）。
 *
 * ⚠️ 为什么单独放在 `common/utils`：
 *   控制器（`admin-users.controller.ts`）也需要它 ——
 *   重试必须发生在**事务的外面**（整个事务回滚重来），
 *   而服务层在事务内部无法做到这一点。
 */
export function isDuplicateKeyError(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    // 有些路径抛的是 driver 的原始错误对象（不带 QueryFailedError 外壳）
    const driverError = (error as { driverError?: { code?: string; errno?: number } } | null)
      ?.driverError;
    const code = driverError?.code ?? (error as { code?: string } | null)?.code;
    const errno = driverError?.errno ?? (error as { errno?: number } | null)?.errno;
    return code === 'ER_DUP_ENTRY' || errno === 1062;
  }
  const driverError = error.driverError as { code?: string; errno?: number } | undefined;
  return driverError?.code === 'ER_DUP_ENTRY' || driverError?.errno === 1062;
}

/**
 * 取出这次唯一键冲突命中的**索引名**（如 `uk_users_unionid`）。
 *
 * 为什么需要它：
 *   「撞键了」这件事本身有**多种含义** —— 并发首登（重试一次即可）、
 *   同一 unionid 绑了两个账号（业务冲突，必须 409）、
 *   重复报名（409）… 处置方式**因键而异**，只有一个笼统的
 *   `isDuplicateKeyError` 分不出「撞的是哪把钥匙」。
 *
 *   MySQL 的报错文本里带着索引名：
 *     `Duplicate entry 'x' for key 'users.uk_users_unionid'`
 *   我们把它取出来，业务层才能**按键**给出可预期的错误码，
 *   而不是把数据库异常原样抛成 500。
 *
 * ⚠️ 取不到索引名时返回 `null`（例如驱动没带这段文本）：
 *   调用方必须按「不知道是哪把钥匙」兜底（可预期错误码），
 *   **不得**把原始异常直接抛出去。
 */
export function duplicateKeyName(error: unknown): string | null {
  const candidates: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value) candidates.push(value);
  };
  const driverError = (error as { driverError?: Record<string, unknown> } | null)?.driverError;
  if (driverError) {
    push(driverError.sqlMessage);
    push(driverError.sql);
    push(driverError.message);
  }
  push((error as { message?: unknown } | null)?.message);
  for (const text of candidates) {
    const matched = /for key '([^']+)'/i.exec(text);
    if (matched?.[1]) {
      // 形如 `users.uk_users_unionid` → 只取最后一段（索引名本身）
      const parts = matched[1].split('.');
      return parts[parts.length - 1];
    }
  }
  return null;
}
