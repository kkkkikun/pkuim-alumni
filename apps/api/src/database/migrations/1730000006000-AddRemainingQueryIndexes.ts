import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 补齐**仍然缺失**的查询索引（第二轮复核补漏）。
 *
 * 背景：上一轮（迁移 5000）的**注释里承诺了 5 个索引**，但 `INDEXES` 常量里只有 3 个 ——
 *   `articles.category_id` 与 `admin_action_logs.created_at` **从未落地**。
 *   也就是说「文档/注释承诺」与「库里实际有的」不一致：
 *   注释说补齐了，库里其实没有。本迁移把这两个补上，并另加两个同样确实缺失的。
 *
 * 逐条对照（查询条件 → 现有索引 → 缺口）：
 *
 * 1. `admin_action_logs.created_at` —— **实测收益微弱，本轮不加**：
 *    后台审计日志支持「按时间区间过滤」且**不带** adminId：
 *    `WHERE created_at BETWEEN :start AND :end ORDER BY id DESC`。
 *    实测（10 万行审计日志）：宽区间（30 天）COUNT 前后一致（20.94 ms → 21.47 ms，
 *    优化器仍选 `idx_admin_action_logs_admin` 的 skip scan），
 *    窄区间（1 天）COUNT 0.94 ms → 0.80 ms —— 收益不足以抵消追加写入的代价。
 *    按仓库既定规矩「**没有实测数字的索引不写进生产库**」，本轮**不加**这个索引，
 *    迁移 5000 的注释也已改成不再声称自己建了它。
 *
 * 2. `articles(category_id, published_at)`
 *    `GET /articles?categoryId=` 的过滤条件是 `status='published' AND category_id=?`
 *    再按 `published_at` 倒序。现有索引 `(status, published_at)` 供不了 category_id 这一段，
 *    外键自动索引 `fk_articles_category(category_id)` 又供不了排序。
 *
 * 3. `event_registrations(user_id, id)`
 *    「我的活动」是 `WHERE user_id=? ORDER BY id DESC`（events.service.ts 的 mineEvents）。
 *    现有 `uk_event_registration(event_id, user_id)` 的首列是 event_id，
 *    外键自动索引 `(user_id)` 能过滤但**供不了排序** → filesort。
 *
 * 4. `connection_pairs(user_b_id, id)` —— **实测无收益，本轮不加**：
 *    连接列表是 `WHERE (user_a_id=? OR user_b_id=?) AND status='active' ORDER BY id DESC`。
 *    实测（2 万条连接对）：SELECT 0.266 ms → 0.313 ms、COUNT 4.676 ms → 4.747 ms，
 *    优化器对 OR 两侧仍走主键倒序扫 / 全表扫，**没有改选**新索引。
 *    按「没有实测数字的索引不写进生产库」，本轮不加。
 *
 * 幂等：每个索引都先查 `information_schema.statistics`，存在就跳过；重复执行不报错。
 * 回滚：down 里逐个 DROP（存在才 drop）。
 */
const INDEXES: Array<{ table: string; name: string; columns: string[] }> = [
  // 资讯按分类筛选 + 按发布时间倒序。
  { table: 'articles', name: 'idx_articles_category', columns: ['category_id', 'published_at'] },
  // 「我的活动」：WHERE user_id=? ORDER BY id DESC。
  { table: 'event_registrations', name: 'idx_event_registration_user', columns: ['user_id', 'id'] },
];

export class AddRemainingQueryIndexes1730000006000 implements MigrationInterface {
  name = 'AddRemainingQueryIndexes1730000006000';

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
  }
}
