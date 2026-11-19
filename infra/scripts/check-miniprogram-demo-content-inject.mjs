#!/usr/bin/env node
/**
 * 第 22 层校验的反向验证注入器（由 check-miniprogram-demo-content-selftest.sh 调用）。
 *
 * ⚠️ 本文件**故意不含中文字面量** —— selftest 里要用 heredoc 生成它，
 *    而 bash heredoc 会吞中文（项目既有约束）。需要中文的地方一律用
 *    unicode 转义在运行时还原。
 *
 * 用法：node inject.mjs <目标源码目录> <操作名>
 * 退出码：0 注入成功；1 注入失败（说明测试本身有问题）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const srcDir = resolve(process.argv[2] || '.');
const op = process.argv[3] || '';

const datasetFile = resolve(srcDir, 'demo/dataset.data.ts');
const directoryFile = resolve(srcDir, 'demo/directory.ts');

// ---------------------------------------------------------------------------
// 数据集读写
// ---------------------------------------------------------------------------
function readDataset() {
  const text = readFileSync(datasetFile, 'utf8');
  const marker = 'export const RAW_DATASET =';
  const at = text.indexOf(marker);
  const body = text.slice(at + marker.length);
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return {
    header: text.slice(0, at + marker.length),
    data: JSON.parse(body.slice(start, end + 1)),
  };
}

function writeDataset(header, data) {
  writeFileSync(datasetFile, `${header}${JSON.stringify(data, null, 2)};\n`, 'utf8');
}

/** 【虚构】的 unicode 转义（运行时还原成中文） */
const FICTION = '\u3010\u865a\u6784\u3011';
/** 「联调」的 unicode 转义 */
const LIAN_TIAO = '\u8054\u8c03';
/** 「校友 A」的 unicode 转义 */
const PLACEHOLDER_NAME = '\u6821\u53cb A';

function firstItem(data, collection) {
  const items = data[collection];
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`集合 ${collection} 为空，无法注入`);
  }
  return items;
}

switch (op) {
  // 1. 标题含内部痕迹词（用英文 debug，命中 TITLE_FORBIDDEN）
  case 'title-word': {
    const { header, data } = readDataset();
    const items = firstItem(data, 'events');
    items[0].title = `debug ${items[0].title}`;
    writeDataset(header, data);
    break;
  }

  // 2. 正文含「联调」
  case 'body-word': {
    const { header, data } = readDataset();
    const items = firstItem(data, 'articles');
    items[0].body = `${LIAN_TIAO}${items[0].body}`;
    writeDataset(header, data);
    break;
  }

  // 3. 标题缺「【虚构】」前缀
  case 'strip-prefix': {
    const { header, data } = readDataset();
    const items = firstItem(data, 'notices');
    items[0].title = items[0].title.replace(FICTION, '');
    writeDataset(header, data);
    break;
  }

  // 4. 条目数不足
  case 'drop-items': {
    const { header, data } = readDataset();
    data.articles = data.articles.slice(0, 3);
    writeDataset(header, data);
    break;
  }

  // 5. 标题重复（规范化后重复：靠期号差异掩盖）
  case 'dup-title': {
    const { header, data } = readDataset();
    const items = firstItem(data, 'articles');
    items[1].title = items[0].title;
    writeDataset(header, data);
    break;
  }

  // 6. 英文 kind（图标会退化成兜底）
  case 'eng-kind': {
    const { header, data } = readDataset();
    const items = firstItem(data, 'events');
    items[0].kind = 'industry';
    writeDataset(header, data);
    break;
  }

  // 7. 分类计数与实际文章数不符
  case 'count-mismatch': {
    const { header, data } = readDataset();
    if (!Array.isArray(data.articleCategories) || data.articleCategories.length === 0) {
      throw new Error('没有分类可注入');
    }
    data.articleCategories[0].articleCount = 999;
    writeDataset(header, data);
    break;
  }

  // 8. 通讯录占位式昵称
  case 'placeholder-name': {
    const text = readFileSync(directoryFile, 'utf8');
    const re = /name:\s*'[^']+'/;
    if (!re.test(text)) throw new Error('通讯录里找不到 name 字段');
    writeFileSync(directoryFile, text.replace(re, `name: '${PLACEHOLDER_NAME}'`), 'utf8');
    break;
  }

  // 9. 防误报：合法内容（具体标题、带标记、正文干净）
  case 'benign': {
    const { header, data } = readDataset();
    const items = firstItem(data, 'articles');
    items[0].title = `${FICTION}\u6821\u53cb\u4f1a\u8d44\u8baf\u7b2c 99 \u671f\uff1a\u5168\u65b0\u4e3b\u9898`;
    items[0].body = `${FICTION}\u6f14\u793a\u5185\u5bb9\uff0c\u6b63\u6587\u5e72\u51c0\u3002`;
    writeDataset(header, data);
    break;
  }

  default:
    console.error(`未知操作：${op}`);
    process.exit(1);
}

console.log(`injected:${op}`);
process.exit(0);
