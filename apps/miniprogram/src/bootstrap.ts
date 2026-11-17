/**
 * 启动引导：恢复本地会话、预热字典、刷新身份状态。
 */

import { fetchMe } from './services/me';
import { preloadDictionaries } from './services/system';
import { getState, restoreSession } from './store';

export async function bootstrap(): Promise<void> {
  restoreSession();
  void preloadDictionaries();
  if (getState().token) {
    try {
      await fetchMe();
    } catch (error) {
      // 令牌失效时请求层会自行清理登录态，这里不阻塞启动
    }
  }
}
