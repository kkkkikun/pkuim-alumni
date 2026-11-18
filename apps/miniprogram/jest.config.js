const path = require('node:path');

/**
 * 小程序端单元测试配置（缺陷 #154 的对照用例）。
 *
 * 为什么单独一个 jest 配置：
 *   小程序包（apps/miniprogram）**没有自己的 jest 依赖** ——
 *   加依赖会动 package.json + pnpm-lock.yaml，
 *   而 pnpm-lock.yaml 在同步到服务器时是被**排除**的（rsync --exclude），
 *   服务器上 `pnpm install --frozen-lockfile` 会直接失败。
 *   所以这里**复用 api 包里已经装好的 jest / ts-jest**，
 *   不引入任何新依赖。
 *
 * 被测对象是**生产代码本体**（src/utils/format.ts、src/utils/view.ts），
 * 不是复制品 —— 满足「测试必须与生产同构」。
 */
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: {
    '^.+\\.ts$': [
      require.resolve('ts-jest', { paths: [path.join(__dirname, '../api')] }),
      {
        tsconfig: path.join(__dirname, 'tsconfig.test.json'),
        // 测试文件里的 jest 全局类型来自 api 的 @types/jest，
        // 而 ts-jest 的类型检查只针对被测文件，测试文件本身由 tsc 单独把关。
        diagnostics: false,
      },
    ],
  },
};
