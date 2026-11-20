import { listConnections } from '../../../services/index';
import type { ConnectionPairDto } from '../../../types/index';
import { navigateTo } from '../../../utils/navigate';
import { restorePageScroll, trackPageScroll } from '../../../utils/scroll';
import { shouldRefreshOnShow } from '../../../utils/first-show';

interface ConnectionView extends ConnectionPairDto {
  peerMeta: string;
  peerInitial: string;
  shareState: string;
  peerContactVisible: boolean;
  peerPhone: string;
  peerWechat: string;
  peerEmail: string;
}

function toView(pair: ConnectionPairDto): ConnectionView {
  const meta = [pair.peerCollege, pair.peerRegionName, pair.peerIndustryName]
    .filter((item): item is string => !!item)
    .join(' · ');
  const contact = pair.peerContact;
  return {
    ...pair,
    peerMeta: meta || '校友',
    peerInitial: pair.peerName ? pair.peerName.charAt(0) : '燕',
    shareState: pair.myContactShared
      ? pair.peerContactShared
        ? '双方已共享联系方式'
        : '你已共享，等待对方授权'
      : '你尚未共享联系方式',
    peerContactVisible: !!contact,
    peerPhone: contact && contact.phone ? contact.phone : '',
    peerWechat: contact && contact.wechat ? contact.wechat : '',
    peerEmail: contact && contact.email ? contact.email : '',
  };
}

Page({
  data: {
    loading: true,
    error: '',
    items: [] as ConnectionView[],
  },

  onLoad(): void {
    void this.load();
  },

  onShow(): void {
    // 首次进入时 onLoad 已经加载过，这里不再重复发请求；返回本页时才刷新。
    if (shouldRefreshOnShow(this)) {
      void this.load();
    }
    restorePageScroll('me-connections');
  },

  onPageScroll: trackPageScroll('me-connections'),

  onPullDownRefresh(): void {
    void this.load().then(() => {
      wx.stopPullDownRefresh();
    });
  },

  async load(): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      const result = await listConnections({ page: 1, pageSize: 50 });
      this.setData({ items: (result.items || []).map(toView), loading: false });
    } catch (error) {
      this.setData({ loading: false, error: '连接记录加载失败，请稍后重试' });
    }
  },

  onRetry(): void {
    void this.load();
  },

  onItemTap(event: WechatMiniprogram.BaseEvent): void {
    const id = Number(event.currentTarget.dataset.id);
    navigateTo(`/pages/me/contact-share/index?id=${id}`);
  },
});
