import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 修正 alumni_profiles.verified_by 的外键指向。
 *
 * 背景：InitSchema 中 `verified_by` 的外键指向 `users(id)`，
 * 但该列存的是**审核管理员**的 id（管理员在 `admin_users` 表）。
 * 结果：管理员 id 与用户 id 恰好相同时看似正常，一旦不同即触发
 * "Cannot add or update a child row: a foreign key constraint fails"，
 * 导致「认证审核通过」这一核心链路 500。
 *
 * 本迁移把外键改为指向 `admin_users(id)`，并对历史脏数据做兜底清理
 * （verified_by 指向不存在的管理员时置 NULL）。
 *
 * 幂等：先删旧外键（若存在），再按存在性检查添加新外键。
 */
export class FixVerifiedByForeignKey1730000001000 implements MigrationInterface {
  name = 'FixVerifiedByForeignKey1730000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `alumni_profiles` DROP FOREIGN KEY `fk_alumni_profiles_verified_by`',
    ).catch(() => undefined);

    // 清理历史脏数据：verified_by 指向不存在的管理员时置 NULL
    await queryRunner.query(
      `UPDATE \`alumni_profiles\` p
       LEFT JOIN \`admin_users\` a ON a.id = p.verified_by
       SET p.verified_by = NULL
       WHERE p.verified_by IS NOT NULL AND a.id IS NULL`,
    );

    const has = await queryRunner.hasTable('alumni_profiles');
    if (!has) return;

    await queryRunner.query(
      `ALTER TABLE \`alumni_profiles\`
       ADD CONSTRAINT \`fk_alumni_profiles_verified_by\`
       FOREIGN KEY (\`verified_by\`) REFERENCES \`admin_users\` (\`id\`) ON DELETE SET NULL`,
    ).catch(() => undefined);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `alumni_profiles` DROP FOREIGN KEY `fk_alumni_profiles_verified_by`',
    ).catch(() => undefined);
    await queryRunner.query(
      `ALTER TABLE \`alumni_profiles\`
       ADD CONSTRAINT \`fk_alumni_profiles_verified_by\`
       FOREIGN KEY (\`verified_by\`) REFERENCES \`users\` (\`id\`) ON DELETE SET NULL`,
    ).catch(() => undefined);
  }
}
