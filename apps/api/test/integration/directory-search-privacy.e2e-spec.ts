import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DICT, createTestApp, login, markVerified, resetDatabase, setProfile } from '../helpers';

/**
 * 字段可见开关必须在**所有路径**上有效（缺陷 #105 ~ #106）。
 *
 * 既有测试（directory.e2e-spec.ts）只验证了**响应**里的字段裁剪
 * （「按对方的字段可见开关裁剪字段」），**检索路径**从未被验证：
 *
 *   - 关键字搜索直接 `LIKE` 匹配 `p.college` / `p.direction` / `p.intro` /
 *     `region.name` / `industry.name`；
 *   - `regionCode` / `industryCode` 筛选直接按列等值匹配。
 *
 * 而响应里这几个字段**恰好**按 `showCollege` / `showDirection` / `showRegion` /
 * `showIndustry` 裁剪。于是用户明明把「我的学院/行业/地区/方向」设为不公开，
 * 别人照样能通过搜索**反推**出来 —— 开关在检索路径上**完全失效**。
 */
const API = '/api/v1';

describe('隐私开关的有效性（缺陷 #105~#106）', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    ({ app, dataSource } = await createTestApp());
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  async function seedAlumni(openid: string, overrides: Record<string, unknown> = {}) {
    const session = await login(app, openid);
    await markVerified(dataSource, session.userId);
    await setProfile(dataSource, session.userId, {
      display_name: `校友-${openid}`,
      college: '经济学院',
      graduation_year: 2015,
      region_code: DICT.regions.hohhot,
      industry_code: DICT.industries.digital,
      direction: '软件开发',
      intro: '我是一名普通的软件工程师',
      show_in_directory: 1,
      show_college: 1,
      show_industry: 1,
      show_region: 1,
      show_direction: 1,
      ...overrides,
    });
    return session;
  }

  const search = async (viewerToken: string, query: string) => {
    const res = await request(app.getHttpServer())
      .get(`${API}/directory${query}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(200);
    return res.body.data.items as { userId: number; displayName: string }[];
  };

  it('#105 隐藏学院的人不得被按学院搜出', async () => {
    const viewer = await seedAlumni('search-viewer-1');
    const target = await seedAlumni('search-target-1', {
      college: '计算机学院',
      show_college: 0,
    });

    const items = await search(viewer.accessToken, '?keyword=' + encodeURIComponent('计算机学院'));
    expect(items.map((i) => i.userId)).not.toContain(target.userId);
  });

  it('#105 隐藏方向的人不得被按方向搜出', async () => {
    const viewer = await seedAlumni('search-viewer-2');
    const target = await seedAlumni('search-target-2', {
      direction: '人工智能研究',
      show_direction: 0,
    });

    const items = await search(
      viewer.accessToken,
      '?keyword=' + encodeURIComponent('人工智能研究'),
    );
    expect(items.map((i) => i.userId)).not.toContain(target.userId);
  });

  it('#105 隐藏地区的人不得被按地区筛出', async () => {
    const viewer = await seedAlumni('search-viewer-3');
    const target = await seedAlumni('search-target-3', {
      region_code: DICT.regions.baotou,
      show_region: 0,
    });

    const items = await search(viewer.accessToken, '?regionCode=' + DICT.regions.baotou);
    expect(items.map((i) => i.userId)).not.toContain(target.userId);
  });

  it('#105 隐藏行业的人不得被按行业筛出', async () => {
    const viewer = await seedAlumni('search-viewer-4');
    const target = await seedAlumni('search-target-4', {
      industry_code: DICT.industries.energy,
      show_industry: 0,
    });

    const items = await search(viewer.accessToken, '?industryCode=' + DICT.industries.energy);
    expect(items.map((i) => i.userId)).not.toContain(target.userId);
  });

  it('#105 简介从未出现在通讯录里 → 不得作为检索键（否则等于「简介内容存在性」的预言机）', async () => {
    const viewer = await seedAlumni('search-viewer-5');
    const target = await seedAlumni('search-target-5', {
      intro: '独特标记语：我曾参与过载人航天项目',
    });

    const items = await search(
      viewer.accessToken,
      '?keyword=' + encodeURIComponent('载人航天项目'),
    );
    expect(items.map((i) => i.userId)).not.toContain(target.userId);
  });

  it('对照：未隐藏学院的人**可以**被按学院搜出（不得把发现能力一起关掉）', async () => {
    const viewer = await seedAlumni('search-viewer-6');
    const target = await seedAlumni('search-target-6', {
      college: '法学院',
      show_college: 1,
    });

    const items = await search(viewer.accessToken, '?keyword=' + encodeURIComponent('法学院'));
    expect(items.map((i) => i.userId)).toContain(target.userId);
  });

  it('对照：按姓名搜索始终可用（姓名不受开关控制）', async () => {
    const viewer = await seedAlumni('search-viewer-7');
    const target = await seedAlumni('search-target-7', {
      show_college: 0,
      show_industry: 0,
      show_region: 0,
      show_direction: 0,
    });

    const items = await search(
      viewer.accessToken,
      '?keyword=' + encodeURIComponent('校友-search-target-7'),
    );
    expect(items.map((i) => i.userId)).toContain(target.userId);
  });

  it('对照：按毕业年份筛选可用（年份不受开关控制）', async () => {
    const viewer = await seedAlumni('search-viewer-8');
    const target = await seedAlumni('search-target-8', {
      graduation_year: 2011,
      show_college: 0,
      show_industry: 0,
      show_region: 0,
      show_direction: 0,
    });

    const items = await search(viewer.accessToken, '?graduationYear=2011');
    expect(items.map((i) => i.userId)).toContain(target.userId);
  });
  it('#106 用户必须能自己开关「公开我的方向」（此前服务端据此隐藏 direction，却无从修改）', async () => {
    const target = await seedAlumni('direction-target-1', {
      direction: '人工智能研究',
      show_direction: 0,
    });

    // 读：必须能看到这个开关（修复前响应里根本没有这个字段）
    const before = await request(app.getHttpServer())
      .get(`${API}/me/privacy`)
      .set('Authorization', `Bearer ${target.accessToken}`)
      .expect(200);
    expect(before.body.data.showDirection).toBe(false);

    // 写：必须能改成 true（修复前 DTO 里没有这个字段 → 被 ValidationPipe 静默剥掉）
    await request(app.getHttpServer())
      .put(`${API}/me/privacy`)
      .set('Authorization', `Bearer ${target.accessToken}`)
      .send({ showDirection: true })
      .expect(200);

    const after = await request(app.getHttpServer())
      .get(`${API}/me/privacy`)
      .set('Authorization', `Bearer ${target.accessToken}`)
      .expect(200);
    expect(after.body.data.showDirection).toBe(true);

    // 端到端：开关打开后，别人在通讯录里真的能搜到他
    const viewer = await seedAlumni('direction-viewer-1');
    const items = await search(
      viewer.accessToken,
      '?keyword=' + encodeURIComponent('人工智能研究'),
    );
    expect(items.map((i) => i.userId)).toContain(target.userId);
  });
});
