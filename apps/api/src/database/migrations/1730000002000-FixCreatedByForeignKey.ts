import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 修正 events / articles / notices / resource_posts 的 `created_by` 外键指向。
 *
 * 背景：这四张表的 `created_by` 列在 InitSchema 中外键指向 `users(id)`，
 * 但服务层写入的是**管理员 id**（`admin.id`，管理员在 `admin_users` 表）：
 *   - events.service.create()          → createdBy: adminId
 *   - content.service.adminCreateArticle() / adminCreateNotice() → createdBy: adminId
 *
 * 后果：
 *   1. 测试库（users 表被 TRUNCATE）里写入必然触发外键失败 → 500；
 *   2. 业务库里「恰好存在同 id 的用户」时写入成功，但这一列实际指向的是**无关用户**，
 *      语义错误且会在该用户被删除时被 ON DELETE SET NULL 抹掉。
 *
 * 与 1730000001000-FixVerifiedByForeignKey 同源（管理员体系独立于用户体系）。
 *
 * 处置：把 `created_by` 的外键改指向 `admin_users(id)`；
 *      历史脏数据（指向不存在的管理员）统一置 NULL。
 *
 * 幂等：先删旧外键（若存在）→ 清理脏数据 → 按存在性添加新外键。
 */
export class FixCreatedByForeignKey1730000002000 implements MigrationInterface {
  name = 'FixCreatedByForeignKey1730000002000';

  private static readonly TABLES = [
    { table: 'events', fk: 'fk_events_created_by' },
    { table: 'articles', fk: 'fk_articles_created_by' },
    { table: 'notices', fk: 'fk_notices_created_by' },
    { table: 'resource_posts', fk: 'fk_resource_posts_created_by' },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const { table, fk } of FixCreatedByForeignKey1730000002000.TABLES) {
      const hasTable = await queryRunner.hasTable(table);
      if (!hasTable) continue;

      await queryRunner
        .query(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${fk}\``)
        .catch(() => undefined);

      // 清理历史脏数据：created_by 指向不存在的管理员时置 NULL
      await queryRunner.query(
        `UPDATE \`${table}\` t
         LEFT JOIN \`admin_users\` a ON a.id = t.created_by
         SET t.created_by = NULL
         WHERE t.created_by IS NOT NULL AND a.id IS NULL`,
      );

      await queryRunner
        .query(
          `ALTER TABLE \`${table}\`
           ADD CONSTRAINT \`${fk}\`
           FOREIGN KEY (\`created_by\`) REFERENCES \`admin_users\` (\`id\`) ON DELETE SET NULL`,
        )
        .catch(() => undefined);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const { table, fk } of FixCreatedByForeignKey1730000002000.TABLES) {
      const hasTable = await queryRunner.hasTable(table);
      if (!hasTable) continue;
      await queryRunner
        .query(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${fk}\``)
        .catch(() => undefined);
      await queryRunner
        .query(
          `ALTER TABLE \`${table}\`
           ADD CONSTRAINT \`${fk}\`
           FOREIGN KEY (\`created_by\`) REFERENCES \`users\` (\`id\`) ON DELETE SET NULL`,
        )
        .catch(() => undefined);
    }
  }
}
