Page({
  data: {
    steps: [
      { title: '填写资料', desc: '填写姓名、院系、毕业年份等基本信息' },
      { title: '上传证明', desc: '上传学信、毕业证等可核验的材料' },
      { title: '等待审核', desc: '校友会人工审核，结果会通过通知告知' },
    ],
  },

  onStartTap(): void {
    wx.navigateTo({ url: '/pages/me/verify-form/index' });
  },

  onProgressTap(): void {
    wx.navigateTo({ url: '/pages/me/verify-progress/index' });
  },
});
