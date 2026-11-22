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

  // R7：把认证页底部的两个按钮改回上下堆叠 → 左右并排的布局又没了
  case 'stack-verify-buttons': {
    const p = file('pages/me/verify-intro/index.wxml');
    const text = read(p);
    const rowRe = /<view class="btn-row">[\s\S]*?<\/view>/;
    if (!rowRe.test(text)) {
      throw new Error('注入失败：找不到认证页底部的 .btn-row');
    }
    const patched = text.replace(
      rowRe,
      (all) =>
        all
          .replace('<view class="btn-row">', '')
          .replace('</view>', '')
    );
    write(p, patched);
    break;
  }

  // R8：在连接二级筛选页把「信息类型」区块加回来 → 重复入口
  case 'restore-type-filter': {
    const p = file('pages/connect/filter/index.wxml');
    const text = read(p);
    const section = [
      '  <view class="section">',
      '    <view class="section-head">',
      '      <text class="section-title">信息类型</text>',
      '    </view>',
      '    <view class="chip-row">',
      '      <view class="chip" data-type="all" bindtap="onTypeTap">全部</view>',
      '    </view>',
      '  </view>',
      '',
    ].join('\n');
    write(p, text.replace('<view class="detail-page', `${section}<view class="detail-page`));
    break;
  }

  // R8：二级筛选页的逻辑里重新接管信息类型 → 会与列表页的 chip 互相覆盖
  case 'filter-type-leak': {
    const p = file('pages/connect/filter/index.ts');
    write(
      p,
      mustReplace(
        read(p),
        /regionCode: '',\n\s*industryCode: '',/,
        "regionCode: '',\n    industryCode: '',\n    type: 'all' as 'all' | 'resource' | 'demand',",
        'data 里的地区与行业字段'
      )
    );
    break;
  }

  // R9：在连接列表页把「按行业方向查看」的 chip 行加回来 → 太乱
  case 'restore-industry-chips': {
    const p = file('pages/connect/index/index.wxml');
    const text = read(p);
    const block = [
      '    <view class="link-section-title">',
      '      <text class="section-title">按行业方向查看</text>',
      '    </view>',
      '    <scroll-view class="sector-scroll" scroll-x>',
      '      <view class="sector-row">',
      '        <view class="sector-chip" data-code="" bindtap="onIndustryTap">全部</view>',
      '      </view>',
      '    </scroll-view>',
      '',
    ].join('\n');
    write(p, text.replace('    <state-view', `${block}    <state-view`));
    break;
  }

  // R9：把列表页的行业入口藏起来 → 行业筛选变成看不见的幽灵条件
  case 'hide-industry-entry': {
    const p = file('pages/connect/index/index.wxml');
    write(p, mustReplace(read(p), /\{\{[^}]*industryLabel[^}]*\}\}/g, '{{industryLabelHidden}}', 'industryLabel 插值表达式'));
    break;
  }

  // 防误报：做一处**合法**改动，校验器必须仍然通过
  case 'benign': {
    const p = file('pages/me/verify-intro/index.wxml');
    write(p, mustReplace(read(p), /开始认证/, '立即开始认证', '开始认证按钮文案'));
    break;
  }

  // 防误报：**注释里**出现「信息类型」「按行业」这类字样，校验器必须仍然通过
  //   —— 注释不是用户能看到的界面，不能被当成页面内容（否则改注释就误报）
  case 'benign-comment': {
    const p = file('pages/connect/filter/index.wxml');
    const note = '<!-- 设计说明：类型筛选（信息类型）与按行业筛选都不在本页呈现 -->\n';
    write(p, note + read(p));
    break;
  }

  default:
    throw new Error(`未知操作：${op}`);
}
