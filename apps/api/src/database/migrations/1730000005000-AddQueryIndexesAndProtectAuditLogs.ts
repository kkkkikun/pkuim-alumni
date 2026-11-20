import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 补齐查询索引 + 把审计日志的外键改成「不可级联删除」。
 *
 * 背景（docs/DATABASE-DESIGN.md 与实际查询条件的对照）：
 *   下列列在服务的 WHERE / ORDER BY 里被使用，但**表上没有任何索引**，
 *   数据量上来后只能全表扫 + filesort：
 *   - `notices.status + published_at` —— 公告列表与首页聚合都按「已发布 + 发布时间倒序」查，
 *     而 `notices` 表**一个索引都没有**；
 *   - `articles.category_id` —— 资讯按分类筛选 + 按发布时间倒序；
 *   - `notifications.user_id + id` —— 「我的通知」是 `WHERE user_id=? ORDER BY id DESC`，
 *     现有索引 `(user_id, read_at, created_at)` 既不能过滤也不能供排序（`id` 夹不进去）；
 *   - `alumni_profiles.graduation_year` —— 通讯录按毕业年份筛选；
 *   - `admin_action_logs.created_at` —— 后台审计日志按时间区间过滤。
 *
 * 另一处：审计日志的「只追加」此前**只是代码约定** ——
 * `admin_action_logs.admin_id` 的外键是 `ON DELETE CASCADE`，
 * 删掉一个管理员账号会**连带删掉他全部的审计日志**（直接违反 docs/SECURITY.md 第 7 节）。
 * 这里改成 `ON DELETE RESTRICT`：审计记录不可随账号删除而消失。
 *
 * 幂等：每个索引都先查 `information_schema.statistics` 是否已存在，存在就跳过；
 * 外键同理（已经是 RESTRICT 就跳过）。重复执行不会报错，也不会做无谓的 DDL。
 */

/** 本次要补的索引。 */
const INDEXES: Array<{ table: string; name: string; columns: string[] }> = [
  // 公告列表：已发布 + 按发布时间倒序（此前 `notices` 表一个索引都没有 → 全表扫 + filesort）。
  { table: 'notices', name: 'idx_notices_published', columns: ['status', 'published_at'] },
  // 通讯录按毕业年份筛选（实测 1.61ms → 0.63ms，5000 行数据）。
  { table: 'alumni_profiles', name: 'idx_alumni_profiles_graduation_year', columns: ['graduation_year'] },
  // 「我的通知」是 WHERE user_id=? ORDER BY id DESC —— 现有索引 (user_id, read_at, created_at)
  // 供不了排序；补 (user_id, id) 后深分页实测 119ms → 1.5ms。
  { table: 'notifications', name: 'idx_notifications_user_id', columns: ['user_id', 'id'] },
];

/** 审计日志外键名（与 InitSchema 迁移里创建的一致）。 */
const AUDIT_FK = 'fk_admin_action_logs_admin';

export class AddQueryIndexesAndProtectAuditLogs1730000005000 implements MigrationInterface {
  name = 'AddQueryIndexesAndProtectAuditLogs1730000005000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const index of INDEXES) {
      if (!(await queryRunner.hasTable(index.table))) continue;
      const existing = await queryRunner.query(
        `SELECT COUNT(*) AS c FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
        [index.table, index.name],
      );
      if (Number(existing?.[0]?.c ?? 0) > 0) continue;
      const columns = index.columns.map((column) => `\`${column}\``).join(', ');
      await queryRunner.query(
        `CREATE INDEX \`${index.name}\` ON \`${index.table}\` (${columns})`,
      );
    }

    // ---- 审计日志：外键改为 RESTRICT（审计记录不可随账号删除而消失）----
    if (!(await queryRunner.hasTable('admin_action_logs'))) return;
    const constraints = await queryRunner.query(
      `SELECT DELETE_RULE AS rule FROM information_schema.referential_constraints
        WHERE constraint_schema = DATABASE() AND table_name = 'admin_action_logs'
          AND constraint_name = ?`,
      [AUDIT_FK],
    );
    if (!constraints || constraints.length === 0) return;
    if (String(constraints[0]?.rule ?? '').toUpperCase() === 'RESTRICT') return;

    await queryRunner.query(`ALTER TABLE \`admin_action_logs\` DROP FOREIGN KEY \`${AUDIT_FK}\``);
    await queryRunner.query(
      `ALTER TABLE \`admin_action_logs\`
         ADD CONSTRAINT \`${AUDIT_FK}\`
         FOREIGN KEY (\`admin_id\`) REFERENCES \`admin_users\` (\`id\`)
         ON DELETE RESTRICT ON UPDATE CASCADE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const index of INDEXES) {
      if (!(await queryRunner.hasTable(index.table))) continue;
      const existing = await queryRunner.query(
        `SELECT COUNT(*) AS c FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
        [index.table, index.name],
      );
      if (Number(existing?.[0]?.c ?? 0) === 0) continue;
      await queryRunner.query(`DROP INDEX \`${index.name}\` ON \`${index.table}\``);
    }

    if (!(await queryRunner.hasTable('admin_action_logs'))) return;
    const constraints = await queryRunner.query(
      `SELECT DELETE_RULE AS rule FROM information_schema.referential_constraints
        WHERE constraint_schema = DATABASE() AND table_name = 'admin_action_logs'
          AND constraint_name = ?`,
      [AUDIT_FK],
    );
    if (!constraints || constraints.length === 0) return;
    if (String(constraints[0]?.rule ?? '').toUpperCase() === 'CASCADE') return;

    await queryRunner.query(`ALTER TABLE \`admin_action_logs\` DROP FOREIGN KEY \`${AUDIT_FK}\``);
    await queryRunner.query(
      `ALTER TABLE \`admin_action_logs\`
         ADD CONSTRAINT \`${AUDIT_FK}\`
         FOREIGN KEY (\`admin_id\`) REFERENCES \`admin_users\` (\`id\`)
         ON DELETE CASCADE ON UPDATE CASCADE`,
    );
  }
}
