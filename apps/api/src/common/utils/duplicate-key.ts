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
