#!/usr/bin/env node
/**
 * 小程序「离线编译自检」。
 *
 * 为什么需要它：
 *   `ci.preview` / `ci.upload` 会先调微信接口「取项目属性」，
 *   没有真实 AppID + 上传密钥时**在编译完成前就失败**，
 *   于是「编译通过」这句话没有任何证据（我们真的踩过：
 *   注入一个必然的类型错误，ci.preview 一样只报「empty content」）。
 *
 *   `getCompiledResult` 走的是**纯本地编译**（不联网），
 *   所以可以在没有凭据的情况下，真正证明「这份工程能编译出包」。
 *
 * 用法：
 *   node miniprogram-compile-check.mjs <工程目录> [--json]
 *   node miniprogram-compile-check.mjs <工程目录> \
 *        --expect-api-base http://8.160.116.34:18080/api/v1 \
 *        --expect-mock-login false \
 *        --expect-data-mode auto
 *
 * `--expect-*` 是**产物对账**：不看源码，直接在**编译产物**里验运行配置。
 * 为什么必须在产物里验：
 *   源码改了不等于包里有 —— 编译器会转译、压缩、可能剪枝，
 *   唯一能证明「客户打开的包里配置是对的」的办法是**看产物**。
 *
 * 退出码：0 编译通过且产物完整；1 编译失败 / 产物异常。
 *
 * ⚠️ miniprogram-ci 装在临时目录（不进 workspace 依赖），
 *    这里用 createRequire 从 MINIPROGRAM_CI_DIR 加载。
 */
import { createRequire } from 'node:module';
import { existsSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const CI_DIR = process.env.MINIPROGRAM_CI_DIR || '/tmp/nmg-miniprogram-ci';
const require = createRequire(resolve(CI_DIR, 'index.js'));

const projectPath = resolve(process.argv[2] || 'apps/miniprogram');
const asJson = process.argv.includes('--json');

/** 读取 --expect-xxx 参数 */
function readExpectation(name) {
  const flag = `--expect-${name}`;
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    console.error(`${flag} 需要一个值`);
    process.exit(1);
  }
  return value;
}

const expectApiBase = readExpectation('api-base');
const expectMockLogin = readExpectation('mock-login');
const expectDataMode = readExpectation('data-mode');

function log(...args) {
  if (!asJson) console.log(...args);
}

if (!existsSync(projectPath)) {
  console.error(`工程目录不存在：${projectPath}`);
  process.exit(1);
}

let ci;
try {
  ci = require('miniprogram-ci');
} catch (err) {
  console.error(
    `加载 miniprogram-ci 失败（${CI_DIR}）。先安装：\n` +
      `  mkdir -p ${CI_DIR} && cd ${CI_DIR} && npm init -y && ` +
      `npm install --registry https://registry.npmmirror.com miniprogram-ci`
  );
  process.exit(1);
}

const { getCompiledResult } = require('miniprogram-ci/dist/ci/getCompiledResult');

/**
 * 离线打桩：把「取项目属性」这一步的联网调用拦下来。
 *
 * `getProjectAttr` 的逻辑是：签名 → 请求微信接口 → 解析。
 * 我们只需要编译产物，不需要真的项目属性，
 * 所以：
 *   - 签名函数直接返回假签名（否则会在这里抛错，编译根本走不到）；
 *   - 请求函数直接返回 `{errCode: 0, data: DefaultProjectAttr}`。
 *
 * ⚠️ 这只是**本地编译自检**用的桩；真正的上传仍然走真实凭据。
 */
const signMod = require('miniprogram-ci/dist/utils/sign');
signMod.getSignature = async () => 'nmg-offline-compile-signature';
const requestMod = require('miniprogram-ci/dist/utils/request');
const { DefaultProjectAttr } = require('miniprogram-ci/dist/config/config');
requestMod.request = async () => ({
  body: JSON.stringify({ errCode: 0, errMsg: 'ok', data: DefaultProjectAttr }),
});

// 上传密钥只在「取项目属性」时才用得上；离线编译用不到，
// 但 Project 构造器要求该路径存在 → 缺就临时生成一把一次性 RSA 密钥。
const fakeKeyPath = process.env.MP_FAKE_KEY || resolve(tmpdir(), 'nmg-fake-compile.key');
if (!existsSync(fakeKeyPath)) {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  writeFileSync(fakeKeyPath, privateKey, { mode: 0o600 });
}

const project = new ci.Project({
  appid: 'wx0000000000000000',
  type: 'miniProgram',
  projectPath,
  privateKeyPath: fakeKeyPath,
  ignores: ['node_modules/**/*'],
});

const started = Date.now();
let result;
try {
  result = await getCompiledResult(
    {
      project,
      setting: { es6: true, enhance: true, minified: true, codeProtect: false },
      onProgressUpdate: (info) => {
        if (!asJson) process.stdout.write(`[compile] ${info}\n`);
      },
    },
    undefined
  );
} catch (err) {
  const message = err && err.message ? err.message : String(err);
  console.error('编译失败：' + message);
  if (err && err.stack && !asJson) console.error(err.stack);
  process.exit(1);
}

const files = Object.keys(result || {});
const totalBytes = files.reduce((sum, f) => sum + (result[f] ? result[f].length : 0), 0);

/**
 * 产物必须包含的东西：
 *  - app.json / app.js：入口
 *  - 至少一个页面（pages/...）
 *  - 演示数据模块（若工程里有 src/demo）
 */
const required = ['app.json', 'app.js'];
const missing = required.filter((f) => !files.includes(f));
const pageFiles = files.filter((f) => f.startsWith('pages/'));
const demoFiles = files.filter((f) => f.includes('demo/'));

/**
 * 断言一：产物里**不能残留 TypeScript 语法**。
 *
 * 为什么必须查：微信的编译流水线是**只转译、不做类型检查**的
 * （我们实测过：注入一个类型错误，编译照样「成功」——
 *   类型错误是由 `tsc --noEmit` 抓的，不是编译器抓的）。
 * 所以「编译成功」不等于「产物能跑」——
 * 如果 TS 没被转译，产物里会残留类型标注，小程序运行时直接崩。
 */
const TS_MARKERS = [
  /^\s*interface\s+\w+/m,
  /^\s*export\s+type\s+/m,
  /\bas\s+unknown\s+as\b/,
  /^\s*declare\s+(module|global)\b/m,
  /\bimplements\s+\w+/,
];
const tsLeaks = [];
for (const file of files) {
  if (!file.endsWith('.js')) continue;
  const text = result[file].toString('utf8');
  for (const re of TS_MARKERS) {
    if (re.test(text)) {
      tsLeaks.push(`${file} 命中 ${re}`);
      break;
    }
  }
}

/**
 * 断言二：演示兜底层必须真的进了包。
 *
 * 离线演示是这个预览版的兜底 —— 如果模块没进包，
 * 真机断网时会直接白屏，而不是回退到演示数据。
 */
const demoRequired = ['demo/router.js', 'demo/dataset.data.js'];
const demoMissing = demoRequired.filter((f) => !files.includes(f));

/**
 * 断言三：**每个源 .ts 都必须在产物里对应一个 .js**。
 *
 * 这是本检查最有价值的一条（真实踩到的大坑）：
 *   `project.config.json` 里 `ignoreUploadUnusedFiles: true` 时，
 *   微信编译器会把「看起来没被引用」的模块剪掉 ——
 *   但它**剪错了**：`services/index.ts`（所有页面 require 的桶文件）、
 *   `config/index.ts`（被 services/request.ts 引用）等 11 个模块被剪掉，
 *   编译「成功」，但包一打开就崩（module not found）。
 *   → 已把该开关置为 false；这条断言防止它再被打开。
 */
const srcRoot = resolve(projectPath, 'src');
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
let expectedJs = [];
try {
  expectedJs = walk(srcRoot)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.slice(srcRoot.length + 1).replace(/\.ts$/, '.js'));
} catch (err) {
  console.error(`读不到源目录 ${srcRoot}：${err.message}`);
  process.exit(1);
}
const dropped = expectedJs.filter((f) => !files.includes(f));

/**
 * 断言四（可选，由 `--expect-*` 开启）：**产物里的运行配置**必须与本次发布期望一致。
 *
 * 为什么必须看产物、而不是看源码：
 *   源码改了 ≠ 包里对了。编译器会转译、压缩、还可能把没被引用的模块剪掉
 *   （见上面的缺陷 #145）。唯一能证明「客户打开的包里配置是对的」的办法，
 *   是**在产物里找那个值**。
 *
 * 这道断言挡住的是最阴险的一类交付事故：
 *   基址没注入 → 小程序连的是 `127.0.0.1:3000` → 真机上一个接口都调不通；
 *   `USE_MOCK_LOGIN` 还是 true → 客户看到的不是自己的微信身份，而是演示账号；
 *   `DATA_MODE` 落在 `demo` → 全是假数据，演示效果与真实效果不一致。
 */
const configModuleText = files
  .filter((f) => f === 'config/index.js' || f.endsWith('/config/index.js'))
  .map((f) => result[f].toString('utf8'))
  .join('\n');
const bundleText = files
  .filter((f) => f.endsWith('.js'))
  .map((f) => result[f].toString('utf8'))
  .join('\n');

const configChecks = [];
if (expectApiBase) {
  configChecks.push({
    name: 'API 基址',
    expected: expectApiBase,
    ok: bundleText.includes(expectApiBase),
    hint: '产物里找不到这个基址 —— 客户端会连到别的地址（或 127.0.0.1），真机必然连不通',
  });
}
if (expectMockLogin) {
  // minify 后 false/true 可能被写成 !1 / !0，两种写法都要认
  const reTrue = /USE_MOCK_LOGIN[^;\n]{0,60}?(?:!0|\btrue\b)/;
  const reFalse = /USE_MOCK_LOGIN[^;\n]{0,60}?(?:!1|\bfalse\b)/;
  const wantFalse = expectMockLogin === 'false';
  const ok = wantFalse
    ? reFalse.test(configModuleText) && !reTrue.test(configModuleText)
    : reTrue.test(configModuleText) && !reFalse.test(configModuleText);
  configChecks.push({
    name: '登录方式',
    expected: `USE_MOCK_LOGIN = ${expectMockLogin}`,
    ok,
    hint:
      wantFalse
        ? '产物里 USE_MOCK_LOGIN 不是 false —— 客户会用「演示账号」而不是自己的微信身份登录'
        : '产物里 USE_MOCK_LOGIN 不是 true —— 与本次发布预期不符',
  });
}
if (expectDataMode) {
  const re = new RegExp(
    `DATA_MODE[^;\\n]{0,60}?['"]${expectDataMode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`,
  );
  configChecks.push({
    name: '数据模式',
    expected: `DATA_MODE = '${expectDataMode}'`,
    ok: re.test(configModuleText),
    hint: '产物里的 DATA_MODE 与本次发布预期不符（live / demo / auto）',
  });
}
const configFailed = configChecks.filter((c) => !c.ok);

const summary = {
  projectPath,
  files: files.length,
  bytes: totalBytes,
  pages: pageFiles.length,
  demoModules: demoFiles.length,
  missing,
  tsLeaks: tsLeaks.length,
  demoMissing,
  droppedModules: dropped.length,
  configChecks,
  configFailed: configFailed.length,
  elapsedMs: Date.now() - started,
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  log('=== 小程序离线编译自检 ===');
  log(`工程：${projectPath}`);
  log(`产物文件数：${summary.files}（页面 ${summary.pages} 个，演示模块 ${summary.demoModules} 个）`);
  log(`产物体积：${(totalBytes / 1024).toFixed(1)} KB`);
  log(`源模块全部入包：${summary.droppedModules === 0 ? '是 ✅' : '否 ❌'}`);
  for (const check of configChecks) {
    log(`产物配置 · ${check.name}：${check.ok ? '符合预期 ✅' : '不符合 ❌'}（期望 ${check.expected}）`);
  }
  log(`耗时：${summary.elapsedMs} ms`);
}

if (missing.length) {
  console.error('产物缺少关键文件：' + missing.join(', '));
  process.exit(1);
}
if (pageFiles.length === 0) {
  console.error('产物里没有任何页面文件 —— 编译结果不对');
  process.exit(1);
}
if (totalBytes < 1024) {
  console.error(`产物体积异常小（${totalBytes} 字节）`);
  process.exit(1);
}
if (tsLeaks.length) {
  console.error('产物里残留了 TypeScript 语法（说明没被转译，运行时必崩）：');
  for (const leak of tsLeaks.slice(0, 5)) console.error('  - ' + leak);
  process.exit(1);
}
if (demoMissing.length) {
  console.error('产物里缺少演示兜底模块：' + demoMissing.join(', '));
  process.exit(1);
}
if (dropped.length) {
  console.error(
    `产物里少了 ${dropped.length} 个源模块（编译把「未被引用」的模块剪掉了 —— ` +
      `小程序包会因 module not found 直接崩）：\n  - ` +
      dropped.join('\n  - ')
  );
  process.exit(1);
}

if (configFailed.length > 0) {
  console.error('产物里的运行配置与本次发布预期不符（客户端会连错地址 / 用错登录方式）：');
  for (const check of configFailed) {
    console.error(`  - ${check.name}：期望 ${check.expected} —— ${check.hint}`);
  }
  console.error('');
  console.error('产物的 config/index.js 片段（便于定位）：');
  console.error(configModuleText.slice(0, 1200) || '（产物里没有 config/index.js）');
  process.exit(1);
}

log('=== 离线编译通过 ✅（产物已转译，演示兜底模块已入包）===');
process.exit(0);
