import {
  fetchMe,
  fetchMeSummary,
} from '../../../services/index';
import { getState, isLoggedIn, stageLabel } from '../../../store/index';
import type { AlumniStage } from '../../../types/index';
import { ensureLogin } from '../../../utils/guard';
import { showToast } from '../../../utils/feedback';
import { navigateTo } from '../../../utils/navigate';
import { setTabBarSelected } from '../../../utils/tabbar';
import { settle } from '../../../utils/async';
import { toSummaryView } from '../../../utils/summary';
import { shouldRefreshOnShow } from '../../../utils/first-show';

Page({
  data: {
    loading: true,
    logged: false,
    displayName: '',
    stage: 'guest' as AlumniStage,
    stageText: '游客',
    verified: false,
    pending: false,
    eventCount: 0,
    requestCount: 0,
    postCount: 0,
    unreadCount: 0,
  },

  onLoad(): void {
    void this.load();
  },

  onShow(): void {
    setTabBarSelected(3);
    this.syncUser();
    // 首次进入时 onLoad 已经加载过（fetchMe + 计数），这里不再重复发请求；
    // 之后每次回到本页才刷新计数。
    if (shouldRefreshOnShow(this)) {
      void this.loadCounts();
    }
  },

  syncUser(): void {
    const state = getState();
    const logged = isLoggedIn();
    this.setData({
      logged,
      displayName: state.user ? state.user.nickname : '',
      stage: state.stage,
      stageText: stageLabel(state.stage),
      verified: state.stage === 'verified',
      pending: state.stage === 'pending_review',
    });
  },

  async load(): Promise<void> {
    this.setData({ loading: true });
    try {
      await fetchMe();
    } catch (error) {
      // 未登录或令牌失效时保持游客状态
    }
    this.syncUser();
    this.setData({ loading: false });
    void this.loadCounts();
  },

  async loadCounts(): Promise<void> {
    if (!isLoggedIn()) {
      this.setData({ eventCount: 0, requestCount: 0, postCount: 0, unreadCount: 0 });
      return;
    }
    // ⚠️ 第三轮：此前这里是 **4 个请求**（我的活动 / 联系申请 / 我的发布 / 未读数），
    //    每次都为了拿一个数字把整页数据查出来 —— 首屏因此要打 5 个请求。
    //    现在这四个数字由 `GET /me/summary` **一次**给出，首屏降到 2 个请求。
    const result = await settle(fetchMeSummary());
    // ⚠️ 用展示模型层做兜底：服务端少给一个字段时显示 0，而不是 `undefined`
    //    （`undefined` 参与 WXML 运算会得到 `NaN`）。
    const summary = toSummaryView(result.ok ? result.value : null);
    this.setData({
      eventCount: summary.eventCount,
      requestCount: summary.requestCount,
      postCount: summary.postCount,
      unreadCount: summary.unreadCount,
    });
  },

  async onLoginTap(): Promise<void> {
    const ok = await ensureLogin();
    if (ok) {
      showToast('登录成功');
      void this.load();
    }
  },

  onMenuTap(event: WechatMiniprogram.BaseEvent): void {
    const target = (event.currentTarget.dataset.target as string) || '';
    const routes: Record<string, string> = {
      profile: '/pages/me/profile/index',
      events: '/pages/me/my-events/index',
      requests: '/pages/me/sent-requests/index',
      connections: '/pages/me/connections/index',
      notifications: '/pages/me/notifications/index',
      posts: '/pages/me/my-posts/index',
      privacy: '/pages/me/privacy/index',
      about: '/pages/home/about/index',
      account: '/pages/me/account/index',
      verify: '/pages/me/verify-intro/index',
      progress: '/pages/me/verify-progress/index',
    };
    const route = routes[target];
    if (route) {
      navigateTo(route);
    }
  },
});
