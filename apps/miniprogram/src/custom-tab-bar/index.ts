Component({
  data: {
    selected: 0,
    list: [
      { pagePath: '/pages/home/index/index', text: '首页', icon: 'home' },
      { pagePath: '/pages/directory/index/index', text: '通讯录', icon: 'users' },
      { pagePath: '/pages/connect/index/index', text: '连接', icon: 'connect' },
      { pagePath: '/pages/me/index/index', text: '我的', icon: 'person' },
    ],
  },
  methods: {
    onTap(event: WechatMiniprogram.BaseEvent): void {
      const dataset = event.currentTarget.dataset as { path?: string; index?: number };
      const path = dataset.path;
      const index = dataset.index;
      if (!path || typeof index !== 'number') {
        return;
      }
      wx.switchTab({ url: path });
      this.setData({ selected: index });
    },
  },
});
