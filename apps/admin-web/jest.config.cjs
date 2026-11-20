const path = require('node:path');

/**
 * 管理后台单元测试配置（第三轮新增）。
 *
 * 为什么单独一个 jest 配置、为什么复用 api 包的 jest：
 *   - 管理后台包（apps/admin-web）**没有自己的 jest 依赖** ——
 *     加依赖会动 package.json + pnpm-lock.yaml，
 *     而 pnpm-lock.yaml 在同步到服务器时是被**排除**的（rsync --exclude），
 *     服务器上 `pnpm install --frozen-lockfile` 会直接失败。
 *     所以这里**复用 api 包里已经装好的 jest / ts-jest**，不引入任何新依赖
 *     （与 apps/miniprogram/jest.config.js 的做法一致）。
 *   - 被测对象是**生产代码本体**（src/api/page-result.ts），不是复制品 ——
 *     满足「测试必须与生产同构」。
 */
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  // `@nmg/contracts` 是工作区包（源码直出），测试里要能 import 到。
  moduleNameMapper: {
    '^@nmg/contracts$': '<rootDir>/../../packages/contracts/src/index.ts',
  },
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
