# UI 设计系统（源自 HTML V1 原型）

> 唯一视觉基准：`prototype/html-v1/index.html`（原始 HTML 备份，未改动）。
> 小程序与管理后台必须继承同一套设计令牌，保证两端观感一致。

## 1. 色彩

| 令牌 | 值 | 用途 |
|---|---|---|
| `--red` | `#a51e28` | 主色：顶部栏选中态、主按钮、强调文字 |
| `--reddeep` | `#8e1621` | 深主色：渐变尾部、按下态 |
| `--redbright` | `#c53b42` | 亮主色：焦点描边、小标记 |
| `--pink` | `#f9e8e6` | 浅底：标签底色、分割区块 |
| `--peach` | `#f1c0ac` | 暖色点缀：下划线、装饰线 |
| `--sand` | `#ddbb9e` | 暖中性：插画描边 |
| `--bg` | `#f8f7f5` | 页面背景 |
| `--line` | `#efebe7` | 分割线 |
| `--ink` | `#262322` | 主文字 |
| `--text` | `#414044` | 正文 |
| `--muted` | `#918c8a` | 次要文字 |

渐变：首页 hero `linear-gradient(155deg,#b52832 0%,#a51e28 42%,#911a25 100%)`；
「我的」页 `linear-gradient(155deg,#ffe7e1,#fff5f1 66%,#fff)`；
重点位 `linear-gradient(123deg,#f8ece9,#fff9f6 72%)`。

## 2. 字体

- 标题（衬线）：`"Songti SC","STSong","SimSun",serif`，用于 hero 标题、栏目主标题、名片姓名。
- 正文（无衬线）：`-apple-system,"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif`。
- 字号梯度：11 / 12 / 13.5 / 14 / 15 / 17 / 19 / 25 px（原型取值）。
- 字重：常规 400，强调 600/650，标题 700/750。

## 3. 形状与阴影

- 圆角：标签 5–7px，条目 10–15px，卡片 18–27px，底部弹层顶部 23px，主按钮 11px。
- 阴影：`0 8px 18px #a51e2823`（主色卡片）、`0 3px 10px #6e46431d`（头像）、`0 -8px 30px #251b1b26`（弹层）。
- 描边：1px `var(--line)`；焦点态 `outline: 2px solid var(--redbright); outline-offset: 3px`。

## 4. 布局

- 顶部栏：高 56px；首页为红色（`home-top`），「我的」为浅粉（`me-top`），其余白色。
- 内容区：首页/我的用「上移圆角卡片」叠在 banner 之上（`margin-top:-26px / -30px; border-radius:26px 26px 0 0`）。
- 底部导航：4 等分，高 65px + 安全区；选中项主色 + 底部 6×3px 圆点标记。
- 列表分隔线：1px `#f1eeeb` / `#f0eded`。

## 5. 组件规范

| 组件 | 规范 |
|---|---|
| 主按钮 `.button-main` | 宽 100%，背景 `var(--red)`，白字 14px/700，圆角 11px，内边距 13px |
| 次按钮 `.button-soft` | 白底 + `1px #efd4cd` 描边，主色文字 13px |
| 列表条目 `.list-mini` | 6px 圆点 + 13px 标题 + 右侧「详情 ›」 |
| 校友条目 `.person` | 圆形头像（首字）+ 姓名 + 地区徽标 + 方向 + 年份·院系 |
| 资源条目 `.opportunity` | 类型标签（我能提供/我有需求）+ 行业分类 + 标题 + 描述 + 底部地区·作者 |
| 底部弹层 `.sheet` | 顶部 40×4px 手柄，标题 18px/750，右上 30px 圆形关闭按钮 |
| 空状态 `.empty` | 30px 图标 + 标题 + 说明 + 「清除筛选」次按钮 |
| 提示条 `.toast` | 底部居中，`#2f2929e8` 圆角 10px，12px 文案 |

## 6. 交互

- 页面切换：`.page-scroll > section { animation: appear .22s ease }`（淡入 + 5px 上移）。
- 简单确认用轻量弹窗；复杂详情与表单在正式小程序中作为**独立页面**（见 `docs/PAGE-STRUCTURE.md`）。
- 所有可点击元素需有按下态与焦点态；禁用态 `opacity:.55`。

## 7. 无障碍与本地化

- 正文对比度满足 WCAG AA；正文最小 11px，主要信息不小于 12px。
- 全部文案为简体中文，语气克制、正式、温暖（沿用原型措辞）。
- 深色模式暂不纳入 V1，但令牌集中管理，便于后续扩展。
