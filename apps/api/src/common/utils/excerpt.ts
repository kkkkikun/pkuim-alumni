/**
 * 列表响应的正文摘要长度。
 *
 * 背景（第三轮）：`GET /articles`、`GET /notices`、`GET /resources` 的列表响应
 * 此前带着**整篇正文**（`body` 列是 MEDIUMTEXT）。
 * `pageSize=100` 时单次响应可达**数十 MB** —— 一个列表接口把整库正文搬上了网络。
 *
 * 处置：列表响应里的 `body` 只保留**前 N 个字符**作为摘要，
 * 完整正文走详情接口（`GET /articles/:id` 等）。
 *
 * ⚠️ 为什么保留字段而不是从契约里删掉：
 *   1. 小程序「连接」页的资源卡片直接渲染 `post.body` 作描述；
 *      字段直接消失会让描述整块变空（可见的界面回退）。
 *   2. 契约里 `body` 是**必填**字段，删掉要连带改 DTO、镜像与两端客户端，
 *      收益远小于「截断」这一招。
 *   3. 契约与 docs/API-SPEC.md 都写明了「列表 = 摘要、详情 = 全文」，
 *      客户端按摘要渲染不会出错。
 *
 * ⚠️ **管理端的列表不截断**：管理端「资讯/公告编辑」弹窗直接把列表行里的
 *    `body` 回填进表单（`openEdit(row)`），截断会让管理员保存时
 *    **静默截断正文** —— 这是数据损坏，不是性能优化。
 *    管理端另有详情接口（`GET /admin/articles/:id` 等），但编辑弹窗当前
 *    不走它，所以管理端列表必须给全文。
 */
export const LIST_BODY_EXCERPT_LENGTH = 200;

/**
 * 截取正文摘要（列表响应用）。
 *
 * - 超长正文截到 {@link LIST_BODY_EXCERPT_LENGTH} 个字符并追加省略号；
 * - 短正文原样返回（不加省略号，避免把「这就是全文」也标成摘要）；
 * - `null` / `undefined` 安全。
 */
export function toBodyExcerpt(body: string | null | undefined): string {
  if (!body) return '';
  if (body.length <= LIST_BODY_EXCERPT_LENGTH) return body;
  return `${body.slice(0, LIST_BODY_EXCERPT_LENGTH)}…`;
}
