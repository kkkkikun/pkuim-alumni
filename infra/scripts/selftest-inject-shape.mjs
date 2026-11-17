#!/usr/bin/env node
/**
 * 响应结构校验器的缺陷注入器。
 *
 *   node infra/scripts/selftest-inject-shape.mjs <case> <fixtureDir>
 *
 * 在**录制好的响应夹具**上注入一个具体的结构缺陷，
 * 用来证明 `check-response-shape.mjs` 不是恒过的 —— 它必须能抓出这些缺陷。
 *
 * 用例：
 *   shape-bare-array          列表端点返回裸数组（缺陷 #58 原形）
 *   shape-missing-field       列表项缺少必填字段（缺陷 #58 第二形：roles）
 *   shape-missing-meta        分页结构缺少 meta
 *   shape-missing-admin-name  审核 / 审计记录缺少 adminName（缺陷 #60 / #61）
 *   shape-nested-missing-field 嵌套数组（证明材料）元素缺少字段（缺陷 #75）
 *   shape-nested-empty-array  嵌套数组全空 → 元素结构从未被校验（缺陷 #76 的盲点）
 *   shape-nested-sparse-array 只有部分条目数组为空 → **不得**报盲点（元素结构已被校验过）
 *
 * 只改临时副本里的夹具文件，仓库里的基线夹具永远只读。
 */

import fs from 'node:fs';
import path from 'node:path';

const [caseName, dir] = process.argv.slice(2);
if (!caseName || !dir) {
  console.error('用法：node selftest-inject-shape.mjs <case> <fixtureDir>');
  process.exit(2);
}

const FIXTURES = path.resolve(dir);

function fixture(name) {
  return path.join(FIXTURES, name);
}

function read(name) {
  const file = fixture(name);
  if (!fs.existsSync(file)) {
    console.error(`缺少夹具：${name}`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function write(name, value) {
  fs.writeFileSync(fixture(name), JSON.stringify(value, null, 2));
}

/** 取信封里的 data */
function dataOf(body) {
  return body && typeof body === 'object' && 'code' in body && 'data' in body ? body.data : body;
}

switch (caseName) {
  case 'shape-bare-array': {
    // 缺陷 #58 原形：把 { items, meta } 换成裸数组
    const name = 'GET_admin_users.json';
    const body = read(name);
    const data = dataOf(body);
    if (!Array.isArray(data?.items)) {
      console.error(`夹具 ${name} 的 data 不是分页结构，无法注入`);
      process.exit(2);
    }
    write(name, { ...body, data: data.items });
    console.log(`已注入：${name} 的 data 改为裸数组`);
    break;
  }
  case 'shape-missing-field': {
    // 缺陷 #58 第二形：列表项缺少必填字段 roles
    const name = 'GET_admin_users.json';
    const body = read(name);
    const data = dataOf(body);
    if (Array.isArray(data?.items) && data.items.length > 0) {
      delete data.items[0].roles;
    }
    write(name, body);
    console.log(`已注入：${name} 的首个列表项缺少 roles`);
    break;
  }
  case 'shape-missing-meta': {
    // 分页结构缺少 meta
    const name = 'GET_admin_articles.json';
    const body = read(name);
    const data = dataOf(body);
    if (data && typeof data === 'object') delete data.meta;
    write(name, body);
    console.log(`已注入：${name} 缺少 meta`);
    break;
  }
  case 'shape-missing-admin-name': {
    // 缺陷 #60 / #61：审核 / 审计记录缺少 adminName
    const name = 'GET_admin_action_logs.json';
    const body = read(name);
    const data = dataOf(body);
    if (Array.isArray(data?.items) && data.items.length > 0) {
      delete data.items[0].adminName;
    }
    write(name, body);
    console.log(`已注入：${name} 的首条记录缺少 adminName`);
    break;
  }
  case 'shape-nested-missing-field': {
    // 缺陷 #75：嵌套数组（证明材料）里的元素缺少契约声明的字段
    // —— 服务端只给 { id, mediaId }，契约要求 6 个字段 → 后台审核页附件区恒空。
    const name = 'GET_admin_verifications.json';
    const body = read(name);
    const data = dataOf(body);
    const item = Array.isArray(data?.items) ? data.items.find((it) => it.attachments?.length) : null;
    if (!item) {
      console.error(`夹具 ${name} 里没有带附件的列表项，无法注入`);
      process.exit(2);
    }
    delete item.attachments[0].fileName;
    write(name, body);
    console.log(`已注入：${name} 的附件缺少 fileName`);
    break;
  }
  case 'shape-nested-sparse-array': {
    // 只清空**部分**条目的嵌套数组 —— 另一条仍有元素，
    // 说明元素结构**已经被校验过**，此时**不能**报盲点
    // （防止「只要有一条空样本就报盲点」的过宽判定）。
    const name = 'GET_admin_verifications.json';
    const body = read(name);
    const data = dataOf(body);
    if (Array.isArray(data?.items) && data.items.length > 1) {
      for (const item of data.items.slice(0, 1)) {
        if (Array.isArray(item.attachments)) item.attachments = [];
      }
      write(name, body);
      console.log(`已注入：${name} 的第 1 条附件数组被清空（其余条目仍有附件）`);
      break;
    }
    throw new Error('注入失败：夹具条目不足两条');
  }
  case 'shape-nested-empty-array': {
    // 缺陷 #76 的盲点形态：嵌套数组全是空的 → 元素结构**从未被校验**。
    // 校验器必须把这个盲点**显式报出来**，而不是静默通过。
    //
    // ⚠️ 必须清空**所有**夹具里的该元素类型：盲点的判定口径是「元素类型」
    // （只要有任意一条样本带元素，元素结构就已被校验过 → 不是盲点）。
    const touched = [];
    for (const file of fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json'))) {
      if (file === 'manifest.json') continue;
      const full = path.join(FIXTURES, file);
      const body = read(file);
      let changed = false;
      const walk = (node) => {
        if (Array.isArray(node)) {
          for (const item of node) walk(item);
          return;
        }
        if (!node || typeof node !== 'object') return;
        for (const [key, value] of Object.entries(node)) {
          if (key === 'attachments' && Array.isArray(value) && value.length) {
            node[key] = [];
            changed = true;
            continue;
          }
          walk(value);
        }
      };
      walk(dataOf(body));
      if (changed) {
        write(file, body);
        touched.push(file);
      }
    }
    if (!touched.length) throw new Error('注入失败：没有找到带附件的夹具');
    console.log(`已注入：${touched.join('、')} 的所有附件数组被清空`);
    break;
  }
  default:
    console.error(`未知用例：${caseName}`);
    process.exit(2);
}
