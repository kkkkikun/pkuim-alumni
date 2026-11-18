/**
 * 启动引导：恢复本地会话、预热字典、刷新身份状态。
 *
 * ⚠️ 这里**刻意不使用 async/await**（缺陷 #152）：
 *   微信的 TypeScript 编译器插件会把入口链上的 `async` 函数转成 generator，
 *   并生成
 *     require('@babel/runtime/helpers/regeneratorRuntime')
 *     require('@babel/runtime/helpers/asyncToGenerator')
 *   两条**包外依赖**。本项目**不做「构建 npm」**（没有任何 npm 运行时依赖），
 *   包里没有 `@babel/runtime` →
 *   真机上 `app.js → require('./bootstrap')` 直接抛 module not found →
 *   **整个应用起不来 → 白屏**（底栏文字还在，因为 tabBar 是框架级渲染的）。
 *
 *   改成 promise 链后不再生成 generator，也就不再需要那两个 helper。
 *   这条约束由**第 17 层校验**（miniprogram-compile-check.mjs 的 R5：
 *   产物里每条 require 都必须能在包内解析）持续守住 ——
 *   以后谁在这里写回 async，**上传会被直接拦下**，不会变成线上白屏。
 */

import { fetchMe } from './services/me';
import { preloadDictionaries } from './services/system';
import { getState, restoreSession } from './store/index';

export function bootstrap(): void {
  restoreSession();
  void preloadDictionaries();
  if (getState().token) {
    // 令牌失效时请求层会自行清理登录态，这里不阻塞启动
    void fetchMe().catch(() => undefined);
  }
}
