import { Transform } from 'class-transformer';

/**
 * DTO 通用转换器。
 *
 * 背景（缺陷 #82）：
 *   `ValidationPipe` 原本开着 `enableImplicitConversion`，
 *   class-transformer 会按属性的 `design:type` **隐式强转**：
 *     - 布尔：字符串 `'false'` / `'0'` 会被转成 **true**（`!!value` 语义）——
 *       后台「认证状态 = 未认证」筛选因此返回的是**已认证**名单；
 *     - 字符串：对象 `{}` 会被转成 `"[object Object]"` —— 畸形输入直接进库；
 *     - 数组：对象 `{ nope: true }` 会被转成**空数组** —— 畸形输入被当成「清空附件」。
 *
 *   现在全局关闭隐式转换（见 `common/pipes/validation.pipe.ts`），
 *   需要转换的地方一律**显式**声明：
 *     - 数字 → `@Type(() => Number)`
 *     - 布尔 → `@ToBoolean()`（本文件）
 */

/**
 * 把 `'true' / '1'` → true，`'false' / '0'` → false。
 *
 * 用于**查询参数**（HTTP 里只能传字符串）与宽松的请求体：
 * 关闭隐式转换后，原始字符串会原样到达 DTO，这里显式映射。
 *
 * ⚠️ 绝不能用 `@Type(() => Boolean)` 代替 ——
 *    class-transformer 的布尔转换是 `!!value` 语义，
 *    `'false'` 会被转成 **true**（实测确认）。
 */
export function ToBoolean(): PropertyDecorator {
  return Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  });
}
