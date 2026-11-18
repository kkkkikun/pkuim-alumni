import {
  fetchMe,
  fetchUnreadCount,
  listMyConnectionRequests,
  listMyEvents,
  listMyResources,
} from '../../../services/index';
import { getState, isLoggedIn, stageLabel } from '../../../store/index';
import type { AlumniStage } from '../../../types/index';
import { ensureLogin } from '../../../utils/guard';
import { showToast } from '../../../utils/feedback';
import { navigateTo } from '../../../utils/navigate';
import { setTabBarSelected } from '../../../utils/tabbar';
import { settleAll } from '../../../utils/async';
import type { Settled } from '../../../utils/async';

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
    void this.loadCounts();
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
    const results = await settleAll([
      listMyEvents({ page: 1, pageSize: 1 }),
      listMyConnectionRequests({ page: 1, pageSize: 1 }),
      listMyResources({ page: 1, pageSize: 1 }),
      fetchUnreadCount(),
    ]);
    const total = (result: Settled<{ meta: { total: number } }>): number =>
      result.ok && result.value && result.value.meta ? result.value.meta.total : 0;
    const unread = (result: Settled<{ unread: number }>): number =>
      result.ok && result.value && typeof result.value.unread === 'number'
        ? result.value.unread
        : 0;
    this.setData({
      eventCount: total(results[0]),
      requestCount: total(results[1]),
      postCount: total(results[2]),
      unreadCount: unread(results[3]),
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
