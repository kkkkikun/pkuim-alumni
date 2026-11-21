#!/usr/bin/env node
/**
 * 管理后台 UI 冒烟（真实浏览器，headless）。
 *
 * 背景：管理后台此前只有**静态**校验（路由表、权限点、组件引用），
 *       从未在真实浏览器里加载过 —— 「编译通过」不等于「页面能渲染」。
 *       静态校验查不出的典型问题：运行时白屏、路由守卫误判、
 *       接口路径与后端不匹配、组件里 undefined 访问导致的报错。
 *
 * 本脚本做**只读**验证：登录 → 逐个打开路由 → 采集
 *   - console error / uncaught exception
 *   - HTTP >= 400 的请求（xhr / fetch / document）
 *   - 页面可见文本长度（判断是否白屏）
 *   - 指定表格列必须真的有值（空列 = 服务端少给了字段）
 * 外加**第三轮四项专项检查**（见下）：
 *   1. 活动管理 → 报名名单抽屉分页（抽屉打开 / 有报名行 / 有分页控件）
 *   2. 角色权限页的目录条目结构（渲染的是角色名，不是裸代码 / 没有 undefined）
 *   3. 系统设置分页（表格有行 + 有分页控件）
 *   4. 资讯/公告列表的正文完整性（管理端列表必须给全文，不能是 200 字摘要）
 * 不点任何创建 / 删除 / 提交按钮，不产生业务数据。
 *
 * 用法：node admin-ui-smoke.mjs <baseUrl> [outDir]
 *   baseUrl：管理后台入口（nginx 同源代理了 /api/v1，例如 http://127.0.0.1:18090）
 *   outDir ：截图与报告输出目录，默认 /tmp/pw/shots
 *
 * 环境要求：playwright（npm 包）+ chromium 二进制。
 *   chromium 二进制默认路径：~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome
 *   可用 CHROME_PATH 环境变量覆盖。
 */

import fs from 'node:fs';
import path from 'node:path';

// 动态加载：playwright 不在 workspace 依赖里（避免影响 --frozen-lockfile 构建），
// 需要时在临时目录单独安装：npm i playwright --registry=https://registry.npmmirror.com
// ESM 不认 NODE_ENV/NODE_PATH，用 PLAYWRIGHT_MODULE_DIR 显式指定模块目录。
let chromium;
try {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const searchPaths = process.env.PLAYWRIGHT_MODULE_DIR
    ? [process.env.PLAYWRIGHT_MODULE_DIR]
    : undefined;
  const resolved = require.resolve('playwright', searchPaths ? { paths: searchPaths } : undefined);
  ({ chromium } = require(resolved));
} catch {
  console.error(
    '缺少 playwright。请在临时目录安装后重试：\n' +
      '  mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright --registry=https://registry.npmmirror.com\n' +
      '  PLAYWRIGHT_MODULE_DIR=/tmp/pw/node_modules node infra/scripts/admin-ui-smoke.mjs <baseUrl>',
  );
  process.exit(2);
}

const BASE = process.argv[2] ?? 'http://127.0.0.1:18090';
const OUT_DIR = process.argv[3] ?? '/tmp/pw/shots';
const CHROME =
  process.env.CHROME_PATH ??
  `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;

const ROUTES = [
  { path: '/dashboard', name: '总览' },
  // columns：该页表格里**必须有值**的列标题。
  // 「不抛异常」不等于「没问题」：字段缺失 / 字段名对不上时，页面照常渲染，
  // 只是该列**恒为空**（缺陷 #59 的账号状态列、#60/#61 的操作人列就是如此）。
  { path: '/alumni', name: '校友管理', columns: ['账号状态', '认证状态'] },
  { path: '/verification', name: '认证审核', columns: ['申请人'] },
  { path: '/resource', name: '资源审核', columns: ['标题', '发布人'] },
  { path: '/events', name: '活动管理', columns: ['活动名称'] },
  { path: '/articles', name: '资讯管理', columns: ['标题'] },
  { path: '/notices', name: '公告管理', columns: ['标题'] },
  { path: '/system/admins', name: '管理员账号', columns: ['账号', '角色'] },
  { path: '/system/roles', name: '角色权限', columns: ['角色'] },
  { path: '/system/dictionary', name: '字典管理', columns: ['名称'] },
  { path: '/system/logs', name: '审计日志', columns: ['操作人'] },
  { path: '/system/settings', name: '系统设置', columns: ['配置项'] },
  { path: '/events/new', name: '新建活动' },
];

const ADMIN_USER = process.env.ADMIN_USER ?? 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS ?? 'Admin@2026';

/** API 根（管理后台同源代理了 /api/v1，用它即可同时测到真实后端）。 */
const API_ROOT = `${BASE.replace(/\/+$/, '')}/api/v1`;

fs.mkdirSync(OUT_DIR, { recursive: true });

const report = {
  base: BASE,
  login: { ok: false, error: null },
  routes: [],
  checks: [],
  consoleErrors: [],
  failedRequests: [],
  pageErrors: [],
};

// ---------------------------------------------------------------------------
// 只读 API 辅助（第三轮专项检查用；不写任何数据）
// ---------------------------------------------------------------------------

/** 管理端登录，取 accessToken。 */
async function apiLogin() {
  const res = await fetch(`${API_ROOT}/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  const payload = await res.json().catch(() => null);
  const token = payload?.data?.accessToken ?? payload?.accessToken;
  if (!token) throw new Error(`管理端登录失败：${JSON.stringify(payload).slice(0, 200)}`);
  return token;
}

/** GET 一个 JSON 接口，返回 data 字段。 */
async function apiGet(pathname, token) {
  const res = await fetch(`${API_ROOT}${pathname}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok || (payload?.code && payload.code !== 'OK')) {
    throw new Error(`GET ${pathname} → ${res.status} ${JSON.stringify(payload).slice(0, 200)}`);
  }
  return payload?.data ?? payload;
}

// ---------------------------------------------------------------------------
// 第三轮专项检查
// ---------------------------------------------------------------------------

/**
 * 1) 活动管理 → 报名名单抽屉分页。
 *
 * 第三轮把 `GET /admin/events/:id/registrations` 从「裸数组（全部报名记录）」
 * 改成了 `{items, meta}`，抽屉里必须有分页控件；否则 1000 人活动的点名
 * 会一次性把全部记录塞进抽屉（也曾把页面撑到不可用）。
 */
async function checkRosterDrawer(page) {
  const out = {
    area: '活动管理 → 报名名单抽屉分页',
    route: '/events',
    status: 'fail',
    note: null,
    details: {},
  };
  try {
    await page.goto(`${BASE}/#/events`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(800);

    // 挑一个「报名人数 > 0」的活动行，避免打开空名单造成误判
    const target = await page.evaluate(() => {
      const table = document.querySelector('table');
      if (!table) return null;
      const ths = [...table.querySelectorAll('thead th')].map((th) => (th.textContent ?? '').trim());
      const idx = ths.indexOf('人数/报名');
      const rows = [...table.querySelectorAll('tbody tr')];
      for (let i = 0; i < rows.length; i += 1) {
        const cell = idx >= 0 ? (rows[i].children[idx]?.innerText ?? '').trim() : '';
        const m = /^(\d+)\//.exec(cell);
        if (m && Number(m[1]) > 0) return { index: i, cell };
      }
      return rows.length ? { index: 0, cell: null } : null;
    });
    if (!target) throw new Error('活动表里没有可点击的行');
    out.details.targetRow = target;

    const row = page.locator('table').first().locator('tbody tr').nth(target.index);
    const button = row.locator('button', { hasText: '报名名单' }).first();
    await button.waitFor({ state: 'visible', timeout: 15000 });
    await button.click();
    await page.waitForTimeout(1500);

    const info = await page.evaluate(() => {
      const drawers = [...document.querySelectorAll('.t-drawer')];
      const drawer =
        drawers.find((el) => el.getBoundingClientRect().width > 0) ?? drawers[drawers.length - 1];
      if (!drawer) return { found: false };
      const rows = [...drawer.querySelectorAll('table tbody tr')].map((tr) =>
        [...tr.children].map((td) => (td.innerText ?? '').trim()),
      );
      const pager = drawer.querySelector('.t-pagination');
      return {
        found: true,
        header: (drawer.querySelector('.t-drawer__header')?.innerText ?? '').trim(),
        rowCount: rows.length,
        sample: rows.slice(0, 3),
        pagination: Boolean(pager),
        pagerText: (pager?.innerText ?? '').replace(/\s+/g, ' ').trim(),
      };
    });
    Object.assign(out.details, info);

    if (!info.found) throw new Error('报名名单抽屉没有打开（页面上找不到 .t-drawer）');
    if (info.rowCount < 1) throw new Error(`报名名单抽屉里没有报名记录行（行数=${info.rowCount}）`);
    if (!info.pagination) {
      throw new Error('报名名单抽屉里没有分页控件（.t-pagination 不存在，抽屉仍是「一次性全量」形态）');
    }
    out.status = 'pass';
    out.note = `抽屉已打开（${info.header}），报名 ${info.rowCount} 行，分页控件存在（${info.pagerText || '.t-pagination'}）`;
  } catch (error) {
    out.note = String(error).split('\n')[0].slice(0, 300);
  }
  await page
    .screenshot({ path: path.join(OUT_DIR, 'after-events-roster-drawer.png') })
    .catch(() => {});
  return out;
}

/**
 * 2) 角色权限页的目录条目结构。
 *
 * 第三轮 `GET /admin/roles` / `GET /admin/permissions` 改为分页结构，
 * 且条目是**目录整行**（`{id, code, name, description}`），不再是代码字符串。
 * 页面此前把返回对象当代码字符串用 → 角色名渲染成 `[object Object]`。
 */
async function checkRolesCatalogue(page, token) {
  const out = {
    area: '角色权限页的目录条目结构',
    route: '/system/roles',
    status: 'fail',
    note: null,
    details: {},
  };
  try {
    const roleData = await apiGet('/admin/roles?pageSize=100', token);
    const catalogue = Array.isArray(roleData?.items) ? roleData.items : [];
    const rawCodes = catalogue.map((item) => String(item.code ?? ''));

    await page.goto(`${BASE}/#/system/roles`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(800);

    const info = await page.evaluate(() => {
      const tables = [];
      for (const table of document.querySelectorAll('table')) {
        const ths = [...table.querySelectorAll('thead th')].map((th) => (th.textContent ?? '').trim());
        const rows = [...table.querySelectorAll('tbody tr')];
        const roleIdx = ths.indexOf('角色');
        tables.push({
          headers: ths,
          rowCount: rows.length,
          roleCol: roleIdx,
          roleCells:
            roleIdx >= 0
              ? rows.map((tr) => (tr.children[roleIdx]?.innerText ?? '').trim())
              : [],
          cells: rows.flatMap((tr) => [...tr.children].map((td) => (td.innerText ?? '').trim())),
        });
      }
      return { tables, pageText: document.body?.innerText ?? '' };
    });

    const roleTable = info.tables.find((t) => t.roleCol >= 0) ?? null;
    const roleCells = roleTable?.roleCells ?? [];
    // 「渲染出来的是角色名」而不是「裸代码」：单元格文本与原始 code 不相等。
    const labelled = roleCells.filter((cell) => cell.length > 0 && !rawCodes.includes(cell));
    const bare = roleCells.filter((cell) => rawCodes.includes(cell));
    const allCells = info.tables.flatMap((t) => t.cells);
    const badCells = allCells.filter(
      (cell) => cell.includes('undefined') || cell.includes('[object Object]'),
    );
    const badPage = /undefined|\[object Object\]/.test(info.pageText);

    Object.assign(out.details, {
      catalogueRows: catalogue.length,
      renderedRoleRows: roleTable?.rowCount ?? 0,
      labelledRows: labelled.length,
      bareCodeRows: bare.length,
      roleCellSample: roleCells.slice(0, 8),
      badCells: badCells.slice(0, 5),
      badLiteralOnPage: badPage,
    });

    if (!roleTable) throw new Error('页面上没有「角色」列的表格（角色目录表未渲染）');
    if (roleTable.rowCount < 1) throw new Error('角色表没有渲染出任何角色行');
    if (badCells.length > 0) {
      throw new Error(
        `表格单元格出现 undefined / [object Object]：${JSON.stringify(badCells.slice(0, 3))}`,
      );
    }
    if (badPage) {
      throw new Error('页面上出现 undefined / [object Object] 字面量（旧的「拿对象当代码字符串」缺陷）');
    }
    if (labelled.length === 0) {
      throw new Error(
        `角色列渲染出来的仍然全是裸代码（${bare.length} 行，如 ${JSON.stringify(bare.slice(0, 3))}）`,
      );
    }
    out.status = 'pass';
    out.note = `角色目录 ${roleTable.rowCount} 行（接口 ${catalogue.length} 条）：名称化 ${labelled.length} 行 / 裸代码 ${bare.length} 行，无 undefined/[object Object]`;
  } catch (error) {
    out.note = String(error).split('\n')[0].slice(0, 300);
  }
  await page.screenshot({ path: path.join(OUT_DIR, 'after-system-roles.png') }).catch(() => {});
  return out;
}

/**
 * 3) 系统设置分页。
 *
 * 第三轮 `GET /admin/settings` 改为分页结构（此前是无上限全表返回）。
 * 页面必须跟着有分页控件 —— 否则配置项一多就只看得到第一页。
 */
async function checkSettingsPagination(page, token) {
  const out = {
    area: '系统设置分页',
    route: '/system/settings',
    status: 'fail',
    note: null,
    details: {},
  };
  try {
    const settingData = await apiGet('/admin/settings?pageSize=100', token);
    const meta = settingData?.meta ?? null;

    await page.goto(`${BASE}/#/system/settings`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(800);

    const info = await page.evaluate(() => {
      const tables = [...document.querySelectorAll('table')];
      let rows = 0;
      let headers = [];
      for (const table of tables) {
        const ths = [...table.querySelectorAll('thead th')].map((th) => (th.textContent ?? '').trim());
        if (ths.includes('配置项')) {
          headers = ths;
          rows = table.querySelectorAll('tbody tr').length;
        }
      }
      const pager = document.querySelector('.t-pagination');
      const pagerBar = document.querySelector('.pager');
      return {
        rows,
        headers,
        pagination: Boolean(pager),
        pagerBar: Boolean(pagerBar),
        pagerText: (pager?.innerText ?? '').replace(/\s+/g, ' ').trim(),
      };
    });

    Object.assign(out.details, { ...info, apiMeta: meta });

    if (info.rows < 1) throw new Error('系统设置表没有渲染出配置项行');
    if (!info.pagination && !info.pagerBar) {
      throw new Error(
        '系统设置页没有分页控件（.t-pagination / .pager 都不存在）：第三轮把 GET /admin/settings 改成分页结构，页面却仍硬编码 page=1&pageSize=100 且未渲染 PagerBar —— 配置项超过 100 条时后面的行永远看不到',
      );
    }
    out.status = 'pass';
    out.note = `设置表 ${info.rows} 行（接口 meta.total=${meta?.total ?? '?'}），分页控件存在（${info.pagerText || '.t-pagination'}）`;
  } catch (error) {
    out.note = String(error).split('\n')[0].slice(0, 300);
  }
  await page.screenshot({ path: path.join(OUT_DIR, 'after-system-settings.png') }).catch(() => {});
  return out;
}

/**
 * 4) 资讯/公告列表的正文完整性。
 *
 * 公开列表把 body 截成 200 字摘要（LIST_BODY_EXCERPT_LENGTH），
 * 但**管理端列表必须给全文**：编辑弹窗把列表行里的 body 回填进表单，
 * 截断会让管理员保存时静默截断正文 —— 那是数据损坏，不是性能优化。
 *
 * 验收口径（按任务书）：
 *   - 任一文章/公告的正文长度 > 200 → 判为缺陷并报告；
 *   - 附加校验：管理端列表正文长度必须与详情接口正文长度一致（真正的截断证据）。
 */
async function checkContentBodyIntegrity(page, token) {
  const out = {
    area: '资讯/公告列表的正文完整性',
    routes: ['/articles', '/notices'],
    status: 'fail',
    note: null,
    details: {},
  };
  try {
    const kinds = [
      { kind: 'article', admin: '/admin/articles?pageSize=100', detail: (id) => `/articles/${id}` },
      { kind: 'notice', admin: '/admin/notices?pageSize=100', detail: (id) => `/notices/${id}` },
    ];
    const observed = [];
    const problems = [];
    for (const k of kinds) {
      const data = await apiGet(k.admin, token);
      const items = Array.isArray(data?.items) ? data.items : [];
      for (const item of items) {
        const listLen = (item.body ?? '').length;
        let detailLen = null;
        try {
          const detail = await apiGet(k.detail(item.id), token);
          detailLen = (detail?.body ?? '').length;
        } catch {
          detailLen = null;
        }
        observed.push({
          kind: k.kind,
          id: item.id,
          title: item.title,
          listBodyLength: listLen,
          detailBodyLength: detailLen,
        });
        if (detailLen !== null && detailLen !== listLen) {
          problems.push(
            `${k.kind}#${item.id}：管理端列表正文 ${listLen} 字 ≠ 详情正文 ${detailLen} 字（列表被截断）`,
          );
        }
        if (listLen > 200) {
          problems.push(`${k.kind}#${item.id}：正文长度 ${listLen} > 200（按验收口径判为缺陷）`);
        }
      }
    }

    const articles = observed.filter((o) => o.kind === 'article');
    const notices = observed.filter((o) => o.kind === 'notice');
    const fmt = (list) =>
      list.map((o) => `${o.id}:${o.listBodyLength}`).join(',') || '（空列表）';
    Object.assign(out.details, {
      articleCount: articles.length,
      noticeCount: notices.length,
      articleBodyLengths: fmt(articles),
      noticeBodyLengths: fmt(notices),
      maxArticleBodyLength: articles.reduce((m, o) => Math.max(m, o.listBodyLength), 0),
      maxNoticeBodyLength: notices.reduce((m, o) => Math.max(m, o.listBodyLength), 0),
      over200: observed.filter((o) => o.listBodyLength > 200).length,
      truncated: observed.filter((o) => o.detailBodyLength !== null && o.detailBodyLength !== o.listBodyLength),
    });

    // 页面截图（列表渲染本身也顺手看一眼）
    await page.goto(`${BASE}/#/articles`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT_DIR, 'after-articles-list.png') }).catch(() => {});
    await page.goto(`${BASE}/#/notices`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT_DIR, 'after-notices-list.png') }).catch(() => {});

    if (observed.length === 0) {
      throw new Error('管理端文章/公告列表返回空，无法验证正文完整性');
    }
    if (problems.length > 0) {
      throw new Error(problems.slice(0, 5).join('；'));
    }
    out.status = 'pass';
    out.note = `资讯正文长度 ${fmt(articles)}；公告正文长度 ${fmt(notices)}；均 ≤200 且与详情接口一致（未截断）`;
  } catch (error) {
    out.note = String(error).split('\n')[0].slice(0, 300);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

page.on('console', (msg) => {
  if (msg.type() === 'error') {
    const text = msg.text();
    // favicon 之类的资源噪声不算缺陷
    if (/favicon/i.test(text)) return;
    report.consoleErrors.push({ url: page.url(), text: text.slice(0, 500) });
  }
});
page.on('pageerror', (error) => {
  report.pageErrors.push({ url: page.url(), message: String(error).slice(0, 500) });
});
page.on('response', (res) => {
  const status = res.status();
  if (status < 400) return;
  const type = res.request().resourceType();
  if (!['xhr', 'fetch', 'document'].includes(type)) return;
  report.failedRequests.push({
    url: page.url(),
    status,
    method: res.request().method(),
    path: new URL(res.url()).pathname,
  });
});

try {
  // --- 登录 -------------------------------------------------------------
  await page.goto(`${BASE}/#/login`, { waitUntil: 'networkidle', timeout: 30000 });
  const inputs = await page.locator('input').count();
  if (inputs < 2) throw new Error(`登录页未找到用户名/密码输入框（input 数量=${inputs}）`);

  // 依次填入两个输入框（用户名、密码）
  await page.locator('input').nth(0).fill(ADMIN_USER);
  await page.locator('input').nth(1).fill(ADMIN_PASS);
  await page.keyboard.press('Enter');

  // 后台使用 hash 路由（/#/dashboard），跳转只改 hash，不改 pathname
  await page.waitForURL((url) => !url.hash.includes('/login'), { timeout: 20000 });
  await page.waitForLoadState('networkidle', { timeout: 20000 });
  report.login.ok = true;
  report.login.landedOn = page.url();
  await page.screenshot({ path: path.join(OUT_DIR, '00-after-login.png') });

  // --- 逐个路由 ---------------------------------------------------------
  for (const [index, route] of ROUTES.entries()) {
    const before = report.consoleErrors.length + report.pageErrors.length + report.failedRequests.length;
    let status = 'ok';
    let note = null;
    try {
      await page.goto(`${BASE}/#${route.path}`, { waitUntil: 'networkidle', timeout: 30000 });
      // 等待 Vue 完成一次渲染
      await page.waitForTimeout(600);
      const text = await page.evaluate(() => document.body?.innerText?.trim() ?? '');
      const textLen = text.length;
      const shot = path.join(OUT_DIR, `${String(index + 1).padStart(2, '0')}-${route.path.replace(/\//g, '_')}.png`);
      await page.screenshot({ path: shot, fullPage: false });
      if (textLen < 20) {
        status = 'blank';
        note = `可见文本仅 ${textLen} 字符，疑似白屏`;
      }

      // 列内容断言：指定列必须真的有值（空列 = 服务端少给了字段）
      if (status === 'ok' && route.columns?.length) {
        const columnReport = [];
        // ⚠️ 先看这一页**有没有渲染出表格**：
        //    TDesign 在表为空时渲染的是空状态、**根本没有 `<table>`**，
        //    此时「找不到列」是**空表**而不是「服务端少给了字段」。
        //    此前把两者混为一谈 → `/resource`、`/system/logs` 两页误报
        //    （第三轮是靠补测试数据绕过去的，不是修好；见 KNOWN-ISSUES #184）。
        const tableCount = await page.evaluate(() => document.querySelectorAll('table').length);
        if (tableCount === 0) {
          route.columnReport = [];
          route.emptyTable = true;
          note = '页面没有表格（空表 / 空状态），跳过列内容断言';
        } else {
          for (const column of route.columns) {
            const stat = await page.evaluate((title) => {
              // 一个页面上可能有多张表，列下标必须**按表**定位，
              // 否则跨表累计的 th 下标会取错列（曾把「权限点目录」当成矩阵表）。
              for (const table of document.querySelectorAll('table')) {
                const ths = [...table.querySelectorAll('thead th')];
                const index = ths.findIndex((th) => (th.textContent ?? '').trim() === title);
                if (index < 0) continue;
                const rows = [...table.querySelectorAll('tbody tr')];
                const values = rows.map((tr) => (tr.children[index]?.innerText ?? '').trim());
                return {
                  found: true,
                  rows: values.length,
                  nonEmpty: values.filter((v) => v.length > 0 && v !== '—').length,
                };
              }
              return { found: false };
            }, column);
            columnReport.push({ column, ...stat });
            if (!stat.found) {
              status = 'fail';
              note = `表格里找不到列「${column}」`;
            } else if (stat.rows > 0 && stat.nonEmpty === 0) {
              status = 'fail';
              note = `列「${column}」有 ${stat.rows} 行但**全是空值**（服务端很可能少给了字段）`;
            }
          }
          route.columnReport = columnReport;
        }
      }
    } catch (error) {
      status = 'error';
      note = String(error).split('\n')[0].slice(0, 200);
    }
    const after = report.consoleErrors.length + report.pageErrors.length + report.failedRequests.length;
    report.routes.push({
      path: route.path,
      name: route.name,
      status,
      note,
      newIssues: after - before,
      columnReport: route.columnReport ?? null,
    });
  }

  // --- 第三轮四项专项检查 ------------------------------------------------
  let token = null;
  try {
    token = await apiLogin();
  } catch (error) {
    const failed = (area, note) => ({ area, status: 'fail', note, details: {} });
    report.checks.push(failed('活动管理 → 报名名单抽屉分页', `无法登录取令牌：${error}`));
    report.checks.push(failed('角色权限页的目录条目结构', `无法登录取令牌：${error}`));
    report.checks.push(failed('系统设置分页', `无法登录取令牌：${error}`));
    report.checks.push(failed('资讯/公告列表的正文完整性', `无法登录取令牌：${error}`));
  }
  if (token) {
    report.checks.push(await checkRosterDrawer(page));
    report.checks.push(await checkRolesCatalogue(page, token));
    report.checks.push(await checkSettingsPagination(page, token));
    report.checks.push(await checkContentBodyIntegrity(page, token));
  }

  // --- 403 页面（无权限路由守卫）----------------------------------------
  try {
    await page.goto(`${BASE}/#/403`, { waitUntil: 'networkidle', timeout: 20000 });
    const text = await page.evaluate(() => document.body?.innerText?.trim() ?? '');
    report.forbiddenPage = { reachable: text.length > 5, textLen: text.length };
  } catch (error) {
    report.forbiddenPage = { reachable: false, error: String(error).split('\n')[0] };
  }
} catch (error) {
  report.login.error = String(error).split('\n')[0];
} finally {
  await browser.close();
}

fs.writeFileSync(
  path.join(OUT_DIR, 'report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
);

console.log('=== 管理后台 UI 冒烟结果 ===');
console.log(`登录：${report.login.ok ? '成功 → ' + report.login.landedOn : '失败 ' + report.login.error}`);
for (const item of report.routes) {
  const flag = item.status === 'ok' ? '✓' : '✗';
  console.log(`  ${flag} ${item.path.padEnd(20)} ${item.name.padEnd(8)} ${item.status}${item.note ? ' · ' + item.note : ''}`);
  for (const col of item.columnReport ?? []) {
    if (!col.found) continue;
    console.log(`        列「${col.column}」：${col.nonEmpty}/${col.rows} 行有值`);
  }
}

console.log('=== 第三轮专项检查 ===');
for (const item of report.checks) {
  const flag = item.status === 'pass' ? 'PASS' : 'FAIL';
  console.log(`  [${flag}] ${item.area} — ${item.note ?? ''}`);
}

console.log(`console error：${report.consoleErrors.length}  未捕获异常：${report.pageErrors.length}  失败请求(>=400)：${report.failedRequests.length}`);
for (const item of report.consoleErrors.slice(0, 8)) console.log(`  [console] ${item.text}`);
for (const item of report.pageErrors.slice(0, 8)) console.log(`  [pageerror] ${item.message}`);
for (const item of report.failedRequests.slice(0, 12)) console.log(`  [http ${item.status}] ${item.method} ${item.path}`);
console.log(`截图目录：${OUT_DIR}`);

const failedRoutes = report.routes.filter((r) => r.status !== 'ok');
const failedChecks = report.checks.filter((c) => c.status !== 'pass');
const issueCount = report.consoleErrors.length + report.pageErrors.length + report.failedRequests.length;
process.exit(
  report.login.ok && failedRoutes.length === 0 && failedChecks.length === 0 && issueCount === 0 ? 0 : 1,
);
