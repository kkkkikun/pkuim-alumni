import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 放宽 `idempotency_records.scope` 的列长度（VARCHAR(64) → VARCHAR(255)）。
 *
 * 背景（缺陷 #140）：
 *   幂等 scope 原本由「方法 + **路由模板** + 用户 id」拼成，例如
 *   `PUT:/connections/:id/contact-grant:u3`（约 40 字符）。
 *   修复后 scope 改为「方法 + **实际路径**（含资源 id）+ 用户 id」，
 *   例如 `PUT:/api/v1/connections/17/contact-grant:u3`。
 *   实际路径更长 —— 长的路由（如 `/api/v1/admin/verification/applications/:id/decision`）
 *   加上 BIGINT id 与用户 id 后，scope 会**超过 64 字符**，
 *   MySQL 直接报 `Data too long for column 'scope'` → 幂等请求 500。
 *
 * 幂等：先查列的实际类型，已经是 VARCHAR(255) 就直接跳过，
 * 因此重复执行不会报错、也不会做无谓的 DDL。
 */
export class WidenIdempotencyScope1730000004000 implements MigrationInterface {
  name = 'WidenIdempotencyScope1730000004000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('idempotency_records'))) return;

    const current = await queryRunner.query(
      `SELECT CHARACTER_MAXIMUM_LENGTH AS len
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'idempotency_records'
          AND column_name = 'scope'`,
    );
    const len = Number(current?.[0]?.len ?? 0);
    if (len >= 255) return;

    await queryRunner.query(
      'ALTER TABLE `idempotency_records` MODIFY COLUMN `scope` VARCHAR(255) NOT NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('idempotency_records'))) return;
    await queryRunner.query(
      'ALTER TABLE `idempotency_records` MODIFY COLUMN `scope` VARCHAR(64) NOT NULL',
    ).catch(() => undefined);
  }
}
