/**
 * 展示层格式化工具的单元测试（缺陷 #154 的对照用例）。
 *
 * 缺陷 #154 的表现之一：页面上直接显示 `2026-01-08T08:00:00.000Z`。
 * 根因是展示层没有格式化 —— 而格式化函数**早就存在**（utils/format.ts），
 * 只是一直没人调用。
 *
 * 所以这一组用例要守住的是：
 *   1) 格式化函数本身的行为（含空值、非法值、相对时间的各个分支）；
 *   2) **时区无关** —— 期望值不能写死成某个时区的结果，
 *      否则换个 TZ 就会红，而红的原因跟代码对不对毫无关系。
 */

import {
  avatarText,
  formatDate,
  formatDateTime,
  formatMonthDay,
  formatRelativeTime,
  maskName,
  maskPhone,
  truncate,
} from '../src/utils/format';

/** 构造本地时间，便于断言「昨天 HH:mm」这类与本地时钟相关的输出 */
function local(y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): Date {
  return new Date(y, m - 1, d, hh, mm, ss, 0);
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

describe('formatDate', () => {
  it('把 ISO 串格式化为 YYYY-MM-DD', () => {
    expect(formatDate('2026-01-08T08:00:00.000Z')).toBe('2026-01-08');
  });

  it('已经是 YYYY-MM-DD 的原样返回', () => {
    expect(formatDate('2026-01-08')).toBe('2026-01-08');
  });

  it('空值与非法值返回空串（而不是 "Invalid Date"）', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
    expect(formatDate('')).toBe('');
    expect(formatDate('不是日期')).toBe('');
  });
});

describe('formatDateTime', () => {
  it('格式化为 YYYY-MM-DD HH:mm', () => {
    const value = local(2026, 1, 8, 19, 30).toISOString();
    expect(formatDateTime(value)).toBe('2026-01-08 19:30');
  });

  it('空值与非法值返回空串', () => {
    expect(formatDateTime(null)).toBe('');
    expect(formatDateTime('x')).toBe('');
  });
});

describe('formatMonthDay', () => {
  it('格式化为 M月D日', () => {
    const value = local(2026, 1, 8, 9, 0).toISOString();
    expect(formatMonthDay(value)).toBe('1月8日');
  });
});

describe('formatRelativeTime', () => {
  const now = local(2026, 3, 10, 12, 0);

  it('1 分钟内显示「刚刚」', () => {
    expect(formatRelativeTime(local(2026, 3, 10, 11, 59, 30).toISOString(), now)).toBe('刚刚');
  });

  it('不足 1 小时显示「N分钟前」', () => {
    expect(formatRelativeTime(local(2026, 3, 10, 11, 30).toISOString(), now)).toBe('30分钟前');
  });

  it('不足 1 天显示「N小时前」', () => {
    expect(formatRelativeTime(local(2026, 3, 10, 6, 0).toISOString(), now)).toBe('6小时前');
  });

  it('昨天显示「昨天 HH:mm」', () => {
    const value = local(2026, 3, 9, 19, 30).toISOString();
    expect(formatRelativeTime(value, now)).toBe('昨天 19:30');
  });

  it('2~6 天前显示「N天前」', () => {
    const value = local(2026, 3, 5, 9, 0).toISOString();
    expect(formatRelativeTime(value, now)).toBe('5天前');
  });

  it('超过 7 天退回绝对日期', () => {
    const value = local(2026, 3, 1, 9, 0).toISOString();
    expect(formatRelativeTime(value, now)).toBe('2026-03-01');
  });

  it('未来时间不给「还有 -3 分钟」，直接给绝对时间', () => {
    const value = local(2026, 3, 20, 19, 30).toISOString();
    expect(formatRelativeTime(value, now)).toBe('2026-03-20 19:30');
  });

  it('空值与非法值返回空串', () => {
    expect(formatRelativeTime(null, now)).toBe('');
    expect(formatRelativeTime('x', now)).toBe('');
  });

  // --- 回归用例：「昨天」必须按日历日判定，不能按「距今不足 48 小时」---------
  it('跨零点的昨天仍是「昨天」，不是「N小时前」', () => {
    // 今天 03:00，昨天 23:50 —— 距今只有 3 小时多，但按日历是「昨天」
    const base = local(2026, 3, 10, 3, 0);
    const value = local(2026, 3, 9, 23, 50).toISOString();
    expect(formatRelativeTime(value, base)).toBe('昨天 23:50');
  });

  it('前天显示「2天前」，不会错标成「昨天」', () => {
    // 今天 12:00，前天 23:50 —— 距今 36 小时，按时长会误判成「昨天」
    const value = local(2026, 3, 8, 23, 50).toISOString();
    expect(formatRelativeTime(value, now)).toBe('2天前');
  });

  it('分钟数与小时数用本地时钟推导，不写死时区', () => {
    const d = local(2026, 3, 10, 11, 30);
    expect(formatRelativeTime(d.toISOString(), now)).toBe('30分钟前');
    const h = local(2026, 3, 10, 6, 0);
    expect(formatRelativeTime(h.toISOString(), now)).toBe('6小时前');
    const y = local(2026, 3, 9, 19, 30);
    expect(formatRelativeTime(y.toISOString(), now)).toBe(`昨天 ${pad(y.getHours())}:${pad(y.getMinutes())}`);
  });
});

describe('脱敏与截断', () => {
  it('手机号脱敏保留前 3 后 4', () => {
    expect(maskPhone('13800138000')).toBe('138****8000');
  });

  it('短号码原样返回', () => {
    expect(maskPhone('12345')).toBe('12345');
  });

  it('姓名脱敏保留姓氏', () => {
    expect(maskName('张三')).toBe('张*');
    expect(maskName('张')).toBe('张');
  });

  it('超长文本截断并加省略号', () => {
    expect(truncate('一二三四五', 3)).toBe('一二三…');
    expect(truncate('一二', 3)).toBe('一二');
  });

  it('头像占位字取姓名首字', () => {
    expect(avatarText('张三')).toBe('张');
    expect(avatarText('  ')).toBe('燕');
    expect(avatarText(null)).toBe('燕');
    expect(avatarText('')).toBe('燕');
  });
});
