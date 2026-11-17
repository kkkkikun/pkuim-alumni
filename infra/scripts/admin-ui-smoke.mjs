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

fs.mkdirSync(OUT_DIR, { recursive: true });

const report = {
  base: BASE,
  login: { ok: false, error: null },
  routes: [],
  consoleErrors: [],
  failedRequests: [],
  pageErrors: [],
};

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
console.log(`console error：${report.consoleErrors.length}  未捕获异常：${report.pageErrors.length}  失败请求(>=400)：${report.failedRequests.length}`);
for (const item of report.consoleErrors.slice(0, 8)) console.log(`  [console] ${item.text}`);
for (const item of report.pageErrors.slice(0, 8)) console.log(`  [pageerror] ${item.message}`);
for (const item of report.failedRequests.slice(0, 12)) console.log(`  [http ${item.status}] ${item.method} ${item.path}`);
console.log(`截图目录：${OUT_DIR}`);

const failedRoutes = report.routes.filter((r) => r.status !== 'ok');
const issueCount = report.consoleErrors.length + report.pageErrors.length + report.failedRequests.length;
process.exit(report.login.ok && failedRoutes.length === 0 && issueCount === 0 ? 0 : 1);
