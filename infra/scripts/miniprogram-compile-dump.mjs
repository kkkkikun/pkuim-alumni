import { createRequire } from 'node:module';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';

const CI_DIR = process.env.MINIPROGRAM_CI_DIR || '/tmp/nmg-miniprogram-ci';
const require = createRequire(resolve(CI_DIR, 'index.js'));
const ci = require('miniprogram-ci');
const { getCompiledResult } = require('miniprogram-ci/dist/ci/getCompiledResult');
const signMod = require('miniprogram-ci/dist/utils/sign');
signMod.getSignature = async () => 'x';
const requestMod = require('miniprogram-ci/dist/utils/request');
const { DefaultProjectAttr } = require('miniprogram-ci/dist/config/config');
requestMod.request = async () => ({ body: JSON.stringify({ errCode: 0, errMsg: 'ok', data: DefaultProjectAttr }) });
const fakeKeyPath = resolve(tmpdir(), 'nmg-fake-compile.key');
if (!existsSync(fakeKeyPath)) {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  writeFileSync(fakeKeyPath, privateKey, { mode: 0o600 });
}
const projectPath = process.argv[2];
const outDir = process.argv[3];
const project = new ci.Project({ appid: 'wx0000000000000000', type: 'miniProgram', projectPath, privateKeyPath: fakeKeyPath, ignores: ['node_modules/**/*'] });
const result = await getCompiledResult({ project, setting: { es6: true, enhance: true, minified: true, codeProtect: false } }, undefined);
const files = Object.keys(result);
if (outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const f of files) {
    const target = join(outDir, f);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, result[f]);
  }
  console.log(`产物已落盘：${outDir}（${files.length} 个文件）`);
}
let npmReq = 0;
for (const f of files) {
  if (!f.endsWith('.js')) continue;
  const t = result[f].toString('utf8');
  for (const m of t.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
    if (!m[1].startsWith('.')) { npmReq++; console.log(`  npm 依赖：${f} require('${m[1]}')`); }
  }
}
console.log(`非相对路径 require 共 ${npmReq} 条`);
