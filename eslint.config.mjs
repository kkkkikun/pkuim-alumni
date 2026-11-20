// 仓库统一的 ESLint 扁平配置（ESLint 9 flat config）。
//
// 为什么现在才有这个文件：仓库原先有 `lint` 脚本（apps/api 里是 `eslint "src/**/*.ts"`），
// 但既没有 ESLint 依赖，也没有配置文件 —— 那两个 lint 脚本从来没跑通过。
// 补 CI 门禁时把这件事照了出来：与其让门禁里放一个空转的 lint 步骤，
// 不如把工具链真正装上、让 lint 成为有牙齿的门禁。
//
// 当前范围：TypeScript 源码（api / worker / admin-web 的 ts / contracts）。
// admin-web 的 .vue 单文件组件还没纳入 —— 需要 vue-eslint-parser 与 eslint-plugin-vue，
// 属独立的工单，先记在 docs/KNOWN-ISSUES.md，不在这里假装已覆盖。
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'],
  },
  {
    files: ['apps/*/src/**/*.ts', 'packages/*/src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
    },
    linterOptions: {
      // 仓库里留着一批 `// eslint-disable-next-line no-console`，
      // 而本配置并未启用 no-console；ESLint 9 默认会把这类「多余的抑制指令」
      // 报成 warning，26 条噪声会淹没真正的错误。这里关掉该报告，
      // 规则集本身仍然是 typescript-eslint recommended（error 级别）。
      reportUnusedDisableDirectives: 'off',
    },
  },
];
