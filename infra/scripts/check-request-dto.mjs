#!/usr/bin/env node
/**
 * 请求参数 DTO 校验 —— 「运行时会不会被 ValidationPipe 跳过」对账。
 *
 * 背景（缺陷 #79 / #88 / #89 是同一类）：
 *   Nest 的 `ValidationPipe` 只校验**运行时 metatype 是「带 class-validator
 *   装饰器的类」**的请求体。写成下面这些形式时，运行时 metatype 是 `Object`
 *   或原始类型 → `toValidate()` 返回 false → **整个请求体被静默跳过校验**：
 *
 *     @Body() body: Record<string, unknown>        // #79：管理端 12 个写端点
 *     @Body() body: SomePlainInterface              // #88：媒体登记
 *     @Body() body: { note?: string }                // #89：活动报名（内联字面量）
 *     @Body() body: any
 *
 *   后果不抛异常：畸形输入被写进库、非法枚举打到数据库变 500、
 *   契约之外的字段不被剥掉（客户端以为传了、服务端其实按自己的规则走）。
 *
 * 本脚本扫描**所有**控制器的 `@Body()` 与 `@Query()` 参数，
 * 判定每个请求体 / 查询对象在运行时是否真的会被校验，
 * 并报出所有「会被跳过」的：
 *
 *   1. 类型是内联对象字面量 / `Record<...>` / `any` / 原始类型 → 跳过；
 *   2. 类型解析不到类定义（多半是普通 `interface`）→ 跳过；
 *   3. 类定义里**没有任何** class-validator 装饰器 → 跳过；
 *   4. 形如 `@Body('field')` 的**属性式**请求体 → 值不被校验（提示级）。
 *
 * ⚠️ `@Query()` 同样受这条规则约束：Nest 的 ValidationPipe 对
 * `@Query() query: SomeDto` 的判定依据也是**运行时 metatype**，
 * 写成普通 `interface` 或交叉类型（`PaginationQueryDto & { keyword?: string }`）
 * 就会退化成 `Object` → 参数不校验、不转换（`page` 变 NaN → 列表接口 500）。
 *
 * 用法：
 *   node infra/scripts/check-request-dto.mjs --root <repo> [--json]
 *
 * 退出码：0 = 所有请求体 / 查询对象都会真正被校验；1 = 存在会被跳过的。
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
const AS_JSON = args.includes('--json');
const API_SRC = path.join(ROOT, 'apps/api/src');

/** 原始类型 / 明确不该作为请求体的写法 */
const PRIMITIVES = new Set([
  'string',
  'number',
  'boolean',
  'object',
  'any',
  'unknown',
  'never',
  'void',
  'null',
  'undefined',
  'bigint',
  'symbol',
]);

/** class-validator 装饰器（出现任意一个即视为「这个类会参与校验」） */
const VALIDATOR_DECORATORS = [
  'IsString',
  'IsNumber',
  'IsInt',
  'IsBoolean',
  'IsArray',
  'IsEnum',
  'IsIn',
  'IsObject',
  'IsOptional',
  'IsNotEmpty',
  'IsUUID',
  'IsISO8601',
  'IsEmail',
  'IsUrl',
  'Min',
  'Max',
  'MinLength',
  'MaxLength',
  'Validate',
  'ValidateNested',
  'Allow',
];

/* ------------------------------ 基础工具 ------------------------------ */

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function walk(dir, out = [], filter = /\.ts$/) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full, out, filter);
    } else if (entry.isFile() && filter.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 括号匹配（字符串感知） */
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

/** 顶层逗号切分 */
function splitTopLevel(src, sep = ',') {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      current += ch;
      if (ch === '\\') {
        current += src[i + 1] ?? '';
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') depth -= 1;
    if (ch === sep && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** 顶层冒号位置 */
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
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') depth -= 1;
    else if (ch === ':' && depth === 0) return i;
  }
  return -1;
}

/* ------------------------------ 类 / 成员解析 ------------------------------ */

function parseClasses(src) {
  const classes = [];
  const re = /export\s+class\s+(\w+)(?:\s+extends\s+([\w.]+))?/g;
  let match;
  while ((match = re.exec(src)) !== null) {
    const brace = src.indexOf('{', match.index + match[0].length);
    if (brace < 0) continue;
    const end = matchBracket(src, brace);
    if (end < 0) continue;
    classes.push({
      name: match[1],
      extendsName: match[2] ?? '',
      body: src.slice(brace + 1, end),
      index: brace,
    });
  }
  return classes;
}

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

/** 从 `start` 处解析一个类成员（跳过装饰器 → 名字 → 参数 → 方法体） */
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
  return { name, paramsSrc, afterParams: paramsEnd };
}

const ROUTE_RE = /@(Get|Post|Put|Patch|Delete)\s*\(\s*(?:(['"`])([^'"`]*)\2)?\s*\)/g;

/* ------------------------------ 主流程 ------------------------------ */

function main() {
  const files = walk(API_SRC);
  const classIndex = new Map(); // 类名 → { body, file }

  for (const file of files) {
    const raw = readFileSafe(file);
    if (!raw) continue;
    const src = stripComments(raw);
    for (const cls of parseClasses(src)) {
      if (!classIndex.has(cls.name)) {
        classIndex.set(cls.name, {
          body: cls.body,
          extendsName: cls.extendsName,
          file: path.relative(ROOT, file),
        });
      }
    }
  }

  const issues = [];
  const notes = [];
  let checkedBodies = 0;

  for (const file of files) {
    if (!/\.controller\.ts$/.test(file)) continue;
    const raw = readFileSafe(file);
    if (!raw) continue;
    const src = stripComments(raw);
    const relative = path.relative(ROOT, file);

    for (const cls of parseClasses(src)) {
      ROUTE_RE.lastIndex = 0;
      let match;
      while ((match = ROUTE_RE.exec(cls.body)) !== null) {
        const member = parseMember(cls.body, match.index + match[0].length);
        if (!member) continue;
        const httpMethod = match[1].toUpperCase();
        const route = match[3] ?? '';

        for (const part of splitTopLevel(member.paramsSrc)) {
          const param = parseParam(part);
          const bodyDecorator = param.decorators.find(
            (d) => d.name === 'Body' || d.name === 'Query',
          );
          if (!bodyDecorator) continue;
          const source = bodyDecorator.name;

          // 属性式取值：@Body('field') / @Query('field') —— 值不经过 DTO 校验
          if (bodyDecorator.args !== '') {
            notes.push({
              kind: 'PROPERTY_PARAM',
              where: `${httpMethod} ${route}`,
              handler: `${cls.name}.${member.name}`,
              detail: `@${source}('${bodyDecorator.args}') 的值不经过 DTO 校验（原始类型）`,
              file: relative,
            });
            continue;
          }

          checkedBodies += 1;
          const type = param.type.replace(/\s*\|\s*undefined$/, '').trim();

          // 1) 内联对象字面量 / Record / 原始类型
          if (type.startsWith('{')) {
            issues.push({
              kind: 'INLINE_OBJECT_TYPE',
              where: `${httpMethod} ${route}`,
              handler: `${cls.name}.${member.name}`,
              detail: `${source === 'Query' ? '查询对象' : '请求体'}类型是**内联对象字面量**（${type.replace(/\s+/g, ' ')}）→ 运行时 metatype 是 Object，ValidationPipe 完全跳过校验`,
              file: relative,
            });
            continue;
          }
          if (type.startsWith('Record<') || PRIMITIVES.has(type)) {
            issues.push({
              kind: 'OPEN_OR_PRIMITIVE_TYPE',
              where: `${httpMethod} ${route}`,
              handler: `${cls.name}.${member.name}`,
              detail: `${source === 'Query' ? '查询对象' : '请求体'}类型是 \`${type}\` → 运行时 metatype 不是「带校验器的类」，ValidationPipe 完全跳过校验`,
              file: relative,
            });
            continue;
          }

          // 2) 类型解析不到类定义
          const target = classIndex.get(type);
          if (!target) {
            issues.push({
              kind: 'TYPE_NOT_RESOLVED',
              where: `${httpMethod} ${route}`,
              handler: `${cls.name}.${member.name}`,
              detail: `${source === 'Query' ? '查询对象' : '请求体'}类型 \`${type}\` 解析不到类定义（多半是普通 interface 或交叉类型）→ 运行时 metatype 是 Object，ValidationPipe 完全跳过校验`,
              file: relative,
            });
            continue;
          }

          // 3) 类里没有任何 class-validator 装饰器
          // 沿继承链向上找（`class UpdateXDto extends CreateXDto` 本身可能没有装饰器）
          let hasValidator = false;
          let cursor = target;
          for (let depth = 0; depth < 4; depth += 1) {
            if (VALIDATOR_DECORATORS.some((name) => new RegExp(`@${name}\\s*\\(`).test(cursor.body))) {
              hasValidator = true;
              break;
            }
            const parentName = (cursor.extendsName ?? '').split('.').pop();
            const parent = parentName ? classIndex.get(parentName) : null;
            if (!parent) break;
            cursor = parent;
          }
          if (!hasValidator) {
            issues.push({
              kind: 'NO_VALIDATOR_DECORATOR',
              where: `${httpMethod} ${route}`,
              handler: `${cls.name}.${member.name}`,
              detail: `${source === 'Query' ? '查询对象' : '请求体'}类型 \`${type}\`（${target.file}）没有任何 class-validator 装饰器 → 运行时不会触发任何校验`,
              file: relative,
            });
          }
        }
        ROUTE_RE.lastIndex = member.afterParams;
      }
    }
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ checkedBodies, issues, notes }, null, 2));
  } else {
    console.log('=== 请求参数 DTO 校验（运行时会不会被 ValidationPipe 跳过）===');
    for (const issue of issues) {
      console.log(`  ✗ ${issue.where}  [${issue.kind}] ${issue.detail}`);
      console.log(`      ${issue.handler}  ${issue.file}`);
    }
    for (const note of notes) {
      console.log(`  · ${note.where}  [${note.kind}] ${note.detail}`);
      console.log(`      ${note.handler}  ${note.file}`);
    }
    console.log(
      `共检查 ${checkedBodies} 个整体请求体 / 查询对象：会被跳过校验 ${issues.length}，属性式提示 ${notes.length}`,
    );
  }

  process.exit(issues.length ? 1 : 0);
}

main();
