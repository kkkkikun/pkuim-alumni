#!/usr/bin/env node
/**
 * 压测结果脱敏。
 *
 * 背景：k6 的 `--summary-export` 会把 `setup` 阶段拿到的**访问令牌明文**写进
 *       结果 JSON 的 `setup_data` 里（还有 k6 日志里的请求头）。
 *       这些结果是**会被归档 / 同步 / 贴进报告**的产物，
 *       留在里面等于把可用凭据散落在工作副本里。
 *
 * 用法：
 *   node infra/scripts/redact-loadtest-results.mjs <文件...>      # 脱敏指定文件
 *   node infra/scripts/redact-loadtest-results.mjs --selftest     # 自检
 *
 * 行为：
 *   - `.json` → 解析后递归替换 JWT 形态的字符串，再写回（保持格式化）；
 *   - 其它文本 → 直接正则替换。
 *
 * 替换规则：形如 `xxx.yyy.zzz` 且以 `eyJ` 开头的 JWT 一律替换为 `***REDACTED***`。
 *
 * 退出码：0 成功；1 自检失败或文件读取失败。
 */

import fs from 'node:fs';

const JWT_RE = /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g;
const REDACTED = '***REDACTED***';

/** 递归替换对象里的所有 JWT 字符串 */
function redact(value) {
  if (typeof value === 'string') return value.replace(JWT_RE, REDACTED);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = redact(item);
    return out;
  }
  return value;
}

/** 脱敏单个文件，返回是否发生了替换 */
export function redactFile(file) {
  const original = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    let doc;
    try {
      doc = JSON.parse(original);
    } catch {
      // 不是合法 JSON（可能是半截文件）→ 退回文本替换
      const next = original.replace(JWT_RE, REDACTED);
      if (next !== original) fs.writeFileSync(file, next, 'utf8');
      return next !== original;
    }
    const next = `${JSON.stringify(redact(doc), null, 2)}\n`;
    if (next !== original) fs.writeFileSync(file, next, 'utf8');
    return next !== original;
  }
  const next = original.replace(JWT_RE, REDACTED);
  if (next !== original) fs.writeFileSync(file, next, 'utf8');
  return next !== original;
}

/** 自检：造一个含令牌的样本，断言脱敏后令牌消失、其它内容保留 */
function selftest() {
  const token =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMDAxIiwia2luZCI6InVzZXIifQ.abcdefghijklmnop';
  const sample = {
    setup_data: { token, other: 'keep-me' },
    metrics: { http_reqs: { count: 10 } },
    note: `令牌出现在文本里：${token}`,
  };
  const file = `${process.env.TMPDIR ?? '/tmp'}/redact-selftest-${process.pid}.json`;
  fs.writeFileSync(file, JSON.stringify(sample, null, 2), 'utf8');
  try {
    redactFile(file);
    const after = fs.readFileSync(file, 'utf8');
    const failures = [];
    if (after.includes(token)) failures.push('脱敏后仍能读到明文令牌');
    if (!after.includes('keep-me')) failures.push('脱敏把无关内容一并删掉了');
    if (!after.includes('http_reqs')) failures.push('脱敏把指标数据弄丢了');
    if (failures.length > 0) {
      for (const item of failures) console.error(`✗ ${item}`);
      return 1;
    }
    console.log('✓ 自检通过：令牌被替换，无关内容与指标保留');
    return 0;
  } finally {
    fs.unlinkSync(file);
  }
}

const args = process.argv.slice(2);
if (args.includes('--selftest')) {
  process.exit(selftest());
}

if (args.length === 0) {
  console.error('用法：node redact-loadtest-results.mjs <文件...> | --selftest');
  process.exit(2);
}

let changed = 0;
for (const file of args) {
  if (!fs.existsSync(file)) continue;
  try {
    if (redactFile(file)) changed += 1;
  } catch (error) {
    console.error(`脱敏失败（${file}）：${error.message}`);
    process.exit(1);
  }
}
console.log(`已脱敏 ${changed} 个文件（共检查 ${args.length} 个）`);
