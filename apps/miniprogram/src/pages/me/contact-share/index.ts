import { getConnection, grantContact } from '../../../services/index';
import type { ConnectionPairDto } from '../../../types/index';
import { showSuccess } from '../../../utils/feedback';

interface ConnectionView extends ConnectionPairDto {
  peerMeta: string;
  peerInitial: string;
  peerPhone: string;
  peerWechat: string;
  peerEmail: string;
}

Page({
  data: {
    loading: true,
    error: '',
    connection: null as ConnectionView | null,
    submitting: false,
    actionError: '',
  },

  onLoad(options: Record<string, string | undefined>): void {
    const id = Number(options.id);
    if (!Number.isFinite(id) || id <= 0) {
      this.setData({ loading: false, error: '参数错误' });
      return;
    }
    void this.load(id);
  },

  async load(id: number): Promise<void> {
    this.setData({ loading: true, error: '' });
    try {
      const pair = await getConnection(id);
      const meta = [pair.peerCollege, pair.peerRegionName, pair.peerIndustryName]
        .filter((item): item is string => !!item)
        .join(' · ');
      const contact = pair.peerContact;
      this.setData({
        connection: {
          ...pair,
          peerMeta: meta || '校友',
          peerInitial: pair.peerName ? pair.peerName.charAt(0) : '燕',
          peerPhone: contact && contact.phone ? contact.phone : '',
          peerWechat: contact && contact.wechat ? contact.wechat : '',
          peerEmail: contact && contact.email ? contact.email : '',
        },
        loading: false,
      });
    } catch (error) {
      this.setData({ loading: false, error: '连接信息加载失败，请稍后重试' });
    }
  },

  onRetry(): void {
    const connection = this.data.connection;
    void this.load(connection ? connection.id : 0);
  },

  async onToggleShare(event: WechatMiniprogram.SwitchChange): Promise<void> {
    const connection = this.data.connection;
    if (!connection || this.data.submitting) {
      return;
    }
    const allow = event.detail.value;
    this.setData({ submitting: true, actionError: '' });
    try {
      await grantContact(connection.id, allow);
      showSuccess(allow ? '已共享联系方式' : '已撤回共享');
      await this.load(connection.id);
    } catch (error) {
      this.setData({ actionError: '操作失败，请稍后重试' });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
