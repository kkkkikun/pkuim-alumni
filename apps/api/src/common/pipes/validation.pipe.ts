import { ValidationPipe } from '@nestjs/common';

/**
 * 全局参数校验管道配置（应用与集成测试共用，避免行为漂移）。
 *
 * 关键点：transform 必须开启，且 DTO 必须使用**具名类**。
 * 若 `@Query()` 使用交叉类型（如 `PaginationQueryDto & { keyword?: string }`），
 * Nest 拿不到具体 metatype → class-transformer 不生效 → `page` 仍是字符串/undefined
 * → `skip(NaN)` → 列表接口 500。此类问题必须由本管道 + 契约路由测试共同守住。
 *
 * ⚠️ `enableImplicitConversion` **必须关闭**（缺陷 #82）：
 *   开启时 class-transformer 会按属性的 `design:type` 隐式强转，三种畸形输入都会
 *   被悄悄"修正"成合法值，反而绕过校验、甚至污染数据：
 *     - 布尔：字符串 `'false'` / `'0'` → **true**（`!!value` 语义）
 *       → 后台「认证状态 = 未认证」筛选返回的是**已认证**名单（线上实测复现）；
 *     - 字符串：对象 `{}` → `"[object Object]"` → 脏数据直接进库；
 *     - 数组：对象 `{ nope: true }` → **空数组** → 畸形输入被当成「清空附件」。
 *   需要转换的地方一律**显式**声明：
 *     - 数字 → `@Type(() => Number)`
 *     - 布尔 → `@ToBoolean()`（`common/dto/transforms.ts`）
 *       ⚠️ 不可用 `@Type(() => Boolean)`：它的转换是 `!!value` 语义，
 *          `'false'` 会被转成 true（实测确认）。
 */
export function buildValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: false,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
  });
}
