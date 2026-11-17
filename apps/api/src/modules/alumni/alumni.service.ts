import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, EntityManager, In, Repository } from 'typeorm';
import { paginate } from '../../common/dto/pagination.dto';
import type { PageResult } from '../../common/dto/pagination.dto';
import { AdminUser } from '../../database/entities/admin.entity';
import { AlumniProfile } from '../../database/entities/alumni.entity';
import { User } from '../../database/entities/user.entity';
import {
  VerificationApplication,
  VerificationAttachment,
  VerificationReview,
} from '../../database/entities/verification.entity';
import { MediaAsset } from '../../database/entities/system.entity';
import { NotificationService } from '../notifications/notification.service';
import type { SubmitVerificationDto, VerificationDecisionDto } from './dto/verification.dto';

export interface VerificationView {
  id: number;
  userId: number;
  applicantName: string;
  college: string | null;
  graduationYear: number | null;
  degree: string | null;
  studentIdMasked: string | null;
  status: string;
  attachments: {
    id: number;
    mediaId: number;
    fileName: string;
    mimeType: string;
    size: number;
    uploadedAt: Date;
  }[];
  reviews: {
    id: number;
    adminId: number;
    adminName: string;
    action: string;
    note: string | null;
    snapshotVersion: number;
    createdAt: Date;
  }[];
  submittedAt: Date;
  decidedAt: Date | null;
}

@Injectable()
export class AlumniVerificationService {
  constructor(
    @InjectRepository(VerificationApplication)
    private readonly applications: Repository<VerificationApplication>,
    @InjectRepository(VerificationAttachment)
    private readonly attachments: Repository<VerificationAttachment>,
    @InjectRepository(VerificationReview) private readonly reviews: Repository<VerificationReview>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(AlumniProfile) private readonly profiles: Repository<AlumniProfile>,
    @InjectRepository(AdminUser) private readonly admins: Repository<AdminUser>,
    @InjectRepository(MediaAsset) private readonly mediaAssets: Repository<MediaAsset>,
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationService,
  ) {}

  /** 提交认证申请。同一用户同时只允许一条进行中的申请。 */
  async submit(userId: number, dto: SubmitVerificationDto): Promise<VerificationView> {
    const pending = await this.applications.findOne({
      where: { userId, status: 'pending' },
      order: { id: 'DESC' },
    });
    if (pending) {
      throw new ConflictException('已有进行中的认证申请，请等待审核结果');
    }
    // 申请写入、附件挂载、用户状态变更与通知**同事务**（缺陷 #99）：
    // 否则通知写失败时申请已提交 → 用户提交成功却永远收不到「已受理」通知。
    const application = await this.dataSource.transaction(async (manager) => {
      const applications = manager.getRepository(VerificationApplication);
      const attachments = manager.getRepository(VerificationAttachment);
      const users = manager.getRepository(User);

      const created = await applications.save(
        applications.create({
          userId,
          realName: dto.realName,
          college: dto.college,
          graduationYear: dto.graduationYear,
          degree: dto.degree ?? null,
          studentIdMasked: dto.studentIdMasked,
          remark: dto.remark ?? null,
          status: 'pending',
          submittedAt: new Date(),
        }),
      );
      const mediaIds = await this.assertOwnedMedia(userId, dto.attachmentMediaIds);
      if (mediaIds?.length) {
        await attachments.save(
          mediaIds.map((mediaId) => attachments.create({ applicationId: created.id, mediaId })),
        );
      }
      // 用户身份进入待审核
      await users.update({ id: userId }, { stage: 'pending_review' });

      await this.notifications.push(
        userId,
        'verification_submitted',
        '认证申请已提交',
        '我们已收到你的校友身份认证申请，管理员会尽快完成审核。',
        { applicationId: created.id },
        { eventType: 'verification.submitted', aggregateType: 'verification', aggregateId: String(created.id) },
        manager,
      );
      return created;
    });

    return this.toView(application);
  }

  async detail(id: number, viewerId: number, isAdmin: boolean): Promise<VerificationView> {
    const application = await this.applications.findOne({ where: { id } });
    if (!application) throw new NotFoundException('认证申请不存在');
    if (!isAdmin && application.userId !== viewerId) {
      throw new ForbiddenException('无权查看该认证申请');
    }
    return this.toView(application);
  }

  /**
   * 认证审核历史（只追加，不覆盖）。
   * 本人可看自己的申请，审核员可看全部。
   */
  async history(
    id: number,
    viewerId: number,
    isAdmin: boolean,
  ): Promise<VerificationView['reviews']> {
    const application = await this.applications.findOne({ where: { id } });
    if (!application) throw new NotFoundException('认证申请不存在');
    if (!isAdmin && application.userId !== viewerId) {
      throw new ForbiddenException('无权查看该认证申请');
    }
    const rows = await this.reviews.find({
      where: { applicationId: id },
      order: { id: 'ASC' },
    });
    const adminNames = await this.adminNames(rows.map((row) => row.adminId));
    return rows.map((row) => ({
      id: row.id,
      adminId: row.adminId,
      adminName: adminNames.get(row.adminId) ?? '未知管理员',
      action: row.action,
      note: row.note,
      snapshotVersion: row.snapshotVersion,
      createdAt: row.createdAt,
    }));
  }

  async mine(userId: number): Promise<VerificationView[]> {
    const rows = await this.applications.find({
      where: { userId },
      order: { id: 'DESC' },
    });
    return Promise.all(rows.map((row) => this.toView(row)));
  }

  /**
   * 我的认证申请（分页）。
   *
   * 契约与小程序都按 `PageResult<VerificationApplicationDto>` 消费
   * （`GET /me/verifications`），而 `mine()` 返回的是裸数组 ——
   * 小程序「认证历史」页取 `result.items` 得到 undefined → 列表恒空。
   * 详见 KNOWN-ISSUES #70。
   *
   * 注意：`mine()` 仍保持数组形态，供管理端详情（`verifications` 字段）使用。
   */
  async minePaged(
    userId: number,
    page = 1,
    pageSize = 20,
  ): Promise<PageResult<VerificationView>> {
    const qb = this.applications
      .createQueryBuilder('app')
      .where('app.userId = :userId', { userId })
      .orderBy('app.id', 'DESC');
    const total = await qb.getCount();
    const rows = await qb.skip((page - 1) * pageSize).take(pageSize).getMany();
    const views = await Promise.all(rows.map((row) => this.toView(row)));
    return paginate(views, total, page, pageSize);
  }

  async adminList(params: {
    page: number;
    pageSize: number;
    status?: string;
    keyword?: string;
  }): Promise<PageResult<VerificationView>> {
    const qb = this.applications
      .createQueryBuilder('app')
      .orderBy('app.id', 'DESC');
    if (params.status) {
      qb.andWhere('app.status = :status', { status: params.status });
    }
    // 关键字：申请人真实姓名 / 学院 / 学号 / 学历（后台「认证审核」页的搜索框）
    // 详见 KNOWN-ISSUES #63
    if (params.keyword?.trim()) {
      const keyword = `%${params.keyword.trim()}%`;
      qb.andWhere(
        new Brackets((where) => {
          where
            .orWhere('app.realName LIKE :keyword', { keyword })
            .orWhere('app.college LIKE :keyword', { keyword })
            .orWhere('app.studentIdMasked LIKE :keyword', { keyword })
            .orWhere('app.degree LIKE :keyword', { keyword });
        }),
      );
    }
    qb.skip((params.page - 1) * params.pageSize).take(params.pageSize);
    const [entities, total] = await qb.getManyAndCount();
    const views = await Promise.all(entities.map((item) => this.toView(item)));
    return paginate(views, total, params.page, params.pageSize);
  }

  /**
   * 审核决策：条件更新 + 乐观锁，避免两个管理员同时审核造成状态回退。
   */
  async decide(
    id: number,
    adminId: number,
    dto: VerificationDecisionDto,
    manager?: EntityManager,
  ): Promise<VerificationView> {
    const application = await this.applications.findOne({ where: { id } });
    if (!application) throw new NotFoundException('认证申请不存在');

    const statusMap: Record<string, string> = {
      approve: 'approved',
      reject: 'rejected',
      request_changes: 'needs_more_material',
    };
    const targetStatus = statusMap[dto.action];
    if (!targetStatus) throw new ConflictException('不支持的审核动作');

    const expectedVersion = dto.version ?? application.version;
    const titles: Record<string, string> = {
      approve: '认证已通过',
      reject: '认证未通过',
      request_changes: '认证需要补充材料',
    };

    // 审核结论、审核记录、用户状态、资料标记与通知**同事务**（缺陷 #99）
    const run = async (tx: EntityManager) => {
      const applications = tx.getRepository(VerificationApplication);
      const reviews = tx.getRepository(VerificationReview);
      const users = tx.getRepository(User);
      const profiles = tx.getRepository(AlumniProfile);

      const result = await tx
        .createQueryBuilder()
        .update(VerificationApplication)
        .set({
          status: targetStatus as VerificationApplication['status'],
          decidedBy: adminId,
          decisionNote: dto.note ?? null,
          decidedAt: new Date(),
          version: () => 'version + 1',
        })
        .where('id = :id', { id })
        .andWhere('version = :version', { version: expectedVersion })
        .andWhere('status IN (:...statuses)', {
          statuses: ['pending', 'resubmitted', 'needs_more_material'],
        })
        .execute();

      if (!result.affected) {
        throw new ConflictException('该申请已被处理或内容已变更，请刷新后重试');
      }

      await reviews.save(
        reviews.create({
          applicationId: id,
          adminId,
          action: dto.action,
          note: dto.note ?? null,
          snapshotVersion: expectedVersion,
        }),
      );

      if (dto.action === 'approve') {
        // 认证通过：用户升级为已认证校友，资料标记为已验证
        await users.update({ id: application.userId }, { stage: 'verified' });
        const profile = await profiles.findOne({ where: { userId: application.userId } });
        if (profile) {
          profile.verified = true;
          profile.verifiedAt = new Date();
          profile.verifiedBy = adminId;
          profile.realName = application.realName;
          profile.college = application.college;
          profile.graduationYear = application.graduationYear;
          profile.degree = application.degree ?? profile.degree;
          profile.version += 1;
          await profiles.save(profile);
        }
      } else {
        await users.update({ id: application.userId }, { stage: 'logged_in' });
      }

      await this.notifications.push(
        application.userId,
        'verification_decision',
        titles[dto.action],
        dto.note ?? '你的校友身份认证申请有了新的处理结果。',
        { applicationId: id, action: dto.action },
        { eventType: 'verification.decided', aggregateType: 'verification', aggregateId: String(id) },
        tx,
      );

      return applications.findOne({ where: { id } });
    };
    const updated = manager ? await run(manager) : await this.dataSource.transaction(run);
    return this.toView(updated ?? application);
  }

  /** 用户补充材料后重新提交。 */
  async resubmit(id: number, userId: number, dto: SubmitVerificationDto): Promise<VerificationView> {
    const application = await this.applications.findOne({ where: { id } });
    if (!application) throw new NotFoundException('认证申请不存在');
    if (application.userId !== userId) throw new ForbiddenException('无权操作该申请');
    if (application.status !== 'needs_more_material') {
      throw new ConflictException('当前状态无需重新提交');
    }

    // ⚠️ 证明材料的归属校验必须**先于任何写入**（缺陷 #118）：
    // 原实现先改了申请状态才校验材料，材料不合法时接口报错，
    // 申请却已经变成「已补交」—— 状态机自相矛盾。
    const mediaIds = await this.assertOwnedMedia(userId, dto.attachmentMediaIds);

    // ⚠️ 三步写必须同事务（缺陷 #118）：
    //   改申请状态 → 挂证明材料 → 改用户阶段。
    // 任何一步失败都不得留下半成品状态
    // （例如「申请已补交、用户阶段还停在旧值」会让用户依然用不了认证功能）。
    const updated = await this.dataSource.transaction(async (manager) => {
      const applications = manager.getRepository(VerificationApplication);
      const attachments = manager.getRepository(VerificationAttachment);
      const users = manager.getRepository(User);

      // 事务内重新取一次：并发补交时以**最新**状态判定
      const current = await applications.findOne({ where: { id } });
      if (!current) throw new NotFoundException('认证申请不存在');
      if (current.status !== 'needs_more_material') {
        throw new ConflictException('当前状态无需重新提交');
      }
      current.realName = dto.realName;
      current.college = dto.college;
      current.graduationYear = dto.graduationYear;
      current.degree = dto.degree ?? current.degree;
      current.studentIdMasked = dto.studentIdMasked;
      current.remark = dto.remark ?? current.remark;
      current.status = 'resubmitted';
      current.version += 1;
      current.submittedAt = new Date();
      await applications.save(current);

      if (mediaIds?.length) {
        // 唯一索引是 (application_id, media_id)：重复提交同一份材料会直接 500。
        const existing = await attachments.find({ where: { applicationId: current.id } });
        const known = new Set(existing.map((item) => item.mediaId));
        const toAdd = mediaIds.filter((mediaId) => !known.has(mediaId));
        if (toAdd.length) {
          await attachments.save(
            toAdd.map((mediaId) => attachments.create({ applicationId: current.id, mediaId })),
          );
        }
      }
      await users.update({ id: userId }, { stage: 'pending_review' });
      return current;
    });
    return this.toView(updated);
  }

  /**
   * 校验证明材料：必须存在，且必须是**本人上传**的。
   *
   * ⚠️ 不校验归属会留下一个跨用户泄露的口子（缺陷 #78）：
   *   用户 A 可以把用户 B 的 media id 填进自己的认证申请，
   *   审核端点按「附件挂在该申请上」放行 → 审核员就能取到 B 的私有文件。
   *   引用不存在的 media id 也会被外键约束打成 500。
   */
  private async assertOwnedMedia(
    uploaderId: number,
    mediaIds: number[] | undefined,
  ): Promise<number[] | undefined> {
    if (mediaIds === undefined) return undefined;
    const ids = [...new Set(mediaIds)];
    if (!ids.length) return ids;
    const rows = await this.mediaAssets.find({ where: { id: In(ids) } });
    const owned = new Set(rows.filter((asset) => asset.uploaderId === uploaderId).map((asset) => asset.id));
    const bad = ids.filter((id) => !owned.has(id));
    if (bad.length) {
      throw new BadRequestException(`证明材料不存在或不属于当前用户：${bad.join(', ')}`);
    }
    return ids;
  }

  /**
   * 该媒体资源是否确实挂在这个认证申请的证明材料里。
   *
   * 管理端取证明材料预览地址时用它鉴权：私有资产只允许上传者本人取地址，
   * 但**审核必须能看到证明材料**（缺陷 #77）——
   * 所以按「是否挂在这个待审申请上」判断，而不是按归属。
   */
  async ownsAttachment(applicationId: number, mediaId: number): Promise<boolean> {
    const count = await this.attachments.count({ where: { applicationId, mediaId } });
    return count > 0;
  }

  private async toView(application: VerificationApplication): Promise<VerificationView> {
    const [user, attachments, reviews] = await Promise.all([
      this.users.findOne({ where: { id: application.userId } }),
      this.attachments.find({
        where: { applicationId: application.id },
        relations: { media: true },
      }),
      this.reviews.find({
        where: { applicationId: application.id },
        order: { id: 'ASC' },
      }),
    ]);
    // 契约 VerificationReviewDto.adminName 为必填：后台审核记录直接渲染审核人姓名。
    // 详见 KNOWN-ISSUES #61。
    const adminNames = await this.adminNames(reviews.map((item) => item.adminId));
    return {
      id: application.id,
      userId: application.userId,
      applicantName: user?.nickname ?? '校友',
      college: application.college,
      graduationYear: application.graduationYear,
      degree: application.degree,
      studentIdMasked: application.studentIdMasked,
      status: application.status,
      // 契约 VerificationAttachmentDto 声明了 fileName / mimeType / size / uploadedAt，
      // 之前只返回 { id, mediaId } —— 后台审核页渲染的文件名与大小恒为空（缺陷 #75）。
      attachments: attachments.map((item) => ({
        id: item.id,
        mediaId: item.mediaId,
        fileName: item.media?.fileName ?? '',
        mimeType: item.media?.mimeType ?? '',
        size: item.media?.size ?? 0,
        uploadedAt: item.media?.createdAt ?? item.createdAt,
      })),
      reviews: reviews.map((item) => ({
        id: item.id,
        adminId: item.adminId,
        adminName: adminNames.get(item.adminId) ?? '未知管理员',
        action: item.action,
        note: item.note,
        snapshotVersion: item.snapshotVersion,
        createdAt: item.createdAt,
      })),
      submittedAt: application.submittedAt,
      decidedAt: application.decidedAt,
    };
  }

  /** 批量取管理员名称（一次查询，避免 N+1） */
  private async adminNames(adminIds: number[]): Promise<Map<number, string>> {
    const unique = [...new Set(adminIds)];
    if (unique.length === 0) return new Map();
    const admins = await this.admins.find({ where: { id: In(unique) } });
    return new Map(
      admins.map((admin) => [admin.id, admin.displayName || admin.username || '未知管理员']),
    );
  }
}
