/**
 * 缺陷 #161 的对照用例（真机反馈：筛选不生效 / 输入框文字裁切 / 底栏遮挡）。
 *
 * ⚠️ 这些用例测的是**生产代码本体**：
 *   - `src/utils/filter.ts`（筛选签名与年份选项）；
 *   - `src/demo/router.ts`（离线演示路由的筛选行为）。
 *   不是复制品，满足「测试必须与生产同构」。
 */

import {
  buildGraduationYearOptions,
  connectFilterSignature,
  directoryFilterSignature,
  isConnectFilterActive,
  isDirectoryFilterActive,
} from '../src/utils/filter';
import { handleDemoRequest } from '../src/demo/router';
import { demoDirectory } from '../src/demo/directory';
import { dataset } from '../src/demo/dataset';
import type { ConnectFilter, DirectoryFilter } from '../src/store/index';

const DEFAULT_DIRECTORY: DirectoryFilter = {
  keyword: '',
  regionCode: '',
  industryCode: '',
  graduationYear: null,
};

const DEFAULT_CONNECT: ConnectFilter = {
  type: 'all',
  regionCode: '',
  industryCode: '',
};

describe('筛选条件签名（真机缺陷 #161）', () => {
  it('默认筛选条件的签名是固定的空签名', () => {
    expect(directoryFilterSignature(DEFAULT_DIRECTORY)).toBe('|||');
    expect(connectFilterSignature(DEFAULT_CONNECT)).toBe('all||');
  });

  it('关键词变化 → 签名变化', () => {
    expect(directoryFilterSignature({ ...DEFAULT_DIRECTORY, keyword: '张' })).not.toBe(
      directoryFilterSignature(DEFAULT_DIRECTORY)
    );
  });

  it('地区变化 → 签名变化', () => {
    expect(directoryFilterSignature({ ...DEFAULT_DIRECTORY, regionCode: 'HHS' })).not.toBe(
      directoryFilterSignature(DEFAULT_DIRECTORY)
    );
  });

  it('行业变化 → 签名变化', () => {
    expect(directoryFilterSignature({ ...DEFAULT_DIRECTORY, industryCode: 'DIGI' })).not.toBe(
      directoryFilterSignature(DEFAULT_DIRECTORY)
    );
  });

  it('毕业年份变化 → 签名变化（null 与 0 视为同一种「不限」）', () => {
    const withYear = directoryFilterSignature({ ...DEFAULT_DIRECTORY, graduationYear: 2015 });
    expect(withYear).not.toBe(directoryFilterSignature(DEFAULT_DIRECTORY));
    expect(directoryFilterSignature({ ...DEFAULT_DIRECTORY, graduationYear: 0 })).toBe(
      directoryFilterSignature(DEFAULT_DIRECTORY)
    );
  });

  it('连接栏目的类型 / 地区 / 行业任一变化 → 签名变化', () => {
    expect(connectFilterSignature({ ...DEFAULT_CONNECT, type: 'resource' })).not.toBe(
      connectFilterSignature(DEFAULT_CONNECT)
    );
    expect(connectFilterSignature({ ...DEFAULT_CONNECT, regionCode: 'HHS' })).not.toBe(
      connectFilterSignature(DEFAULT_CONNECT)
    );
    expect(connectFilterSignature({ ...DEFAULT_CONNECT, industryCode: 'ENER' })).not.toBe(
      connectFilterSignature(DEFAULT_CONNECT)
    );
  });

  it('「是否有生效筛选」判定：默认否，有条件是', () => {
    expect(isDirectoryFilterActive(DEFAULT_DIRECTORY)).toBe(false);
    expect(isDirectoryFilterActive({ ...DEFAULT_DIRECTORY, graduationYear: 2015 })).toBe(true);
    expect(isConnectFilterActive(DEFAULT_CONNECT)).toBe(false);
    expect(isConnectFilterActive({ ...DEFAULT_CONNECT, type: 'demand' })).toBe(true);
  });

  it('毕业年份选项覆盖最近 21 年（真机反馈：只给 6 年，选了就是 0 条）', () => {
    const years = buildGraduationYearOptions(2026);
    expect(years.length).toBe(21);
    expect(years[0]).toBe(2026);
    expect(years[20]).toBe(2006);
  });
});

describe('演示路由的筛选行为（真机缺陷 #161 的对照组）', () => {
  it('关键词能筛出对应校友', () => {
    const result = handleDemoRequest('GET', '/directory?keyword=%E5%BC%A0&page=1&pageSize=15') as {
      items: Array<{ displayName: string }>;
      meta: { total: number };
    };
    expect(result.meta.total).toBe(1);
    expect(result.items[0].displayName).toBe('张同学');
  });

  it('不筛选时返回全部 12 条虚构校友', () => {
    const result = handleDemoRequest('GET', '/directory?page=1&pageSize=15') as { meta: { total: number } };
    expect(result.meta.total).toBe(demoDirectory.length);
  });

  it('地区 + 行业组合筛选后数量一致于本地过滤的结果', () => {
    const result = handleDemoRequest('GET', '/directory?regionCode=HHS&industryCode=DIGI&page=1&pageSize=15') as {
      items: Array<{ userId: number }>;
      meta: { total: number };
    };
    const expected = demoDirectory.filter(
      (item) => item.regionCode === 'HHS' && item.industryCode === 'DIGI'
    );
    expect(result.meta.total).toBe(expected.length);
  });

  it('资源按类型筛选能筛出结果', () => {
    const all = handleDemoRequest('GET', '/resources?page=1&pageSize=50') as { meta: { total: number } };
    const resource = handleDemoRequest('GET', '/resources?type=resource&page=1&pageSize=50') as {
      meta: { total: number };
    };
    const demand = handleDemoRequest('GET', '/resources?type=demand&page=1&pageSize=50') as {
      meta: { total: number };
    };
    expect(all.meta.total).toBe(dataset.resources.length);
    expect(resource.meta.total + demand.meta.total).toBe(all.meta.total);
    expect(resource.meta.total).toBeGreaterThan(0);
  });

  it('地区字典里的每个地区都至少有 1 条资源（选任何地区都不该是 0 条）', () => {
    const covered = new Set(dataset.resources.map((item) => item.regionCode));
    const missing = dataset.regions
      .filter((region) => !covered.has(region.code))
      .map((region) => region.name);
    expect(missing).toEqual([]);
  });
});
