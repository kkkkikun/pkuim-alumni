import { ensureDemoSession, isDemoFallbackActive, listArticles, listEvents, listNotices, onDemoModeChange } from '../../../services/index';
import type { ArticleDto, EventDto, NoticeDto } from '../../../types/index';
import { formatDate } from '../../../utils/format';
import { articleDetailUrl, eventDetailUrl, navigateTo, noticeDetailUrl, switchTab } from '../../../utils/navigate';
import { setTabBarSelected } from '../../../utils/tabbar';

type HomeTab = 'news' | 'events' | 'notices';

interface SpotCopy {
  tag: string;
  title: string;
  desc: string;
}

/** 演示模式状态订阅的取消函数（首页全局只有一个实例） */
let unsubscribeDemo: (() => void) | null = null;

const SPOT: Record<HomeTab, SpotCopy> = {
  news: {
    tag: '校友资讯',
    title: '以校友情谊为起点\n让连接持续发生',
    desc: '了解校友动态 · 一起建设北疆校友网络',
  },
  events: {
    tag: '活动预告',
    title: '从一次相聚开始\n让更多校友相识',
    desc: '联谊交流 · 企业参访 · 行业分享',
  },
  notices: {
    tag: '通知公告',
    title: '校友会服务资讯\n将在这里集中发布',
    desc: '重要通知 · 组织动态 · 服务提醒',
  },
};

Page({
  data: {
    tab: 'news' as HomeTab,
    loading: true,
    error: '',
    articles: [] as ArticleDto[],
    events: [] as EventDto[],
    notices: [] as NoticeDto[],
    spot: SPOT.news,
    /** 是否处于演示数据模式（未连接后端） */
    demoMode: false,
  },

  onLoad(): void {
    // 演示模式：先本地建一个会话（不发网络请求），让客户当场看到完整界面
    ensureDemoSession();
    this.syncDemoMode();
    if (!unsubscribeDemo) {
      unsubscribeDemo = onDemoModeChange(() => this.syncDemoMode());
    }
    void this.loadTab('news');
  },

  onUnload(): void {
    if (unsubscribeDemo) {
      unsubscribeDemo();
      unsubscribeDemo = null;
    }
  },

  onShow(): void {
    setTabBarSelected(0);
  },

  onPullDownRefresh(): void {
    void this.loadTab(this.data.tab).then(() => {
      wx.stopPullDownRefresh();
    });
  },

  /** 按标签加载对应内容 */
  async loadTab(tab: HomeTab): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      if (tab === 'news') {
        const result = await listArticles({ page: 1, pageSize: 5 });
        this.setData({ articles: result.items || [], spot: SPOT.news });
      } else if (tab === 'events') {
        const result = await listEvents({ page: 1, pageSize: 5 });
        this.setData({ events: result.items || [], spot: SPOT.events });
      } else {
        const result = await listNotices({ page: 1, pageSize: 5 });
        this.setData({ notices: result.items || [], spot: SPOT.notices });
      }
      this.setData({ loading: false });
    } catch (error) {
      this.setData({ loading: false, error: '内容加载失败，请稍后重试' });
    }
  },

  onTabChange(event: WechatMiniprogram.BaseEvent): void {
    const tab = (event.currentTarget.dataset.tab as HomeTab) || 'news';
    if (tab === this.data.tab) {
      return;
    }
    this.setData({ tab });
    void this.loadTab(tab);
  },

  onArticleTap(event: WechatMiniprogram.CustomEvent<{ article: ArticleDto }>): void {
    navigateTo(articleDetailUrl(event.detail.article.id));
  },

  onEventTap(event: WechatMiniprogram.CustomEvent<{ event: EventDto }>): void {
    navigateTo(eventDetailUrl(event.detail.event.id));
  },

  onNoticeTap(event: WechatMiniprogram.CustomEvent<{ notice: NoticeDto }>): void {
    navigateTo(noticeDetailUrl(event.detail.notice.id));
  },

  onSpotTap(): void {
    if (this.data.tab === 'events') {
      navigateTo('/pages/home/event-list/index');
    } else if (this.data.tab === 'notices') {
      navigateTo('/pages/home/notice-list/index');
    } else {
      navigateTo('/pages/home/article-list/index');
    }
  },

  onMoreTap(): void {
    if (this.data.tab === 'events') {
      navigateTo('/pages/home/event-list/index');
    } else if (this.data.tab === 'notices') {
      navigateTo('/pages/home/notice-list/index');
    } else {
      navigateTo('/pages/home/article-list/index');
    }
  },

  onShortcutTap(event: WechatMiniprogram.BaseEvent): void {
    const action = event.currentTarget.dataset.action as string;
    if (action === 'directory') {
      switchTab('/pages/directory/index/index');
    } else if (action === 'connect') {
      switchTab('/pages/connect/index/index');
    } else if (action === 'events') {
      this.setData({ tab: 'events' });
      void this.loadTab('events');
      wx.pageScrollTo({ scrollTop: 0, duration: 200 });
    } else {
      navigateTo('/pages/home/about/index');
    }
  },

  /** 供 WXML 使用：公告日期格式化 */
  formatNoticeDate(value: string): string {
    return formatDate(value);
  },

  /** 同步演示模式状态（提示条显示 / 隐藏） */
  syncDemoMode(): void {
    const demoMode = isDemoFallbackActive();
    if (demoMode !== this.data.demoMode) {
      this.setData({ demoMode });
    }
  },

  /** 点击演示提示条：说明当前数据来源 */
  onDemoTipTap(): void {
    wx.showToast({
      title: '当前为离线演示数据，后端恢复后自动切回真实数据',
      icon: 'none',
      duration: 2500,
    });
  },
});
