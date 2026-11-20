/**
 * ESLint 扁平配置（flat config）。
 *
 * ⚠️ 为什么现在才有：仓库的 `lint` 脚本一直存在（`apps/api` 是 `eslint "src/…"`），
 *    但**既没有 eslint 依赖，也没有任何 ESLint 配置文件** ——
 *    `pnpm lint` 从来只会报 `eslint: not found` 并以退出码 1 结束。
 *    主干新增的 CI 门禁里就有一步 `pnpm lint`，于是**任何 PR 的 CI 都必然变红**。
 *    （见 `docs/KNOWN-ISSUES.md` #172）
 *
 * 规则集：ESLint 官方 recommended + typescript-eslint recommended + prettier（关闭与 prettier 冲突的格式规则）。
 * 没有加类型信息（`project`）—— 规则不依赖类型，lint 才跑得快。
 *
 * 作用域：**Node 侧的 TypeScript 代码**（API / Worker / 契约包 / API 测试）。
 * 小程序（`apps/miniprogram`）不在范围内：它在微信运行时里跑，
 * `Page` / `wx` / `App` 等是运行时注入的全局对象，由 `apps/miniprogram` 自己声明类型；
 * 管理后台（`apps/admin-web`）是 Vue SFC，由 `vue-tsc --noEmit` 与 `check-admin-web.mjs` 把关。
 */
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const prettier = require('eslint-config-prettier');

module.exports = tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/*.d.ts',
      'apps/miniprogram/**',
      'apps/admin-web/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    // TypeScript 自己会检查未定义标识符，`no-undef` 在 TS 文件里是误报源。
    rules: {
      'no-undef': 'off',
      // 控制台输出只在「脚本 / 启动日志」里允许：
      // 仓库里已有的 `eslint-disable no-console` 注释说明这条规则本来就该开着
      // （seed.ts 是文件级豁免，main.ts 与 config-validation.ts 是单行豁免）。
      'no-console': 'error',
      // 未使用的**参数**：约定用 `_` 前缀表示「故意不用」。
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
