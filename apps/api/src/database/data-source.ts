import 'reflect-metadata';

import { DataSource, DataSourceOptions } from 'typeorm';

import { entities } from './entities';
// ⚠️ 迁移清单**只有一份**（缺陷 #143）：
//    之前这里**另抄了一份**类名数组，与 `migrations/index.ts` 并列存在 ——
//    两份手工维护的清单迟早会不同步，而**真正去应用迁移的是这个文件**
//    （`typeorm-ts-node-commonjs -d src/database/data-source.ts migration:run`）。
//    一旦漏加，新增的迁移就**永远不会被应用** → 代码与库表结构悄悄漂移。
//    现在统一从 `migrations/index.ts` 取，两边不可能再不一致。
import { migrations } from './migrations';

/**
 * 数据源配置。
 *
 * 环境变量：
 * - DATABASE_URL（优先）：mysql://user:pass@host:port/dbname
 * - 或 DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
 *
 * 生产环境禁止 synchronize（见 DATABASE-DESIGN.md 通用约定）。
 */
interface MysqlConnectionOptions {
  url?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
}

function resolveConnection(): MysqlConnectionOptions {
  const url = process.env.DATABASE_URL;

  if (url && url.trim().length > 0) {
    return { url: url.trim() };
  }

  return {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number.parseInt(process.env.DB_PORT ?? '3306', 10),
    username: process.env.DB_USER ?? 'nmg',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'nmg_pku_alumni',
  };
}

function resolveLogging(): DataSourceOptions['logging'] {
  if (process.env.DB_LOGGING === 'true') {
    return ['query', 'error', 'warn'];
  }
  switch (process.env.NODE_ENV) {
    case 'development':
      return ['query', 'error', 'warn', 'schema'];
    case 'test':
      return ['error'];
    default:
      return ['error'];
  }
}

export const dataSourceOptions: DataSourceOptions = {
  type: 'mysql',
  ...resolveConnection(),
  charset: 'utf8mb4',
  timezone: 'Z',
  entities,
  // 迁移清单来自 `./migrations`（单一事实来源，见文件头的说明）
  migrations,
  migrationsTableName: 'migrations',
  synchronize: false,
  migrationsRun: false,
  logging: resolveLogging(),
  extra: {
    // BIGINT UNSIGNED 主键以 number 返回，避免字符串化带来的类型不一致
    supportBigNumbers: true,
    bigNumberStrings: false,
  },
};

/**
 * API 与迁移、Seed 共用的 DataSource 实例。
 *
 * 注意：本模块**只导出一个** DataSource 实例（不要再加 `export default`），
 * 否则 TypeORM CLI 加载数据源时会报 “Multiple DataSource instances found”。
 */
export const AppDataSource = new DataSource(dataSourceOptions);
