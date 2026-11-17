#!/usr/bin/env node
/**
 * Swagger 声明参数 ↔ 实现是否真的消费 —— 对账校验器。
 *
 * 背景（缺陷 #59 / #63 的「另一半」）：
 *   管理端列表接口的查询 DTO 里声明了 N 个筛选条件，Swagger 也会如实列出这 N 个参数，
 *   但 handler 只把其中 2 个透传给 service —— 剩下 N-2 个**被静默丢弃**：
 *   请求照发、状态码 200、结果不受影响，筛选框看起来能用，实际上是个摆设。
 *
 *   这类缺陷不抛异常：
 *     - 响应结构校验只看「返回了什么」，不看「请求带了什么」；
 *     - 请求契约对账只看「客户端发了什么」，不看「服务端接了之后用没用」。
 *   所以必须单独一层：**服务端自己承诺的参数，到底有没有被真正用上**。
 *
 * 本脚本做两件事：
 *   1.【主检查·静态】解析控制器源码 + 查询 DTO（含继承链），逐个参数判断 handler
 *      是否真的消费它：
 *        - 一级：handler 里出现 `query.<prop>`，或从 query 解构出 <prop>；
 *        - 二级：handler 把 query **整体透传**给 service 或**控制器自己的私有方法**
 *                → 到那个方法体里继续追踪；
 *        - 三级：service / 私有方法再整体透传给另一个 service → 再追一层；
 *        - 仍追不到 → 记为「无法静态判定」的提示（**不判失败**，避免误报）。
 *   2.【副检查·需 Swagger】把 Swagger 实际声明的查询参数与 DTO 推导出的参数集对账，
 *      抓出「文档与 DTO 不同步」（例如 @ApiQuery 手工声明的额外参数）。
 *
 * 用法：
 *   node infra/scripts/check-swagger-param-usage.mjs --root <repo> \
 *        [--swagger http://127.0.0.1:18081/docs-json | --swagger-file <path>] [--json]
 *
 * 退出码：0 = 参数声明与实现一致；1 = 存在「声明了但没用」的参数。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/* ------------------------------ 参数 ------------------------------ */

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const ROOT = path.resolve(argValue('--root', process.cwd()));
const SWAGGER_URL = argValue('--swagger', '');
const SWAGGER_FILE = argValue('--swagger-file', '');
const AS_JSON = args.includes('--json');
const DEBUG = args.includes('--debug');

const API_SRC = path.join(ROOT, 'apps/api/src');

/**
 * 要检查的两类「对外声明的参数」。
 *   query → 查询参数：DTO 里声明了、Swagger 会公布，但 handler 可能根本不用
 *   body  → 请求体字段：DTO 里声明了，客户端会发，但服务端可能**校验了却不落库**
 *           （用户以为保存成功、实际没存 —— 同样不报错）
 */
const PARAM_KINDS = [
  { kind: 'query', decorator: 'Query', label: '查询参数' },
  { kind: 'body', decorator: 'Body', label: '请求体字段' },
];

/* ------------------------------ 基础工具 ------------------------------ */

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function walk(dir, out = [], filter = /\.(ts|tsx)$/) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      walk(full, out, filter);
    } else if (entry.isFile() && filter.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** 去掉注释（避免注释里的代码被当成真实实现） */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 括号匹配（字符串感知）。
 * openIndex 指向开括号，返回对应闭括号下标；找不到返回 -1。
 */
function matchBracket(src, openIndex) {
  const open = src[openIndex];
  const close = open === '{' ? '}' : open === '(' ? ')' : open === '[' ? ']' : null;
  if (!close) return -1;
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 按顶层分隔符切分（字符串 / 括号感知） */
function splitTopLevel(text, separator = ',') {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** 找到顶层冒号（类型注解分隔符） */
function findTopLevelColon(text) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}' || ch === '>') depth -= 1;
    else if (ch === ':' && depth === 0) return i;
  }
  return -1;
}

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i += 1) {
    if (src[i] === '\n') line += 1;
  }
  return line;
}

/* ------------------------------ 类 / 成员解析 ------------------------------ */

/** 解析出所有 `export class X`，返回类名、类体、类体起始下标 */
function parseClasses(src) {
  const classes = [];
  const re = /export\s+class\s+(\w+)/g;
  let match;
  while ((match = re.exec(src)) !== null) {
    const brace = src.indexOf('{', match.index + match[0].length);
    if (brace < 0) continue;
    const end = matchBracket(src, brace);
    if (end < 0) continue;
    classes.push({
      name: match[1],
      body: src.slice(brace + 1, end),
      bodyIndex: brace,
      endIndex: end,
    });
    // 注意：这里**不能**把 re.lastIndex 跳到类体末尾 ——
    // 同一个文件里往往有多个 DTO / Service 类，跳过就会漏掉后面的类。
  }
  return classes;
}

/**
 * 从 `start`（某个装饰器之后）解析一个类成员：
 * 跳过装饰器 → 方法名 → 参数列表 → 方法体。
 */
function parseMember(src, start) {
  let i = start;
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src[i] !== '@') break;
    i += 1;
    while (i < src.length && /[\w$]/.test(src[i])) i += 1;
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src[i] === '(') {
      const end = matchBracket(src, i);
      if (end < 0) return null;
      i = end + 1;
    }
  }
  const nameMatch = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
  if (!nameMatch) return null;
  let name = nameMatch[0];
  i += name.length;
  // `async` / `get` / `set` 是修饰前缀，后面才是真正的成员名
  if (name === 'async' || name === 'get' || name === 'set') {
    while (i < src.length && /\s/.test(src[i])) i += 1;
    const next = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
    if (!next) return null;
    name = next[0];
    i += name.length;
  }
  while (i < src.length && /\s/.test(src[i])) i += 1;
  if (src[i] !== '(') return null;
  const paramsEnd = matchBracket(src, i);
  if (paramsEnd < 0) return null;
  const paramsSrc = src.slice(i + 1, paramsEnd);

  // 方法体起点：跳过返回类型注解（可能带泛型）
  let j = paramsEnd;
  let angle = 0;
  let bodyStart = -1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '<') angle += 1;
    else if (ch === '>') angle -= 1;
    else if (ch === '(' || ch === '[') {
      const end = matchBracket(src, j);
      if (end < 0) break;
      j = end;
      continue;
    } else if (ch === '{' && angle <= 0) {
      bodyStart = j;
      break;
    } else if (ch === ';' && angle <= 0) break;
    // 注意：`;` 出现在**泛型返回类型**里（如 `Promise<{ a: string; b: string }>`）
    // 不能当成方法体结束 —— 否则整个方法会被解析丢弃（校验器会误报「参数没被消费」）。
    j += 1;
  }
  if (bodyStart < 0) return null;
  const bodyEnd = matchBracket(src, bodyStart);
  if (bodyEnd < 0) return null;

  return {
    name,
    paramsSrc,
    body: src.slice(bodyStart + 1, bodyEnd),
    bodyStart,
    bodyEnd,
    paramsStart: i,
  };
}

/** 解析单个参数：名字 / 类型 / 装饰器 */
function parseParam(text) {
  const colon = findTopLevelColon(text);
  const left = colon >= 0 ? text.slice(0, colon) : text;
  const type = colon >= 0 ? text.slice(colon + 1).trim() : '';
  const decorators = [];
  const decoratorRe = /@(\w+)\s*(\(([^()]*)\))?/g;
  let match;
  while ((match = decoratorRe.exec(left)) !== null) {
    decorators.push({ name: match[1], args: (match[3] ?? '').trim() });
  }
  const bare = left.replace(/@[\w.]+\s*(\([^()]*\))?/g, ' ').trim();
  const nameMatch = /([A-Za-z_$][\w$]*)\s*$/.exec(bare);
  return { name: nameMatch ? nameMatch[1] : '', type, decorators };
}

function parseParams(paramsSrc) {
  return splitTopLevel(paramsSrc, ',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map(parseParam);
}

/* ------------------------------ DTO 索引 ------------------------------ */

/** 类字段（只取「以分号结尾的字段声明」，getter / 方法不算） */
const FIELD_RE = /^[ \t]*(?:readonly\s+)?(?:public\s+|private\s+|protected\s+)?([A-Za-z_$][\w$]*)\??\s*:\s*[^;]*;/gm;

/**
 * 去掉类体里的**装饰器**（含跨行的 `@ApiPropertyOptional({ ... })`）。
 *
 * 为什么必须先剥：FIELD_RE 的 `[^;]*` 会跨行匹配，
 * 于是多行装饰器里的 `enum: [...]` 会被当成一个**字段声明**
 * （`enum` 被当成属性名）—— 校验器于是报出
 * 「查询参数 enum 在 XxxQueryDto 里声明，但服务端从未真正使用它」，
 * 而服务端根本没有任何名为 enum 的参数。
 */
function stripDecorators(body) {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '@' && /[A-Za-z_$]/.test(body[i + 1] ?? '')) {
      // 跳过标识符
      let j = i + 1;
      while (j < body.length && /[\w$]/.test(body[j])) j += 1;
      // 跳过（可能跨行、可能嵌套的）参数列表
      let k = j;
      while (k < body.length && /\s/.test(body[k])) k += 1;
      if (body[k] === '(') {
        const end = matchBracket(body, k);
        if (end > 0) j = end + 1;
      }
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function parseDtoClasses(files) {
  const dtos = new Map();
  for (const file of files) {
    const raw = readFileSafe(file);
    if (!raw) continue;
    const src = stripComments(raw);
    for (const cls of parseClasses(src)) {
      const props = [];
      let match;
      const classBody = stripDecorators(cls.body);
      FIELD_RE.lastIndex = 0;
      while ((match = FIELD_RE.exec(classBody)) !== null) {
        if (!props.includes(match[1])) props.push(match[1]);
      }
      const extendsMatch = new RegExp(
        `export\\s+class\\s+${cls.name}\\s+extends\\s+([\\w]+)`,
      ).exec(src);
      dtos.set(cls.name, {
        name: cls.name,
        props,
        parent: extendsMatch ? extendsMatch[1] : null,
        file: path.relative(ROOT, file),
      });
    }
  }
  return dtos;
}

/** 取 DTO（含父类）的全部字段名 */
function dtoProps(dtoName, dtos, seen = new Set()) {
  if (!dtoName || seen.has(dtoName)) return null;
  seen.add(dtoName);
  const def = dtos.get(dtoName);
  if (!def) return null;
  const names = new Set(def.props);
  if (def.parent) {
    const parentProps = dtoProps(def.parent, dtos, seen);
    if (parentProps) for (const name of parentProps) names.add(name);
  }
  return names;
}

/**
 * 解析**内联对象类型**的顶层字段名：
 *   { name: string; slug: string; sortOrder?: number } → ['name','slug','sortOrder']
 * 只取顶层字段 —— 嵌套对象的内部字段不算本层的参数。
 * 不是内联对象字面量时返回 null。
 */
function inlineTypeFields(type) {
  const text = (type ?? '').trim();
  if (!text.startsWith('{')) return null;
  const end = matchBracket(text, 0);
  if (end < 0) return null;
  const body = text.slice(1, end);
  const fields = [];
  let depth = 0;
  let pending = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '{' || ch === '(' || ch === '[') {
      depth += 1;
      continue;
    }
    if (ch === '}' || ch === ')' || ch === ']') {
      depth -= 1;
      continue;
    }
    if (ch === ':' && depth === 0) {
      const match = /([A-Za-z_$][\w$]*)\??\s*$/.exec(pending);
      if (match) fields.push(match[1]);
      pending = '';
      continue;
    }
    if (ch === ';' || ch === ',') {
      pending = '';
      continue;
    }
    pending += ch;
  }
  return fields;
}

/* ------------------------------ 控制器 / 服务索引 ------------------------------ */

const ROUTE_RE = /@(Get|Post|Put|Patch|Delete)\s*\(\s*(?:(['"`])([^'"`]*)\2)?\s*\)/g;

const METHOD_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'function', 'do',
  'else', 'await', 'delete', 'void', 'super', 'import', 'export', 'from', 'case', 'throw',
  'yield', 'instanceof', 'in', 'of', 'let', 'const', 'var', 'class', 'extends', 'implements',
  'interface', 'type', 'enum', 'constructor', 'get', 'set',
]);

/** 解析类里的方法（不含装饰器也行），返回 { name, params, body } */
function parseMethods(classBody) {
  const methods = new Map();
  const re = /(?:^|[^\w$.])((?:async\s+)?[A-Za-z_$][\w$]*)\s*\(/g;
  let match;
  while ((match = re.exec(classBody)) !== null) {
    const rawName = match[1].replace(/^async\s+/, '');
    if (METHOD_KEYWORDS.has(rawName)) continue;
    if (/^[A-Z]/.test(rawName)) continue; // 构造函数 / 类名
    const openIndex = match.index + match[0].length - 1;
    // parseMember 需要从**成员名**开始（它自己会读名字和左括号）
    const nameStart = match.index + match[0].lastIndexOf(match[1]);
    const member = parseMember(classBody, nameStart);
    if (!member) continue;
    methods.set(member.name, {
      name: member.name,
      params: parseParams(member.paramsSrc),
      body: member.body,
      bodyStart: member.bodyStart,
      bodyEnd: member.bodyEnd,
    });
    re.lastIndex = member.bodyEnd;
  }
  return methods;
}

/**
 * 构造器注入的属性：属性名 → 被注入的类名。
 *
 * 不依赖「类名必须以 Service 结尾」这种命名约定 ——
 * 否则换个类名就会追踪不到、进而误报成「参数没被消费」。
 * TypeORM 的 `Repository<T>` 注入被排除（它不是业务服务，也不接查询 DTO）。
 */
function parseServiceProps(classBody) {
  const props = new Map();
  const index = classBody.search(/(?:^|[^\w$.])constructor\s*\(/);
  if (index < 0) return props;
  const openIndex = classBody.indexOf('(', index);
  const end = matchBracket(classBody, openIndex);
  if (end < 0) return props;
  for (const param of parseParams(classBody.slice(openIndex + 1, end))) {
    if (!param.name || !param.type) continue;
    if (/^Repository</.test(param.type)) continue; // TypeORM 仓储，不是业务服务
    if (param.type.includes('<')) continue; // 其它泛型注入同理
    props.set(param.name, param.type);
  }
  return props;
}

function buildServerIndex() {
  const files = walk(API_SRC);
  const dtos = parseDtoClasses(files);
  const controllers = [];
  const services = new Map(); // 类名 → { methods: Map, serviceProps: Map }

  for (const file of files) {
    const raw = readFileSafe(file);
    if (!raw) continue;
    const src = stripComments(raw);
    const relative = path.relative(ROOT, file);

    // 控制器前缀（@Controller('xxx')）——用于报告里显示完整路径
    const prefixes = [];
    if (/\.controller\.ts$/.test(file)) {
      const prefixRe = /@Controller\s*\(\s*(['"`])([^'"`]*)\1\s*\)/g;
      let prefixMatch;
      while ((prefixMatch = prefixRe.exec(src)) !== null) {
        prefixes.push({ value: prefixMatch[2], index: prefixMatch.index });
      }
    }

    for (const cls of parseClasses(src)) {
      if (/\.controller\.ts$/.test(file)) {
        const serviceProps = parseServiceProps(cls.body);
        // 控制器**自己类内**的方法（含私有辅助方法）——
        // handler 常把 body 整体交给 `this.someHelper(body)`，消费发生在那里。
        const ownMethods = parseMethods(cls.body);
        let prefix = '';
        for (const item of prefixes) {
          if (item.index < cls.bodyIndex) prefix = item.value;
        }
        ROUTE_RE.lastIndex = 0;
        let match;
        while ((match = ROUTE_RE.exec(cls.body)) !== null) {
          const member = parseMember(cls.body, match.index + match[0].length);
          if (!member) continue;
          const route = match[3] ?? '';
          const httpMethod = match[1].toUpperCase();
          const fullPath = `/${prefix}/${route}`.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
          const params = parseParams(member.paramsSrc);
          const queryParam = params.find((p) =>
            p.decorators.some((d) => d.name === 'Query' && d.args === ''),
          );
          controllers.push({
            className: cls.name,
            methodName: member.name,
            httpMethod,
            route,
            fullPath,
            params,
            queryParam: queryParam ?? null,
            body: member.body,
            bodyStart: member.bodyStart,
            serviceProps,
            ownMethods,
            file: relative,
            line: lineOf(src, cls.bodyIndex + member.bodyStart),
          });
          ROUTE_RE.lastIndex = member.bodyEnd;
        }
      }

      // 所有类都登记为「可被追踪的目标」——
      // 控制器注入的类名不必以 Service 结尾，且注入的类可能不在 *.service.ts 里。
      services.set(cls.name, {
        className: cls.name,
        methods: parseMethods(cls.body),
        serviceProps: parseServiceProps(cls.body),
        file: relative,
      });
    }
  }

  return { dtos, controllers, services };
}

/* ------------------------------ 消费判定 ------------------------------ */

/** body 里是否出现 `var.prop`（含可选链 / 下标写法） */
function usesProp(body, varName, prop) {
  if (!varName) return false;
  const re = new RegExp(`\\b${escapeRe(varName)}\\s*\\??\\s*\\.\\s*${escapeRe(prop)}\\b`);
  if (re.test(body)) return true;
  // 下标写法：query['keyword']
  const bracketRe = new RegExp(
    `\\b${escapeRe(varName)}\\s*\\??\\s*\\[\\s*['"\`]${escapeRe(prop)}['"\`]\\s*\\]`,
  );
  if (bracketRe.test(body)) return true;
  // 从 var 解构：const { a, b } = var
  const destructureRe = new RegExp(`\\{([^}]*)\\}\\s*=\\s*${escapeRe(varName)}\\b`, 'g');
  let match;
  while ((match = destructureRe.exec(body)) !== null) {
    const names = match[1]
      .split(',')
      .map((item) => item.split(':').pop().split('=')[0].trim().replace(/^\.\.\./, ''))
      .filter(Boolean);
    if (names.includes(prop)) return true;
  }
  return false;
}

/** body 里是否把 var **整体**用掉了（整体透传 / 展开 / 传参） */
function usesVarWholesale(body, varName) {
  if (!varName) return false;
  const stripped = body
    .replace(new RegExp(`\\b${escapeRe(varName)}\\s*\\??\\s*\\.\\s*\\w+`, 'g'), ' ')
    .replace(new RegExp(`\\b${escapeRe(varName)}\\s*\\??\\s*\\[\\s*['"\`][^'"\`]*['"\`]\\s*\\]`, 'g'), ' ');
  return new RegExp(`\\b${escapeRe(varName)}\\b`).test(stripped);
}

/** 在 body 里找出所有 `this.<serviceProp>.<method>(...)` 调用 */
function findServiceCalls(body, serviceProps) {
  const calls = [];
  const re = /this\.(\w+)\.(\w+)\s*\(/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    const prop = match[1];
    if (!serviceProps.has(prop)) continue;
    const openIndex = match.index + match[0].length - 1;
    const closeIndex = matchBracket(body, openIndex);
    if (closeIndex < 0) continue;
    const args = splitTopLevel(body.slice(openIndex + 1, closeIndex), ',').map((a) => a.trim());
    calls.push({ prop, method: match[2], args, className: serviceProps.get(prop) });
    re.lastIndex = closeIndex;
  }
  return calls;
}

/**
 * 在 body 里找出 `this.<ownMethod>(...)` 调用 —— 控制器**自己类内**的私有辅助方法。
 *
 * 这一层是必须的（校验器盲点）：
 *   handler 把 body 整体交给 `this.setUserStatus(actor, id, body)`，
 *   真正消费字段的是那个私有方法体。
 *   只认 service 的话，这类调用会被当成「传给了未知目标」→ 误报成「参数没被消费」。
 */
function findOwnMethodCalls(body, ownMethods) {
  const calls = [];
  if (!ownMethods || ownMethods.size === 0) return calls;
  const re = /this\.(\w+)\s*\(/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    const name = match[1];
    if (!ownMethods.has(name)) continue;
    const openIndex = match.index + match[0].length - 1;
    const closeIndex = matchBracket(body, openIndex);
    if (closeIndex < 0) continue;
    const args = splitTopLevel(body.slice(openIndex + 1, closeIndex), ',').map((a) => a.trim());
    calls.push({ name, args, methodObj: ownMethods.get(name) });
    re.lastIndex = closeIndex;
  }
  return calls;
}

/**
 * 沿 service / 控制器私有方法链追踪某个字段是否被真正使用。
 * 返回 'used' | 'unused' | 'unknown'
 */
function traceThroughServices(scope, varName, prop, depth, services, seen) {
  if (depth > 2) return 'unknown';
  const serviceCalls = findServiceCalls(scope.body, scope.serviceProps ?? new Map());
  const ownCalls = findOwnMethodCalls(scope.body, scope.ownMethods);

  // 把两类调用统一成「可追踪目标」
  const targets = [];
  const results = [];
  for (const call of serviceCalls) {
    const service = services.get(call.className);
    const method = service?.methods.get(call.method);
    if (!method) {
      // 找到了调用但解析不出目标方法体 → 判不了，不能当成「没用」
      results.push('unknown');
      continue;
    }
    targets.push({
      key: `${call.className}.${call.method}`,
      method,
      args: call.args,
      nextScope: { body: method.body, serviceProps: service.serviceProps, ownMethods: null },
    });
  }
  for (const call of ownCalls) {
    targets.push({
      key: `${scope.className ?? 'controller'}.${call.name}`,
      method: call.methodObj,
      args: call.args,
      nextScope: {
        body: call.methodObj.body,
        serviceProps: scope.serviceProps,
        ownMethods: scope.ownMethods,
      },
    });
  }

  for (const target of targets) {
    const argIndex = target.args.findIndex(
      (arg) => arg === varName || new RegExp(`\\.\\.\\.${escapeRe(varName)}\\b`).test(arg),
    );
    if (argIndex < 0) continue;
    if (argIndex >= target.method.params.length) {
      results.push('unknown');
      continue;
    }
    const bound = target.method.params[argIndex].name;
    if (!bound) continue;

    const seenKey = `${target.key}#${bound}`;
    if (seen.has(seenKey)) {
      results.push('unknown');
      continue;
    }
    seen.add(seenKey);

    if (usesProp(target.method.body, bound, prop)) {
      results.push('used');
      continue;
    }
    if (DEBUG) {
      console.error(
        `  [debug] trace ${target.key} target=${bound} prop=${prop} ` +
          `snippet=${JSON.stringify(target.method.body.slice(0, 160))}`,
      );
    }
    if (usesVarWholesale(target.method.body, bound)) {
      results.push(
        traceThroughServices(target.nextScope, bound, prop, depth + 1, services, seen),
      );
      continue;
    }
    // 目标方法体内既没用这个字段，也没有整体透传 → 确实没用
    results.push('unused');
  }

  if (results.includes('used')) return 'used';
  // 有「判不了」的路径时不能断言「没用」—— 否则会误报成缺陷
  if (results.includes('unknown')) return 'unknown';
  if (results.includes('unused')) return 'unused';
  return 'unused';
}

/* ------------------------------ Swagger ------------------------------ */

async function loadSwagger() {
  if (!SWAGGER_URL && !SWAGGER_FILE) return null;
  const target = SWAGGER_FILE || SWAGGER_URL || '';
  if (!/^https?:\/\//.test(target)) {
    const raw = readFileSafe(target);
    if (!raw) throw new Error(`无法读取 swagger 文件：${target}`);
    return JSON.parse(raw);
  }
  const response = await fetch(target);
  if (!response.ok) throw new Error(`拉取 swagger 失败：HTTP ${response.status}（${target}）`);
  return response.json();
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  const { dtos, controllers, services } = buildServerIndex();

  if (DEBUG) {
    console.error('--- 调试：解析到的控制器 ---');
    for (const c of controllers) {
      if (!c.queryParam) continue;
      console.error(
        `  ${c.className}.${c.methodName}  query=${c.queryParam.name}:${c.queryParam.type}` +
          `  props=${[...(dtoProps(c.queryParam.type, dtos) ?? [])].join(',')}`,
      );
    }
    console.error('--- 调试：解析到的服务方法 ---');
    for (const [name, svc] of services) {
      console.error(`  ${name}: ${[...svc.methods.keys()].join(', ')}`);
      for (const [mName, m] of svc.methods) {
        console.error(
          `     .${mName}(${m.params.map((p) => `${p.name}:${p.type}`).join(', ')})` +
            `  bodyLen=${m.body.length}`,
        );
      }
    }
  }

  const issues = [];
  const notes = [];
  let checkedHandlers = 0;
  let checkedParams = 0;

  /**
   * 判断「声明出来的某个字段」是不是真的被用上了。
   * 返回 'used' | 'unused' | 'unknown'
   */
  function checkConsumption(controller, varName, prop) {
    if (usesProp(controller.body, varName, prop)) return 'used';
    if (!usesVarWholesale(controller.body, varName)) return 'unused';
    return traceThroughServices(
      {
        body: controller.body,
        serviceProps: controller.serviceProps,
        ownMethods: controller.ownMethods,
        className: controller.className,
      },
      varName,
      prop,
      0,
      services,
      new Set([`${controller.className}.${controller.methodName}#${varName}`]),
    );
  }

  for (const controller of controllers) {
    for (const kind of PARAM_KINDS) {
      const param = controller.params.find((p) =>
        p.decorators.some((d) => d.name === kind.decorator && d.args === ''),
      );
      if (!param) continue;
      const typeName = param.type.replace(/\[\]$/, '').trim();

      // 声明字段集合：具名 DTO → 查 DTO 索引；内联对象字面量 → 直接解析字段名
      let props = dtoProps(typeName, dtos);
      let declaredIn = typeName;
      if (!props) {
        const inline = inlineTypeFields(typeName);
        if (inline) {
          props = new Set(inline);
          declaredIn = '内联请求体类型';
        }
      }
      if (!props) {
        notes.push({
          kind: 'DTO_NOT_RESOLVED',
          where: `${controller.httpMethod} ${controller.fullPath}`,
          handler: `${controller.className}.${controller.methodName}`,
          detail: `${kind.label}的类型 ${typeName} 未解析到字段（可能是 Record<string, unknown> 这类开放结构），跳过`,
          file: controller.file,
          line: controller.line,
        });
        continue;
      }
      checkedHandlers += 1;

      const varName = param.name;
      for (const prop of props) {
        checkedParams += 1;
        const result = checkConsumption(controller, varName, prop);
        if (result === 'used') continue;
        if (result === 'unknown') {
          notes.push({
            kind: 'UNRESOLVED_PROP',
            where: `${controller.httpMethod} ${controller.fullPath}`,
            handler: `${controller.className}.${controller.methodName}`,
            param: prop,
            detail: `${kind.label} ${prop} 整体透传后未能静态判定是否生效`,
            file: controller.file,
            line: controller.line,
          });
          continue;
        }
        issues.push({
          kind: 'DECLARED_PARAM_NOT_USED',
          where: `${controller.httpMethod} ${controller.fullPath}`,
          handler: `${controller.className}.${controller.methodName}`,
          param: prop,
          kindLabel: kind.label,
          detail: `${kind.label} ${prop} 在 ${declaredIn} 里声明（对外可见），但服务端从未真正使用它`,
          file: controller.file,
          line: controller.line,
        });
      }
    }
  }

  /* --- 副检查：Swagger 声明 ↔ DTO 推导 --- */
  const swagger = await loadSwagger();
  let swaggerOps = 0;
  if (swagger) {
    for (const [rawPath, methods] of Object.entries(swagger.paths ?? {})) {
      for (const [httpMethod, operation] of Object.entries(methods)) {
        if (httpMethod === 'parameters') continue;
        const queryParams = (operation.parameters ?? [])
          .filter((p) => p.in === 'query')
          .map((p) => p.name);
        if (!queryParams.length) continue;
        swaggerOps += 1;
        const operationId = operation.operationId ?? '';
        const controller = controllers.find(
          (c) => `${c.className}_${c.methodName}` === operationId,
        );
        if (!controller) {
          notes.push({
            kind: 'OPERATION_NOT_RESOLVED',
            where: `${httpMethod.toUpperCase()} ${rawPath}`,
            detail: `swagger operationId ${operationId || '(空)'} 未匹配到控制器方法`,
          });
          continue;
        }
        if (!controller.queryParam) continue;
        const dtoName = controller.queryParam.type.replace(/\[\]$/, '').trim();
        const props = dtoProps(dtoName, dtos);
        if (!props) continue;
        const declared = new Set(queryParams);
        for (const name of declared) {
          if (!props.has(name)) {
            issues.push({
              kind: 'SWAGGER_PARAM_NOT_IN_DTO',
              where: `${httpMethod.toUpperCase()} ${rawPath}`,
              handler: `${controller.className}.${controller.methodName}`,
              param: name,
              detail: `Swagger 声明了查询参数 ${name}，但 ${dtoName} 里没有这个字段（文档与 DTO 不同步）`,
              file: controller.file,
              line: controller.line,
            });
          }
        }
      }
    }
  }

  const summary = {
    checkedHandlers,
    checkedParams,
    swaggerOperations: swaggerOps,
    issues: issues.length,
    notes: notes.length,
    detail: issues,
  };

  if (AS_JSON) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('=== Swagger 声明参数 ↔ 实现消费 对账 ===');
    for (const item of issues) {
      console.log(`  ✗ ${item.where}  [${item.kind}] ${item.detail}`);
      console.log(`      ${item.handler}  ${item.file}:${item.line}`);
    }
    console.log(
      `共检查 ${checkedHandlers} 个带查询 DTO 的 handler、${checkedParams} 个声明参数` +
        (swagger ? `，对账 ${swaggerOps} 个 swagger 操作` : '（未提供 swagger，仅静态检查）') +
        `：不一致 ${issues.length}，提示 ${notes.length}`,
    );
    if (notes.length) {
      console.log('  注：以下项无法静态判定，未判失败：');
      for (const note of notes.slice(0, 12)) {
        console.log(`    · [${note.kind}] ${note.where}  ${note.detail}`);
      }
    }
  }

  process.exit(issues.length ? 1 : 0);
}

main().catch((error) => {
  console.error(`声明参数消费对账异常：${error.message}`);
  process.exit(2);
});
