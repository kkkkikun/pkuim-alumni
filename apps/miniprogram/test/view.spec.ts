/**
 * 展示模型层（utils/view.ts）的单元测试（缺陷 #154 的对照用例）。
 *
 * 这一层是「日期不显示 ISO 串」与「活动卡图标还原」之间的桥：
 *   WXML 不能调用 JS 函数 → 必须在 TS 里预计算展示字段；
 *   而预计算的口径一旦各页面各写一份，就会漂移。
 *
 * 所以这里锁住两件事：
 *   1) 每个映射函数都产出**格式化后**的字段，且不丢原 DTO 的任何字段；
 *   2) eventArt 的关键词判据顺序 —— 原型第二条演示数据
 *      「走进企业 · 产业交流开放日」同时含「产业」与「交流」，
 *      判据顺序反了就会落到 users 图标，与原型不符。
 */

import type { ArticleDto, ConnectionRequestDto, EventDto, NoticeDto, ResourcePostDto } from '../src/types/index';
import {
  eventArt,
  toArticleView,
  toEventView,
  toNoticeView,
  toOpportunityView,
  toRequestView,
} from '../src/utils/view';

function local(y: number, m: number, d: number, hh = 0, mm = 0): Date {
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

describe('toArticleView', () => {
  const article: ArticleDto = {
    id: 1,
    categoryId: 2,
    categoryName: '校友动态',
    title: '标题',
    summary: '摘要',
    body: '正文',
    coverMediaId: null,
    status: 'published',
    publishedAt: local(2026, 1, 8, 8, 0).toISOString(),
    viewCount: 161,
    createdAt: local(2026, 1, 7, 8, 0).toISOString(),
    updatedAt: local(2026, 1, 8, 8, 0).toISOString(),
  };

  it('产出格式化后的发布日期', () => {
    expect(toArticleView(article).dateText).toBe('2026-01-08');
  });

  it('不丢原 DTO 的任何字段', () => {
    const view = toArticleView(article);
    expect(view.id).toBe(1);
    expect(view.title).toBe('标题');
    expect(view.viewCount).toBe(161);
    expect(view.publishedAt).toBe(article.publishedAt);
  });

  it('未发布（publishedAt 为 null）时日期为空串', () => {
    expect(toArticleView({ ...article, publishedAt: null }).dateText).toBe('');
  });
});

describe('toNoticeView', () => {
  const notice: NoticeDto = {
    id: 9,
    title: '公告',
    body: '正文',
    status: 'published',
    publishedAt: local(2026, 2, 3, 8, 0).toISOString(),
    viewCount: 12,
    createdAt: local(2026, 2, 2, 8, 0).toISOString(),
  };

  it('产出格式化后的发布日期', () => {
    expect(toNoticeView(notice).dateText).toBe('2026-02-03');
  });
});

describe('toEventView', () => {
  const event: EventDto = {
    id: 3,
    title: '活动',
    kind: '校友活动',
    regionCode: '150100',
    regionName: '呼和浩特市',
    place: '地点待公布',
    description: null,
    startsAt: local(2026, 4, 9, 19, 30).toISOString(),
    endsAt: null,
    capacity: 100,
    registeredCount: 10,
    status: 'published',
    coverMediaId: null,
    myRegistration: null,
    createdAt: local(2026, 3, 1, 8, 0).toISOString(),
  };

  it('产出格式化后的日期与时间', () => {
    const view = toEventView(event);
    expect(view.dateText).toBe('2026-04-09');
    expect(view.timeText).toBe('2026-04-09 19:30');
  });

  it('未定开始时间时给出「时间待定」而不是空串', () => {
    expect(toEventView({ ...event, startsAt: null }).timeText).toBe('时间待定');
  });

  it('保留原 DTO 字段', () => {
    const view = toEventView(event);
    expect(view.id).toBe(3);
    expect(view.kind).toBe('校友活动');
    expect(view.registeredCount).toBe(10);
  });
});

describe('eventArt（活动卡图标与色调）', () => {
  it('「校友交流沙龙」→ users + 红', () => {
    expect(eventArt('北疆同行 · 校友交流沙龙')).toEqual({
      iconPath: '/assets/icons/event-users.png',
      tone: 'red',
    });
  });

  it('「走进企业 · 产业交流开放日」→ building + 橄榄', () => {
    // 注意：这条同时含「产业」与「交流」，判据顺序必须先看「企业/产业」，
    // 否则会落到 users，与原型不符。
    expect(eventArt('走进企业 · 产业交流开放日')).toEqual({
      iconPath: '/assets/icons/event-building-olive.png',
      tone: 'olive',
    });
  });

  it('「企业参访」→ building + 橄榄', () => {
    expect(eventArt('企业参访日').tone).toBe('olive');
  });

  it('无法归类时退回 calendar + 红', () => {
    expect(eventArt('随便什么活动')).toEqual({
      iconPath: '/assets/icons/event-calendar.png',
      tone: 'red',
    });
  });

  it('空 kind 也不会抛异常', () => {
    expect(eventArt('').iconPath).toBe('/assets/icons/event-calendar.png');
  });
});

describe('toOpportunityView', () => {
  const post: ResourcePostDto = {
    id: 5,
    authorId: 1,
    authorName: '校友',
    type: 'demand',
    title: '需求',
    body: '正文',
    industryCode: null,
    industryName: null,
    regionCode: null,
    regionName: '包头市',
    status: 'published',
    version: 1,
    attachments: [],
    reviews: [],
    publishedAt: local(2026, 5, 6, 8, 0).toISOString(),
    createdAt: local(2026, 5, 5, 8, 0).toISOString(),
    updatedAt: local(2026, 5, 6, 9, 0).toISOString(),
  };

  it('产出格式化后的发布与更新时间', () => {
    const view = toOpportunityView(post);
    expect(view.dateText).toBe('2026-05-06');
    expect(view.updateText).toBe('2026-05-06 09:00');
  });

  it('未发布时显示「待发布」', () => {
    expect(toOpportunityView({ ...post, publishedAt: null }).dateText).toBe('待发布');
  });
});

describe('toRequestView', () => {
  const request: ConnectionRequestDto = {
    id: 7,
    fromUserId: 1,
    toUserId: 2,
    fromName: '张三',
    toName: '李四',
    message: '你好',
    status: 'pending',
    createdAt: local(2026, 6, 7, 14, 0).toISOString(),
    decidedAt: null,
    pairId: null,
  };

  it('同时给出相对时间与绝对时间', () => {
    const view = toRequestView(request);
    expect(view.timeText).toBe('2026-06-07 14:00');
    expect(view.dateText).toMatch(/前$|^2026-06-07$/);
  });

  it('保留原 DTO 字段', () => {
    const view = toRequestView(request);
    expect(view.id).toBe(7);
    expect(view.fromName).toBe('张三');
    expect(view.status).toBe('pending');
  });
});
