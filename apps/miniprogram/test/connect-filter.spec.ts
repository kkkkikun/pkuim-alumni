/**
 * 第二轮真机反馈（2026-11-22 16:29 / 16:31）的对照用例。
 *
 * 客户三条反馈：
 *   ① 校友认证页底部的两个按钮要**左右并排**（上下堆叠显得笨重）；
 *   ② 连接栏目的二级筛选页**去掉「信息类型」**（外面列表页已经有 chip，重复入口）；
 *   ③ 连接列表页的「按行业方向查看」chip 行**太乱**，要收进二级筛选页。
 *
 * 这些反馈里真正会**改变行为**的是 ②③：行业筛选的入口从列表页挪到了二级页，
 * 类型筛选的入口从二级页挪回了列表页。
 * 如果改错，会出现两种典型故障：
 *   - 二级页「重置/确定」把列表页刚选的信息类型**一起改掉**（用户白选）；
 *   - 行业筛选挪走后**列表页看不到当前条件**（幽灵筛选）。
 *
 * 本文件测的是**生产代码本体** `src/utils/filter.ts`（筛选草稿的派生与提交）
 * 与 `src/demo/router.ts`（演示模式下行业筛选真的生效），不是复制品。
 */

import {
  buildIndustryOptions,
  connectFilterSignature,
  createConnectFilterDraft,
  isConnectFilterActive,
  isConnectFilterDraftEmpty,
  toConnectFilterPatch,
} from '../src/utils/filter';
import { handleDemoRequest } from '../src/demo/router';
import { dataset } from '../src/demo/dataset';
import type { ConnectFilter } from '../src/store/index';

function filter(patch: Partial<ConnectFilter> = {}): ConnectFilter {
  return {
    type: 'all',
    regionCode: '',
    industryCode: '',
    ...patch,
  };
}

describe('连接二级筛选页的草稿（真机反馈 16:31）', () => {
  it('草稿只带地区与行业，不带信息类型', () => {
    const draft = createConnectFilterDraft(filter({ type: 'resource', regionCode: 'HHS' }));
    expect(draft).toEqual({ regionCode: 'HHS', industryCode: '' });
    expect('type' in draft).toBe(false);
  });

  it('草稿把空值归一成空字符串', () => {
    const draft = createConnectFilterDraft({
      type: 'all',
      regionCode: undefined as unknown as string,
      industryCode: undefined as unknown as string,
    });
    expect(draft).toEqual({ regionCode: '', industryCode: '' });
  });

  it('提交的 patch 里**没有 type 键** —— 二级页不得覆盖列表页选的信息类型', () => {
    const draft = createConnectFilterDraft(filter({ type: 'demand' }));
    const patch = toConnectFilterPatch(draft);
    expect('type' in patch).toBe(false);
    expect(Object.keys(patch).sort()).toEqual(['industryCode', 'regionCode']);
  });

  it('提交的 patch 保留地区与行业', () => {
    const patch = toConnectFilterPatch({ regionCode: 'HHS', industryCode: 'DIGI' });
    expect(patch).toEqual({ regionCode: 'HHS', industryCode: 'DIGI' });
  });

  it('草稿为空 = 地区与行业都没选', () => {
    expect(isConnectFilterDraftEmpty({ regionCode: '', industryCode: '' })).toBe(true);
    expect(isConnectFilterDraftEmpty({ regionCode: 'HHS', industryCode: '' })).toBe(false);
    expect(isConnectFilterDraftEmpty({ regionCode: '', industryCode: 'DIGI' })).toBe(false);
  });
});

describe('行业筛选入口与幽灵条件（真机反馈 16:31）', () => {
  it('行业选项首项固定是「全部行业」，且所有行业都在', () => {
    const options = buildIndustryOptions(dataset.industries);
    expect(options[0]).toEqual({ code: '', name: '全部行业' });
    expect(options).toHaveLength(dataset.industries.length + 1);
    for (const industry of dataset.industries) {
      expect(options.some((item) => item.code === industry.code)).toBe(true);
    }
  });

  it('行业字典为空时也还有「全部行业」可选', () => {
    expect(buildIndustryOptions([])).toEqual([{ code: '', name: '全部行业' }]);
  });

  it('行业筛选是有效的筛选条件（选了就算生效，能被清空）', () => {
    expect(isConnectFilterActive(filter())).toBe(false);
    expect(isConnectFilterActive(filter({ industryCode: 'DIGI' }))).toBe(true);
    expect(isConnectFilterActive(filter({ type: 'demand' }))).toBe(true);
  });

  it('行业条件变化后签名必须变化（否则列表不会重载）', () => {
    const before = connectFilterSignature(filter());
    const after = connectFilterSignature(filter({ industryCode: 'DIGI' }));
    expect(before).not.toBe(after);
  });
});

describe('演示模式下行业筛选真的生效（离线演示兜底层的对照）', () => {
  it('按行业筛选的资源数量少于不筛选时', () => {
    const all = handleDemoRequest('GET', '/resources?page=1&pageSize=100') as {
      meta: { total: number };
    };
    const filtered = handleDemoRequest('GET', '/resources?industryCode=DIGI&page=1&pageSize=100') as {
      items: Array<{ industryCode: string }>;
      meta: { total: number };
    };
    expect(filtered.meta.total).toBeGreaterThan(0);
    expect(filtered.meta.total).toBeLessThan(all.meta.total);
    for (const item of filtered.items) {
      expect(item.industryCode).toBe('DIGI');
    }
  });

  it('行业 + 地区 + 类型三个条件可以叠加', () => {
    const target = dataset.resources.find(
      (item) => item.industryCode === 'DIGI' && item.regionCode === 'HHS' && item.type === 'resource'
    );
    if (!target) {
      // 演示内容库里没有这个组合时，断言「组合筛选不会越界」即可
      const result = handleDemoRequest(
        'GET',
        '/resources?industryCode=DIGI&regionCode=HHS&type=resource&page=1&pageSize=100'
      ) as { meta: { total: number } };
      expect(result.meta.total).toBe(0);
      return;
    }
    const result = handleDemoRequest(
      'GET',
      '/resources?industryCode=DIGI&regionCode=HHS&type=resource&page=1&pageSize=100'
    ) as { items: Array<{ id: number }>; meta: { total: number } };
    expect(result.meta.total).toBeGreaterThan(0);
    expect(result.items.map((item) => item.id)).toContain(target.id);
  });
});
