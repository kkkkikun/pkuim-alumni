import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 补录认证流程记录，使 `users.stage` 与认证申请/审核记录自洽。
 *
 * 背景：
 *   业务不变量（由服务层强制，见 `alumni.service.ts`）：
 *     - 提交认证申请        → 申请 status='pending'，user.stage='pending_review'
 *     - 重新提交（补材料）  → 申请 status='resubmitted'，user.stage='pending_review'
 *     - 审核通过            → 申请 status='approved'，user.stage='verified'，profile.verified=1
 *     - 退回补充 / 驳回     → 申请 status='needs_more_material'/'rejected'，user.stage='logged_in'
 *
 *   但种子数据按 60% / 25% / 15% **随机分配** users.stage，
 *   另生成 40 条**随机状态**的认证申请，两者互不关联，于是：
 *     - 801 个 stage='verified' 的用户里只有 8 条 approved 申请（793 条流程记录缺失）；
 *     - 242 个 stage='pending_review' 的用户里只有 24 条在途申请（218 条缺失）；
 *     - 24 条申请（approved / pending / resubmitted）的用户 stage 却是 'logged_in'（矛盾）。
 *
 *   后果：管理端「身份审核」与通讯录的已认证人数对不上；任何基于认证记录的
 *   统计、审计、追溯都会与 users.stage 冲突。
 *
 * 处置（全部幂等）：
 *   1. 先按**既有申请记录**修正用户 stage（含 profile.verified 同步）；
 *   2. 再按**既有 stage**补录缺失的申请与审核记录。
 *
 * down()：补录的申请与审核记录可按 remark 标记精确删除；
 *         但第 1 步对 stage 的修正无法还原（原始值未被记录），属于**不可逆**变更，
 *         如需完全回退请从备份恢复。
 */
export class BackfillVerificationHistory1730000003000 implements MigrationInterface {
  name = 'BackfillVerificationHistory1730000003000';

  private static readonly MARK = '【历史数据补录】';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('verification_applications'))) return;
    if (!(await queryRunner.hasTable('users'))) return;

    const mark = BackfillVerificationHistory1730000003000.MARK;

    /* ---- 1. 按既有申请记录修正用户 stage ---------------------------------- */

    // 1a. 有 approved 申请 → stage 应为 verified
    await queryRunner.query(
      `UPDATE \`users\` u
       JOIN \`verification_applications\` a ON a.user_id = u.id AND a.status = 'approved'
       SET u.stage = 'verified'
       WHERE u.stage <> 'verified'`,
    );

    // 1b. 有在途申请（pending / resubmitted）→ stage 应为 pending_review
    //     （已认证用户不降级，避免覆盖 1a 的结果）
    await queryRunner.query(
      `UPDATE \`users\` u
       JOIN \`verification_applications\` a
         ON a.user_id = u.id AND a.status IN ('pending', 'resubmitted')
       SET u.stage = 'pending_review'
       WHERE u.stage NOT IN ('verified', 'pending_review')`,
    );

    // 1c. 档案侧同步：stage='verified' 的用户，profile.verified 必须为 1
    if (await queryRunner.hasTable('alumni_profiles')) {
      await queryRunner.query(
        `UPDATE \`alumni_profiles\` p
         JOIN \`users\` u ON u.id = p.user_id
         SET p.verified = 1,
             p.verified_at = COALESCE(
               p.verified_at,
               (SELECT MIN(a.decided_at) FROM \`verification_applications\` a
                 WHERE a.user_id = u.id AND a.status = 'approved')
             ),
             p.verified_by = COALESCE(
               p.verified_by,
               (SELECT a.decided_by FROM \`verification_applications\` a
                 WHERE a.user_id = u.id AND a.status = 'approved' ORDER BY a.id LIMIT 1)
             )
         WHERE u.stage = 'verified' AND p.verified = 0`,
      );
    }

    /* ---- 2. 按既有 stage 补录缺失的申请与审核记录 ------------------------ */

    // 2a. stage='verified' 且没有 approved 申请 → 补一条 approved 申请
    await queryRunner.query(
      `INSERT INTO \`verification_applications\`
         (\`user_id\`, \`real_name\`, \`college\`, \`graduation_year\`, \`degree\`,
          \`student_id_masked\`, \`remark\`, \`status\`, \`decided_by\`, \`decision_note\`,
          \`submitted_at\`, \`decided_at\`, \`version\`, \`created_at\`, \`updated_at\`)
       SELECT u.id,
              COALESCE(NULLIF(p.real_name, ''), p.display_name, u.nickname),
              COALESCE(NULLIF(p.college, ''), '未填写'),
              COALESCE(p.graduation_year, 2015),
              p.degree,
              CONCAT('SN', LPAD(u.id, 8, '0')),
              '${mark}该用户在补录前已是已认证校友，但缺少对应的认证申请与审核记录。',
              'approved',
              (SELECT id FROM \`admin_users\` ORDER BY id LIMIT 1),
              '${mark}按既有 stage 状态补录通过记录。',
              COALESCE(p.verified_at, u.created_at),
              COALESCE(p.verified_at, u.created_at),
              0, NOW(3), NOW(3)
       FROM \`users\` u
       JOIN \`alumni_profiles\` p ON p.user_id = u.id
       WHERE u.stage = 'verified'
         AND NOT EXISTS (
           SELECT 1 FROM \`verification_applications\` a
           WHERE a.user_id = u.id AND a.status = 'approved'
         )`,
    );

    // 2b. 补齐对应的「审核通过」审核记录
    await queryRunner.query(
      `INSERT INTO \`verification_reviews\`
         (\`application_id\`, \`admin_id\`, \`action\`, \`note\`, \`snapshot_version\`, \`created_at\`)
       SELECT a.id,
              COALESCE(a.decided_by, (SELECT id FROM \`admin_users\` ORDER BY id LIMIT 1)),
              'approve',
              '${mark}按既有 stage 状态补录审核通过记录。',
              a.version,
              COALESCE(a.decided_at, NOW(3))
       FROM \`verification_applications\` a
       WHERE a.status = 'approved'
         AND a.remark LIKE '${mark}%'
         AND NOT EXISTS (
           SELECT 1 FROM \`verification_reviews\` r WHERE r.application_id = a.id
         )`,
    );

    // 2c. stage='pending_review' 且没有在途申请 → 补一条 pending 申请
    await queryRunner.query(
      `INSERT INTO \`verification_applications\`
         (\`user_id\`, \`real_name\`, \`college\`, \`graduation_year\`, \`degree\`,
          \`student_id_masked\`, \`remark\`, \`status\`, \`submitted_at\`, \`version\`,
          \`created_at\`, \`updated_at\`)
       SELECT u.id,
              COALESCE(NULLIF(p.real_name, ''), p.display_name, u.nickname),
              COALESCE(NULLIF(p.college, ''), '未填写'),
              COALESCE(p.graduation_year, 2015),
              p.degree,
              CONCAT('SN', LPAD(u.id, 8, '0')),
              '${mark}该用户在补录前已处于待审核状态，但缺少对应的认证申请记录。',
              'pending',
              u.created_at, 0, NOW(3), NOW(3)
       FROM \`users\` u
       JOIN \`alumni_profiles\` p ON p.user_id = u.id
       WHERE u.stage = 'pending_review'
         AND NOT EXISTS (
           SELECT 1 FROM \`verification_applications\` a
           WHERE a.user_id = u.id AND a.status IN ('pending', 'resubmitted')
         )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('verification_applications'))) return;
    const mark = `${BackfillVerificationHistory1730000003000.MARK}%`;

    // 删除补录的审核记录
    await queryRunner.query(
      `DELETE r FROM \`verification_reviews\` r
       JOIN \`verification_applications\` a ON a.id = r.application_id
       WHERE a.remark LIKE ?`,
      [mark],
    );
    // 删除补录的申请记录
    await queryRunner.query(
      `DELETE FROM \`verification_applications\` WHERE \`remark\` LIKE ?`,
      [mark],
    );
    // 注意：第 1 步对 users.stage 的修正**不可逆**（原始值未被记录），
    // 如需完全回退请从备份恢复。
  }
}
