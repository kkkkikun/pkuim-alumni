#!/usr/bin/env node
/**
 * 第 23 层校验的反向验证注入器（由 check-miniprogram-ui-feedback-selftest.sh 调用）。
 *
 * ⚠️ 与第 22 层的注入器不同：**本文件不含中文转义**。
 *   因为它是一个**独立文件**（不是被 selftest 用 heredoc 现场生成的），
 *   中文不会经过 bash heredoc，不存在被吞掉的风险。
 *
 * 用法：node check-miniprogram-ui-feedback-inject.mjs <目标源码目录> <操作名>
 * 退出码：0 注入成功；1 注入失败（说明测试本身有问题）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const srcDir = resolve(process.argv[2] || '.');
const op = process.argv[3] || '';

function file(...parts) {
  return resolve(srcDir, ...parts);
}

function read(p) {
  return readFileSync(p, 'utf8');
}

function write(p, text) {
  writeFileSync(p, text, 'utf8');
}

function mustReplace(text, pattern, replacement, label) {
  if (!pattern.test(text)) {
    throw new Error(`注入失败：没找到可替换的「${label}」`);
  }
  return text.replace(pattern, replacement);
}

switch (op) {
  // R1：把某个页面的底部留白类去掉 → 固定底栏又会压住正文
  case 'strip-bar-padding': {
    const p = file('pages/me/verify-form/index.wxml');
    write(p, mustReplace(read(p), /page-with-fixed-bar\s*/, '', 'page-with-fixed-bar'));
    break;
  }

  // R2：把 .form-input 的显式 height 去掉 → 输入框文字被裁切复发
  case 'input-height': {
    const p = file('app.wxss');
    const text = read(p);
    const blockRe = /(\.form-input\s*\{)([^}]*)(\})/;
    if (!blockRe.test(text)) {
      throw new Error('注入失败：找不到 .form-input 样式块');
    }
    const patched = text.replace(blockRe, (all, head, body, tail) => {
      if (!/\n\s*height\s*:\s*[^;]+;/.test(body)) {
        throw new Error('注入失败：.form-input 里没有 height 声明');
      }
      return head + body.replace(/\n\s*height\s*:\s*[^;]+;/, '') + tail;
    });
    write(p, patched);
    break;
  }

  // R2：给 .form-input 加回纵向 padding → 输入框文字被裁切复发
  case 'input-padding': {
    const p = file('app.wxss');
    const text = read(p);
    const blockRe = /(\.form-input\s*\{)([^}]*)(\})/;
    if (!blockRe.test(text)) {
      throw new Error('注入失败：找不到 .form-input 样式块');
    }
    const patched = text.replace(blockRe, (all, head, body, tail) => {
      if (!/padding\s*:\s*[^;]+;/.test(body)) {
        throw new Error('注入失败：.form-input 里没有 padding 声明');
      }
      return head + body.replace(/padding\s*:\s*[^;]+;/, 'padding: 24rpx 22rpx;') + tail;
    });
    write(p, patched);
    break;
  }

  // R3：去掉列表页 onShow 里的重载调用 → 筛选看起来不生效
  case 'no-reload': {
    const p = file('pages/directory/index/index.ts');
    write(p, mustReplace(read(p), /this\.reloadIfFilterChanged\(\);/, '', 'reloadIfFilterChanged 调用'));
    break;
  }

  // R4：去掉空状态里的「清空筛选条件」出路 → 用户卡在空列表
  case 'no-empty-action': {
    const p = file('pages/connect/index/index.wxml');
    write(
      p,
      mustReplace(
        read(p),
        /<view slot="empty-action"[\s\S]*?<\/view>/,
        '',
        'empty-action 插槽'
      )
    );
    break;
  }

  // R5：让通讯录页不再展示年份条件 → 年份变成看不见的幽灵条件
  case 'hide-year': {
    const p = file('pages/directory/index/index.wxml');
    write(p, mustReplace(read(p), /\{\{[^}]*yearLabel[^}]*\}\}/g, '{{yearLabelHidden}}', 'yearLabel 插值表达式'));
    break;
  }

  // R5：让连接页不再展示信息类型条件
  case 'hide-type': {
    const p = file('pages/connect/index/index.wxml');
    write(p, mustReplace(read(p), /\{\{[^}]*typeLabel[^}]*\}\}/g, '{{typeLabelHidden}}', 'typeLabel 插值表达式'));
    break;
  }

  // R6：把某个地区的资源全部删掉 → 选该地区得到 0 条
  case 'region-gap': {
    const p = file('demo/dataset.data.ts');
    const text = read(p);
    const marker = 'export const RAW_DATASET =';
    const at = text.indexOf(marker);
    const body = text.slice(at + marker.length);
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    const data = JSON.parse(body.slice(start, end + 1));
    const before = data.resources.length;
    data.resources = data.resources.filter((item) => item.regionCode !== 'HHS');
    if (data.resources.length === before) {
      throw new Error('注入失败：演示数据里没有该地区的资源');
    }
    write(p, `${text.slice(0, at + marker.length)}${JSON.stringify(data, null, 2)};\n`);
    break;
  }

  // 防误报：做一处**合法**改动，校验器必须仍然通过
  case 'benign': {
    const p = file('pages/me/verify-intro/index.wxml');
    write(p, mustReplace(read(p), /开始认证/, '立即开始认证', '开始认证按钮文案'));
    break;
  }

  default:
    throw new Error(`未知操作：${op}`);
}
