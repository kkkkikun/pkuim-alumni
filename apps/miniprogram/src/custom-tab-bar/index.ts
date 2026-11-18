Component({
  data: {
    selected: 0,
    list: [
      {
        pagePath: '/pages/home/index/index',
        text: '首页',
        icon: '/assets/icons/home.png',
        iconActive: '/assets/icons/home-active.png',
      },
      {
        pagePath: '/pages/directory/index/index',
        text: '通讯录',
        icon: '/assets/icons/users.png',
        iconActive: '/assets/icons/users-active.png',
      },
      {
        pagePath: '/pages/connect/index/index',
        text: '连接',
        icon: '/assets/icons/connect.png',
        iconActive: '/assets/icons/connect-active.png',
      },
      {
        pagePath: '/pages/me/index/index',
        text: '我的',
        icon: '/assets/icons/person.png',
        iconActive: '/assets/icons/person-active.png',
      },
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
