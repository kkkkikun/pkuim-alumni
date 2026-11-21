#!/usr/bin/env node
/**
 * **公开读端点的可见性口径**对账（登记表 ↔ 实现 ↔ 文档）。
 *
 * 背景（第十一轮）：
 *   `docs/DATABASE-DESIGN.md`「未审核内容公开」与
 *   `docs/KNOWN-ISSUES.md`「已知设计取舍」第 2 条定的口径是：
 *     - **未审核 / 未发布的内容**在公开读端点上**不可见**；
 *     - 「不可见」一律返回 **404**（而不是 403）——
 *       403 会通过状态码泄露「这个对象存在」，
 *       404 才是「不存在 / 看不见」的标准口径。
 *   这条口径此前**只被人工抽查过两轮**（第十轮抽查 articles / notices /
 *   resources / 通讯录，发现 `GET /events/:id` 漏了过滤，记为 #197）。
 *   人工抽查的性质决定了它**必然漏**：新增一个公开读端点、
 *   或把某个端点的过滤条件删掉，**没有任何机制会报警**。
 *
 * 本脚本把这条口径做成**自动化对账**，四件事：
 *   R1 **覆盖**：扫**全部控制器**里标了 `@Public()` 的 **GET** 端点 ——
 *      每一个都必须在本脚本的登记表里（口径没人想过 = 漏登记 → 报错）；
 *   R2 **落地**：登记表里写明的**可见性过滤痕迹**必须真的出现在实现里 ——
 *      把某个端点的过滤删掉（等于让未发布内容凭 id 就能公开读到）必须被抓出；
 *   R3 **状态码**：不可见的对象必须落到 **404 `NOT_FOUND`**
 *      （用成 403 就把「存在性」泄露出去了）；
 *   R4 **文档**：`docs/API-SPEC.md` 的「读端点的可见性口径」小节必须**逐条**点名
 *      每个公开读端点与它的不可见状态码 —— 对外契约不能只存在于代码里。
 *   R5 **待拍板**：口径尚未拍板的端点（#197 / #198）必须仍然**记在**
 *      `docs/KNOWN-ISSUES.md` 里；一旦有人把它**悄悄改掉**（实现变了、
 *      登记表没变），必须被抓出来（`READ_VISIBILITY_REGISTRY_STALE`）。
 *
 * ⚠️ 口径与局限（写在这里，免得被当成万能护栏）：
 *   - 判定是**静态**的：看源码里有没有「可见性过滤 + 抛 404」的形态，
 *     不执行代码、不连数据库。真值由集成测试
 *     （`apps/api/test/integration/public-read-visibility.e2e-spec.ts`）守着。
 *   - 「可见性过滤痕迹」是**字符串**判定：登记表里写明的痕迹必须出现在实现里，
 *     改写代码却不改登记表会被判成不一致 —— 这是**故意的**：
 *     宁可吵，也不要让「口径与实现分叉」悄悄发生。
 *   - `@Public()` 的**写**端点不在本脚本范围内（那是错误语义对账
 *     `check-error-semantics.mjs` 的地盘）。
 *
 * 用法：
 *   node infra/scripts/check-read-visibility.mjs [--root <repo>] [--json]
 *
 * 退出码：0 = 一致；1 = 存在不一致。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/* ------------------------------ 参数 ------------------------------ */

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const AS_JSON = args.includes('--json');

/** 仓库根目录（惰性求值，便于被别的脚本 import）。 */
function root() {
  return path.resolve(argValue('--root', process.cwd()));
}

/* ------------------------------ 登记表 ------------------------------ */

/**
 * **公开读端点的可见性口径登记表** —— 「已对账」的唯一事实来源。
 *
 * 每条必须写清：
 *   - `path` / `method`：对外路径（**不含** `/api/v1` 前缀，与 API-SPEC 一致）；
 *   - `impl`：可见性过滤发生在哪个文件的哪个方法里；
 *   - `filterMarkers`：**可见性过滤**的痕迹（缺一个即报 `READ_VISIBILITY_FILTER_MISSING`）；
 *   - `statusMarkers`：不可见时抛的异常（`NotFoundException` = 404 /
 *     `ForbiddenException` = 403）—— 用错就是「泄露存在性」；
 *   - `docToken`：文档那一行里必须出现的口径词（'404' / '列表' / '公开' / '待拍板'）；
 *   - `pending`：**口径待产品拍板**时，指向 `docs/KNOWN-ISSUES.md` 的条目号。
 *
 * ⚠️ 为什么 `GET /events/:id` 是 `pending` 而不是「补上过滤」：
 *    把它改成 404 是**对外契约变更**（公开端点的响应从 200 变 404），
 *    按仓库约定「对外契约变更先确认再动」，第十轮只记录（#197）、
 *    第十一轮仍**无产品结论** —— 所以既不改行为，也不假装它已经合规：
 *    本脚本对它断言的是「**尚未拍板的那部分不得被悄悄改掉**」
 *    （实现里一旦出现过滤痕迹，登记表就过期了 → 报错要求更新登记表与文档）。
 */
const READ_VISIBILITY_REGISTRY = [
  /* ------------------------- 内容（资讯 / 公告） ------------------------- */
  {
    method: 'GET',
    path: '/articles',
    controller: 'apps/api/src/modules/content/content.controller.ts',
    handler: 'listArticles',
    impl: { file: 'apps/api/src/modules/content/content.service.ts', method: 'listArticles' },
    visibility: '列表只含已发布',
    invisibleStatus: null,
    rule: "列表固定 `status='published'` —— 未发布的内容**根本不出现在列表里**",
    filterMarkers: ["article.status = :status", "params.status ?? 'published'"],
    statusMarkers: [],
    docToken: '列表',
  },
  {
    method: 'GET',
    path: '/articles/categories',
    controller: 'apps/api/src/modules/content/content.controller.ts',
    handler: 'listCategories',
    impl: { file: 'apps/api/src/modules/content/content.service.ts', method: 'listCategories' },
    visibility: '分类恒公开',
    invisibleStatus: null,
    rule: '分类目录本身公开；每类的文章数**只统计已发布**（草稿数属于内部信息）',
    filterMarkers: ["status: 'published'"],
    statusMarkers: [],
    docToken: '公开',
  },
  {
    method: 'GET',
    path: '/articles/:id',
    controller: 'apps/api/src/modules/content/content.controller.ts',
    handler: 'articleDetail',
    impl: { file: 'apps/api/src/modules/content/content.service.ts', method: 'articleDetail' },
    visibility: '仅已发布可见',
    invisibleStatus: 404,
    rule: "`status !== 'published'` → **404**（与「不存在」同一个答案，不泄露存在性）",
    filterMarkers: ["status !== 'published'"],
    statusMarkers: ['NotFoundException'],
    docToken: '404',
  },
  {
    method: 'GET',
    path: '/notices',
    controller: 'apps/api/src/modules/content/content.controller.ts',
    handler: 'listNotices',
    impl: { file: 'apps/api/src/modules/content/content.service.ts', method: 'listNotices' },
    visibility: '列表只含已发布',
    invisibleStatus: null,
    rule: "列表固定 `status='published'`",
    filterMarkers: ["notice.status = :status", "params.status ?? 'published'"],
    statusMarkers: [],
    docToken: '列表',
  },
  {
    method: 'GET',
    path: '/notices/:id',
    controller: 'apps/api/src/modules/content/content.controller.ts',
    handler: 'noticeDetail',
    impl: { file: 'apps/api/src/modules/content/content.service.ts', method: 'noticeDetail' },
    visibility: '仅已发布可见',
    invisibleStatus: 404,
    rule: "`status !== 'published'` → **404**",
    filterMarkers: ["status !== 'published'"],
    statusMarkers: ['NotFoundException'],
    docToken: '404',
  },
  {
    method: 'GET',
    path: '/home/feed',
    controller: 'apps/api/src/modules/content/content.controller.ts',
    handler: 'homeFeed',
    impl: { file: 'apps/api/src/modules/content/content.service.ts', method: 'homeFeed' },
    visibility: '聚合只含已发布',
    invisibleStatus: null,
    rule: '首页聚合的资讯 / 公告 / 公告条**全部来自已发布集合**',
    filterMarkers: ['listArticles', 'listNotices', "status: 'published'"],
    statusMarkers: [],
    docToken: '聚合',
  },

  /* ----------------------------- 活动 ----------------------------- */
  {
    method: 'GET',
    path: '/events',
    controller: 'apps/api/src/modules/events/events.controller.ts',
    handler: 'list',
    impl: { file: 'apps/api/src/modules/events/events.service.ts', method: 'list' },
    visibility: '列表只含已发布',
    invisibleStatus: null,
    rule: "列表固定 `status='published'`",
    filterMarkers: ["event.status = :status", "params.status ?? 'published'"],
    statusMarkers: [],
    docToken: '列表',
  },
  {
    method: 'GET',
    path: '/events/:id',
    controller: 'apps/api/src/modules/events/events.controller.ts',
    handler: 'detail',
    impl: { file: 'apps/api/src/modules/events/events.service.ts', method: 'detail' },
    visibility: '**口径待拍板**（#197）',
    invisibleStatus: null,
    rule:
      '当前**不过滤** `status`（草稿 / 已关闭的活动凭 id 就能公开读到）—— ' +
      '改成 404 属对外契约变更，需产品拍板（KNOWN-ISSUES #197）',
    filterMarkers: [],
    statusMarkers: ['NotFoundException'],
    docToken: '待拍板',
    pending: '197',
    /** 待拍板项一旦出现可见性过滤痕迹，说明行为已被改掉 → 登记表过期 */
    pendingFilterMarkers: ["status !== 'published'", "status === 'published'"],
  },

  /* --------------------------- 资源与需求 --------------------------- */
  {
    method: 'GET',
    path: '/resources',
    controller: 'apps/api/src/modules/resources/resources.controller.ts',
    handler: 'list',
    impl: { file: 'apps/api/src/modules/resources/resources.service.ts', method: 'listPublic' },
    visibility: '列表只含已审核通过',
    invisibleStatus: null,
    rule: "列表固定 `status='published'`（未审核内容一律不进公开列表）",
    filterMarkers: ["post.status = :status", "status: 'published'"],
    statusMarkers: [],
    docToken: '列表',
  },
  {
    method: 'GET',
    path: '/resources/:id',
    controller: 'apps/api/src/modules/resources/resources.controller.ts',
    handler: 'detail',
    impl: { file: 'apps/api/src/modules/resources/resources.service.ts', method: 'detail' },
    visibility: '仅已发布可见（作者与管理员除外）',
    invisibleStatus: 404,
    rule: '未发布且**非作者 / 非管理员** → **404**',
    filterMarkers: ["post.status === 'published'"],
    statusMarkers: ['NotFoundException'],
    docToken: '404',
  },

  /* ---------------------------- 通讯录名片 ---------------------------- */
  {
    method: 'GET',
    path: '/alumni/:id',
    controller: 'apps/api/src/modules/alumni/alumni.controller.ts',
    handler: 'profile',
    impl: { file: 'apps/api/src/modules/directory/directory.service.ts', method: 'detail' },
    visibility: '仅已认证且授权公开者可见',
    invisibleStatus: 404,
    rule:
      "未认证（`stage !== 'verified'`）、账号停用、或 `show_in_directory=0` → **404**" +
      '（KNOWN-ISSUES「已知设计取舍」第 2 条：不用 403，避免泄露存在性）',
    filterMarkers: ["user.stage !== 'verified'", 'profile.showInDirectory'],
    statusMarkers: ['NotFoundException'],
    docToken: '404',
  },

  /* ------------------------- 系统（字典 / 探针） ------------------------- */
  {
    method: 'GET',
    path: '/system/regions',
    controller: 'apps/api/src/modules/system/system.controller.ts',
    handler: 'listRegions',
    impl: { file: 'apps/api/src/modules/system/system.controller.ts', method: 'listRegions' },
    visibility: '恒公开',
    invisibleStatus: null,
    rule: '地区字典恒公开；其中的校友计数**只统计已认证且公开的校友**',
    filterMarkers: ["showInDirectory = :visible", "stage: 'verified'"],
    statusMarkers: [],
    docToken: '公开',
  },
  {
    method: 'GET',
    path: '/system/industries',
    controller: 'apps/api/src/modules/system/system.controller.ts',
    handler: 'listIndustries',
    impl: { file: 'apps/api/src/modules/system/system.controller.ts', method: 'listIndustries' },
    visibility: '恒公开',
    invisibleStatus: null,
    rule: '行业字典恒公开；计数口径同地区字典',
    filterMarkers: ["showInDirectory = :visible", "stage: 'verified'"],
    statusMarkers: [],
    docToken: '公开',
  },
  {
    method: 'GET',
    path: '/system/settings',
    controller: 'apps/api/src/modules/system/system.controller.ts',
    handler: 'listSettings',
    impl: { file: 'apps/api/src/modules/system/system.controller.ts', method: 'listSettings' },
    visibility: '恒公开',
    invisibleStatus: null,
    rule: '系统设置项恒公开（`system_settings` 没有可见性列，表中各项都是公开项）',
    filterMarkers: [],
    statusMarkers: [],
    docToken: '公开',
  },
  {
    method: 'GET',
    path: '/system/health',
    controller: 'apps/api/src/modules/system/system.controller.ts',
    handler: 'health',
    impl: { file: 'apps/api/src/modules/system/system.controller.ts', method: 'health' },
    visibility: '恒公开',
    invisibleStatus: null,
    rule: '健康检查恒公开；**只返回依赖连通性**，不泄露内部拓扑',
    filterMarkers: [],
    statusMarkers: [],
    docToken: '公开',
  },
  {
    method: 'GET',
    path: '/healthz',
    controller: 'apps/api/src/app.controller.ts',
    handler: 'health',
    impl: { file: 'apps/api/src/app.controller.ts', method: 'health' },
    visibility: '恒公开',
    invisibleStatus: null,
    rule: '存活探针恒公开',
    filterMarkers: [],
    statusMarkers: [],
    docToken: '公开',
  },
];

/* ------------------------------ 工具 ------------------------------ */

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 列出仓库里全部控制器文件（相对路径）。 */
function listControllerFiles() {
  const dir = path.join(root(), 'apps/api/src');
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.controller.ts')) {
        found.push(path.relative(root(), full).split(path.sep).join('/'));
      }
    }
  };
  walk(dir);
  return found.sort();
}

/** 把控制器前缀与路由拼成对外路径（`/api/v1` 前缀不算在内）。 */
function joinPath(prefix, route) {
  const head = prefix ? `/${prefix}` : '';
  const tail = route ? `/${route}` : '';
  const joined = `${head}${tail}`;
  return joined === '' ? '/' : joined.replace(/\/+$/, '') || '/';
}

/**
 * 找出某个控制器文件里**全部** `@Public()` 的 GET 端点。
 *
 * ⚠️ `@Public()` 与 `@Get(...)` 的**先后顺序不固定**：
 *    多数控制器是 `@Public()` 在前（`content.controller.ts`），
 *    `alumni.controller.ts` 却是 `@Get(':id')` 在前、`@Public()` 在后 ——
 *    只按一种顺序扫会**漏掉**一半公开读端点，R1 也就成了恒过的。
 *    所以这里把 `@Get(...)` **上下**紧邻的装饰器块**一起**看。
 */
function findPublicGetEndpoints(src) {
  const lines = src.split('\n');
  const endpoints = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^\s*@Get\(/.test(line)) continue;

    const decorators = [];
    for (let j = index - 1; j >= 0; j -= 1) {
      const text = lines[j].trim();
      if (text.startsWith('@')) decorators.unshift(text);
      else break;
    }
    for (let j = index + 1; j < lines.length; j += 1) {
      const text = lines[j].trim();
      if (text.startsWith('@')) decorators.push(text);
      else break;
    }
    if (!decorators.some((item) => item.startsWith('@Public'))) continue;

    const matched = /@Get\(\s*'([^']*)'\s*\)/.exec(line);
    endpoints.push({ route: matched ? matched[1] : '', line: index + 1 });
  }
  return endpoints;
}

/** 控制器前缀（`@Controller('events')` → `events`；`@Controller()` → 空）。 */
function controllerPrefix(src) {
  const matched = /@Controller\(\s*(?:'([^']*)')?\s*\)/.exec(src);
  return matched && matched[1] ? matched[1] : '';
}

/**
 * 取某个方法体（含它**调用**的同类私有方法）。
 *
 * 形态 2 必须一起看：`listCategories` 自己不含 `'published'` 字样，
 * 真正做过滤的是它调用的 `publishedArticleCounts` ——
 * 只看调用方会把「明明有过滤」判成「没有过滤」。
 */
function collectMethods(src) {
  const methods = [];
  const re =
    /^\s{2}(?:(?:public|private|protected|static|async|readonly|override)\s+)*([A-Za-z_$][\w$]*)(?:<[^>]*>)?\s*\(/gm;
  let match;
  while ((match = re.exec(src)) !== null) {
    const name = match[1];
    if (['if', 'for', 'while', 'switch', 'catch', 'constructor', 'return'].includes(name)) continue;
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close < 0) continue;
    const brace = findBodyBrace(src, close);
    if (brace < 0) continue;
    let bodyDepth = 0;
    let end = -1;
    for (let j = brace; j < src.length; j += 1) {
      const ch = src[j];
      if (ch === '{') bodyDepth += 1;
      else if (ch === '}') {
        bodyDepth -= 1;
        if (bodyDepth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) continue;
    methods.push({ name, body: src.slice(brace, end + 1) });
    re.lastIndex = brace;
  }
  return methods;
}

/** 从参数表右括号往后找**方法体的起始 `{`**（跳过返回类型里的花括号）。 */
function findBodyBrace(src, close) {
  let angleDepth = 0;
  for (let i = close + 1; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '<') angleDepth += 1;
    else if (ch === '>') angleDepth = Math.max(0, angleDepth - 1);
    else if (ch === '{' && angleDepth === 0) return i;
    else if (ch === ';' && angleDepth === 0) return -1;
  }
  return -1;
}

/** 方法体 + 它调用的同类方法体。 */
function effectiveBody(file, methodName) {
  const src = readTextSafe(path.join(root(), file));
  if (!src) return { ok: false, reason: `文件不存在：${file}` };
  const methods = collectMethods(src);
  const target = methods.find((method) => method.name === methodName);
  if (!target) return { ok: false, reason: `${file} 里找不到方法 ${methodName}` };
  let body = target.body;
  const used = new Set([target.name]);
  for (let round = 0; round < 3; round += 1) {
    for (const other of methods) {
      if (used.has(other.name)) continue;
      if (!new RegExp(`this\\.${other.name}\\s*\\(`).test(body)) continue;
      used.add(other.name);
      body += `\n${other.body}`;
    }
  }
  return { ok: true, where: `${file} · ${methodName}`, body };
}

/**
 * 取 `docs/API-SPEC.md` 里「读端点的可见性口径」小节的正文行。
 *
 * 取不到 = 口径没写 = 报错（宁可吵，也不要默默放过）。
 */
function visibilityDocLines() {
  const src = readTextSafe(path.join(root(), 'docs/API-SPEC.md'));
  if (!src) return null;
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const heading = /^(#{2,4})\s/.exec(line);
    if (!heading) continue;
    if (!line.includes('可见性')) continue;
    const level = heading[1].length;
    // ⚠️ 口径表放在**子小节**里（`### 13.1 逐个公开读端点`），
    //    只取到下一个**同级或更高级**的标题为止，否则表格会被漏掉 ——
    //    漏掉的后果是「文档里其实写了，检查器却报没写」。
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = /^(#{2,4})\s/.exec(lines[j]);
      if (next && next[1].length <= level) {
        end = j;
        break;
      }
    }
    return lines.slice(i, end);
  }
  return null;
}

/**
 * 取「读端点的可见性口径」小节里的**口径表行**。
 *
 * ⚠️ 必须按**单元格**判定，不能只按「这一行里出现过这个路径」：
 *    说明列里常出现「同 `/articles/:id`」这样的**引用**，
 *    只按子串匹配的话，删掉 `/articles/:id` 那一行之后，
 *    引用它的那一行仍会被当成「写过了」→ 校验器变成恒过的。
 *    所以这里只认「路径所在单元格**就是**这个路径」的行。
 */
function visibilityDocRows() {
  const lines = visibilityDocLines();
  if (!lines) return null;
  const rows = [];
  for (const line of lines) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 3) continue;
    if (/^-+$/.test(cells[1]) || /^-+$/.test(cells[2])) continue;
    const method = cells[1].replace(/[`*]/g, '').trim();
    const path = cells[2].replace(/[`*]/g, '').trim();
    if (!method || !path) continue;
    rows.push({ method, path, text: line });
  }
  return rows;
}

/** 取 `docs/KNOWN-ISSUES.md` 里某个编号的条目正文。 */
function knownIssueSection(number) {
  const src = readTextSafe(path.join(root(), 'docs/KNOWN-ISSUES.md'));
  if (!src) return null;
  const lines = src.split('\n');
  const headingRe = new RegExp(`^#{2,4}\\s*${number}\\.`);
  for (let i = 0; i < lines.length; i += 1) {
    if (!headingRe.test(lines[i])) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^#{2,4}\s/.test(lines[j])) {
        end = j;
        break;
      }
    }
    return lines.slice(i, end).join('\n');
  }
  return null;
}

/* ------------------------------ 主流程 ------------------------------ */

function main() {
  const issues = [];
  const notes = [];

  /* --- 发现端：全部 `@Public()` 的 GET 端点 ------------------------------ */
  const discovered = [];
  for (const file of listControllerFiles()) {
    const src = readTextSafe(path.join(root(), file));
    if (!src) continue;
    const prefix = controllerPrefix(src);
    for (const endpoint of findPublicGetEndpoints(src)) {
      discovered.push({
        method: 'GET',
        path: joinPath(prefix, endpoint.route),
        file,
        line: endpoint.line,
      });
    }
  }
  const registryKeys = new Set(
    READ_VISIBILITY_REGISTRY.map((item) => `${item.method} ${item.path}`),
  );

  /* --- R1：每个公开读端点都必须登记 ------------------------------------- */
  for (const item of discovered) {
    const key = `${item.method} ${item.path}`;
    if (registryKeys.has(key)) continue;
    issues.push({
      kind: 'READ_VISIBILITY_NOT_REGISTERED',
      where: key,
      detail:
        `这是一个**公开读端点**（${item.file}:${item.line}），但可见性口径没有登记 —— ` +
        '「不可见的对象返回什么」必须先想清楚（404 还是 403），再上线',
    });
  }

  /* --- R5：登记了的端点必须还在（端点被删 / 改名 / 换了控制器） ------------ */
  for (const entry of READ_VISIBILITY_REGISTRY) {
    const key = `${entry.method} ${entry.path}`;
    const found = discovered.find((item) => `${item.method} ${item.path}` === key);
    if (!found) {
      issues.push({
        kind: 'READ_VISIBILITY_ROUTE_MISSING',
        where: key,
        detail:
          `登记表里的公开读端点 ${key} 在代码里**找不到了** —— ` +
          '要么端点被删 / 改名（登记表该更新），要么它不再是公开的（口径该重判）',
      });
      continue;
    }
    if (entry.controller && found.file !== entry.controller) {
      issues.push({
        kind: 'READ_VISIBILITY_CONTROLLER_MISMATCH',
        where: key,
        detail:
          `登记表说它在 \`${entry.controller}\` 的 ${entry.handler} 里，` +
          `实际却在 \`${found.file}\`（第 ${found.line} 行）—— ` +
          '端点被挪了位置，登记表该跟着更新（否则「口径挂在哪个处理器上」就说不清了）',
      });
    }
  }

  /* --- R2 / R3：口径落地 + 文档 ----------------------------------------- */
  const docLines = visibilityDocLines();
  const docRows = visibilityDocRows();
  if (!docLines) {
    issues.push({
      kind: 'READ_VISIBILITY_SECTION_MISSING',
      where: 'docs/API-SPEC.md',
      detail:
        'API-SPEC 里找不到「读端点的可见性口径」小节 —— ' +
        '哪些端点「不可见 → 404」、哪些「无权 → 403」必须写进对外契约',
    });
  }

  for (const entry of READ_VISIBILITY_REGISTRY) {
    const key = `${entry.method} ${entry.path}`;

    // R2：可见性过滤痕迹
    const impl = effectiveBody(entry.impl.file, entry.impl.method);
    if (!impl.ok) {
      issues.push({
        kind: 'READ_VISIBILITY_IMPL_MISSING',
        where: key,
        detail: `${impl.reason} —— 可见性口径无处核对`,
      });
    } else {
      const missing = (entry.filterMarkers ?? []).filter(
        (marker) => !impl.body.includes(marker),
      );
      if (missing.length) {
        issues.push({
          kind: 'READ_VISIBILITY_FILTER_MISSING',
          where: key,
          detail:
            `${impl.where} 里看不到可见性过滤的痕迹（缺 ${missing.join(' / ')}）—— ` +
            `${entry.rule}。删掉过滤 = 未发布 / 未审核的内容**凭 id 就能公开读到**`,
        });
      }
      const missingStatus = (entry.statusMarkers ?? []).filter(
        (marker) => !impl.body.includes(marker),
      );
      if (missingStatus.length) {
        issues.push({
          kind: 'READ_VISIBILITY_STATUS_MISMATCH',
          where: key,
          detail:
            `${impl.where} 里没有 ${missingStatus.join(' / ')} —— ` +
            `不可见的对象必须落到 **404**（用 403 会通过状态码泄露「这个对象存在」）。${entry.rule}`,
        });
      }
      // R5：待拍板项 —— 实现里一旦出现可见性过滤，说明行为已被改掉
      if (entry.pending) {
        const settled = (entry.pendingFilterMarkers ?? []).some((marker) =>
          impl.body.includes(marker),
        );
        if (settled) {
          issues.push({
            kind: 'READ_VISIBILITY_REGISTRY_STALE',
            where: key,
            detail:
              `该端点的口径此前**待拍板**（KNOWN-ISSUES #${entry.pending}），` +
              '但实现里**已经出现**了可见性过滤 —— 对外行为被改掉了：' +
              '要么是产品已拍板（请更新登记表与 API-SPEC，并把 KNOWN-ISSUES 的条目结掉），' +
              '要么是有人擅自改了行为（请改回去）',
          });
        }
      }
    }

    // R3：文档
    if (docRows) {
      const rows = docRows.filter(
        (row) => row.method === entry.method && row.path === entry.path,
      );
      if (!rows.length) {
        issues.push({
          kind: 'READ_VISIBILITY_UNDOCUMENTED',
          where: key,
          detail:
            `「读端点的可见性口径」小节里没有点名 ${key} —— ` +
            '对外契约不能只存在于代码里',
        });
      } else {
        const union = rows.map((row) => row.text).join('\n');
        if (!union.includes(entry.docToken)) {
          issues.push({
            kind: 'READ_VISIBILITY_UNDOCUMENTED',
            where: key,
            detail:
              `文档里没有写明「${entry.docToken}」：${rows.map((row) => row.trim()).join(' / ')}`,
          });
        } else {
          notes.push({
            kind: 'READ_VISIBILITY_OK',
            where: key,
            detail: `${entry.visibility}：${entry.rule}`,
          });
        }
      }
    }

    // R4：待拍板项必须在 KNOWN-ISSUES 里仍然记着
    if (entry.pending) {
      const section = knownIssueSection(entry.pending);
      if (!section) {
        issues.push({
          kind: 'READ_VISIBILITY_KNOWN_ISSUE_MISSING',
          where: key,
          detail:
            `KNOWN-ISSUES 里找不到 #${entry.pending} —— ` +
            '「口径待拍板」这件事必须仍然记着，否则这个端点的口径就没人管了',
        });
      } else if (!section.includes(entry.path)) {
        issues.push({
          kind: 'READ_VISIBILITY_KNOWN_ISSUE_MISSING',
          where: key,
          detail:
            `KNOWN-ISSUES 的 #${entry.pending} 里没有点名 ${entry.path} —— ` +
            '待拍板的条目必须指向具体的端点',
        });
      }
    }
  }

  const report = {
    publicReadEndpoints: discovered.length,
    registered: READ_VISIBILITY_REGISTRY.length,
    pending: READ_VISIBILITY_REGISTRY.filter((entry) => entry.pending).length,
    issues: issues.length,
    notes: notes.length,
    detail: issues,
    notesDetail: notes,
  };

  if (AS_JSON) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const note of notes) {
      process.stdout.write(`  [提示] ${note.where}：${note.detail}\n`);
    }
    if (issues.length === 0) {
      process.stdout.write(
        `✅ 公开读端点的可见性口径对账通过：` +
          `${report.publicReadEndpoints} 个公开读端点全部登记了可见口径，` +
          `每个都能在实现里看到对应的过滤与状态码，文档也逐条写明` +
          `（其中 ${report.pending} 个口径**待产品拍板**，已记在 KNOWN-ISSUES）\n`,
      );
    } else {
      for (const issue of issues) {
        process.stdout.write(`❌ [${issue.kind}] ${issue.where}\n     ${issue.detail}\n`);
      }
      process.stdout.write(`\n❌ 发现 ${issues.length} 处可见性口径不一致\n`);
    }
  }

  process.exit(issues.length > 0 ? 1 : 0);
}

main();
