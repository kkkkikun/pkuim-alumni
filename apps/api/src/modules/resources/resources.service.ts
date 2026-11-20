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
import { groupBy } from '../../common/utils/group-by';
import type { PageResult } from '../../common/dto/pagination.dto';
import {
  ResourcePost,
  ResourcePostAttachment,
  ResourcePostReview,
} from '../../database/entities/resource.entity';
import { AdminUser } from '../../database/entities/admin.entity';
import { MediaAsset } from '../../database/entities/system.entity';
import { User } from '../../database/entities/user.entity';
import { NotificationService } from '../notifications/notification.service';
import type {
  CreateResourceDto,
  ResourceDecisionDto,
  UpdateResourceDto,
} from './dto/resource.dto';

export interface ResourceAttachmentView {
  id: number;
  mediaId: number;
  fileName: string;
  mimeType: string;
  size: number;
  uploadedAt: Date;
}

export interface ResourceView {
  id: number;
  authorId: number;
  authorName: string;
  type: string;
  title: string;
  body: string;
  industryCode: string | null;
  industryName: string | null;
  regionCode: string | null;
  regionName: string | null;
  status: string;
  version: number;
  attachments: ResourceAttachmentView[];
  reviews: {
    id: number;
    adminId: number;
    adminName: string;
    action: string;
    note: string | null;
    snapshotVersion: number;
    createdAt: Date;
  }[];
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ResourcesService {
  constructor(
    @InjectRepository(ResourcePost) private readonly posts: Repository<ResourcePost>,
    @InjectRepository(ResourcePostReview) private readonly reviews: Repository<ResourcePostReview>,
    @InjectRepository(ResourcePostAttachment)
    private readonly attachments: Repository<ResourcePostAttachment>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(MediaAsset) private readonly mediaAssets: Repository<MediaAsset>,
    @InjectRepository(AdminUser) private readonly admins: Repository<AdminUser>,
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationService,
  ) {}

  /** 公开列表：只有 published 状态可见。 */
  async listPublic(params: {
    page: number;
    pageSize: number;
    type?: string;
    regionCode?: string;
    industryCode?: string;
    keyword?: string;
  }): Promise<PageResult<ResourceView>> {
    const qb = this.posts
      .createQueryBuilder('post')
      .innerJoin(User, 'author', 'author.id = post.authorId')
      .leftJoinAndSelect('post.industry', 'industry')
      .leftJoinAndSelect('post.region', 'region')
      .where('post.status = :status', { status: 'published' })
      .orderBy('post.publishedAt', 'DESC');

    if (params.type) qb.andWhere('post.type = :type', { type: params.type });
    if (params.regionCode) {
      qb.andWhere('post.regionCode = :regionCode', { regionCode: params.regionCode });
    }
    if (params.industryCode) {
      qb.andWhere('post.industryCode = :industryCode', { industryCode: params.industryCode });
    }
    if (params.keyword?.trim()) {
      const keyword = `%${params.keyword.trim()}%`;
      qb.andWhere(
        new Brackets((where) => {
          where
            .orWhere('post.title LIKE :keyword', { keyword })
            .orWhere('post.body LIKE :keyword', { keyword });
        }),
      );
    }
    qb.skip((params.page - 1) * params.pageSize).take(params.pageSize);

    const [entities, total] = await qb.getManyAndCount();
    const views = await this.toViews(entities);
    return paginate(views, total, params.page, params.pageSize);
  }

  async detail(id: number, viewerId?: number, isAdmin = false): Promise<ResourceView> {
    const post = await this.posts.findOne({
      where: { id },
      relations: { industry: true, region: true },
    });
    if (!post) throw new NotFoundException('内容不存在');
    const visible = post.status === 'published' || isAdmin || post.authorId === viewerId;
    if (!visible) throw new NotFoundException('内容不存在');
    return this.toView(post);
  }

  async create(authorId: number, dto: CreateResourceDto, submitForReview: boolean): Promise<ResourceView> {
    const mediaIds = await this.assertOwnedMedia(authorId, dto.attachmentMediaIds);
    // 内容写入、附件挂载与通知**同事务**（缺陷 #99）：
    // 否则附件写失败时内容已提交 → 用户看到 500，却留下一条附件残缺的内容。
    const post = await this.dataSource.transaction(async (manager) => {
      const posts = manager.getRepository(ResourcePost);
      const created = await posts.save(
        posts.create({
          authorId,
          type: dto.type,
          title: dto.title,
          body: dto.body,
          industryCode: dto.industryCode ?? null,
          regionCode: dto.regionCode ?? null,
          status: submitForReview ? 'pending' : 'draft',
          version: 0,
        }),
      );
      await this.replaceAttachments(created.id, mediaIds, manager);
      if (submitForReview) {
        await this.notifications.push(
          authorId,
          'resource_review',
          '资源已提交审核',
          `「${created.title}」已进入审核队列，审核结果会通过通知告知你。`,
          { postId: created.id },
          { eventType: 'resource.submitted', aggregateType: 'resource_post', aggregateId: String(created.id) },
          manager,
        );
      }
      return created;
    });
    return this.toView(post);
  }

  /** 作者修改：版本号 +1；已发布内容修改后回到 pending 重新审核。 */
  async update(id: number, authorId: number, dto: UpdateResourceDto): Promise<ResourceView> {
    const post = await this.posts.findOne({ where: { id } });
    if (!post) throw new NotFoundException('内容不存在');
    if (post.authorId !== authorId) throw new ForbiddenException('只能修改自己发布的内容');

    // ⚠️ 附件归属校验必须**先于任何写入**（缺陷 #131）。
    //
    // 修复前校验排在内容写入**之后**：请求带着别人的 mediaId 时，
    // 服务端返回 400「附件不属于当前用户」，但**内容其实已经被改了**
    // （标题 / 正文 / version / 状态全变了）。
    // 客户端拿到 400 会以为「什么都没发生」——
    // 「请求被拒却留下副作用」是最难排查的一类问题。
    const mediaIds = await this.assertOwnedMedia(authorId, dto.attachmentMediaIds);

    // ⚠️ 内容写入与附件**整体替换**必须同事务（缺陷 #132）。
    //
    // 修复前这两步各自提交：附件那一步失败时（写库失败），
    // 内容写入**已经提交**，留下一份「内容是新的、附件是旧的（甚至被删空了）」的半成品。
    // 同一个模块的 `create()` 早就用事务把「内容 + 附件 + 通知」包起来了，
    // `update()` 却漏了 —— 同一个模块，两种写法。
    const updated = await this.dataSource.transaction(async (manager) => {
      const posts = manager.getRepository(ResourcePost);
      // 事务内**重取**一次：外面那次读是事务外的快照，
      // 事务内再取一次才能保证 version 递增基于最新值。
      const target = await posts.findOne({ where: { id } });
      if (!target) throw new NotFoundException('内容不存在');
      if (target.authorId !== authorId) throw new ForbiddenException('只能修改自己发布的内容');

      if (dto.title !== undefined) target.title = dto.title;
      if (dto.body !== undefined) target.body = dto.body;
      if (dto.industryCode !== undefined) target.industryCode = dto.industryCode;
      if (dto.regionCode !== undefined) target.regionCode = dto.regionCode;
      target.version += 1;
      if (target.status === 'published') {
        target.status = 'pending';
        target.publishedAt = null;
      }
      await posts.save(target);

      // 附件：**整体替换**（缺陷 #73）
      //   之前这里完全没有处理 attachmentMediaIds —— 契约声明了、Swagger 公布了、
      //   create 也会落库，唯独 update 把它丢了：用户改资源换附件时「保存成功」，
      //   附件却纹丝不动。不传该字段则保持原样（与其它字段的 PATCH 语义一致）。
      if (mediaIds !== undefined) {
        await this.replaceAttachments(target.id, mediaIds, manager);
      }
      return target;
    });

    return this.toView(updated);
  }

  /**
   * 校验附件媒体资源：必须存在，且必须是**本人上传**的。
   *
   * - 引用不存在的 media id → 外键约束会直接 500（对客户端来说是"服务端崩了"）；
   * - 引用他人上传的 media id → 能把别人的私有文件挂到自己的内容上。
   * 两种都应当是 400，而不是靠数据库兜底。
   */
  private async assertOwnedMedia(
    uploaderId: number,
    mediaIds: number[] | undefined,
  ): Promise<number[] | undefined> {
    if (mediaIds === undefined) return undefined;
    const ids = [...new Set(mediaIds)];
    if (!ids.length) return ids;
    const rows = await this.mediaAssets.find({ where: { id: In(ids) } });
    const owned = new Set(
      rows.filter((asset) => asset.uploaderId === uploaderId).map((asset) => asset.id),
    );
    const bad = ids.filter((id) => !owned.has(id));
    if (bad.length) {
      throw new BadRequestException(`附件不存在或不属于当前用户：${bad.join(', ')}`);
    }
    return ids;
  }

  /** 附件整体替换：传入列表 = 替换全部附件；空数组 = 清空附件。 */
  private async replaceAttachments(
    postId: number,
    mediaIds: number[] | undefined,
    manager?: EntityManager,
  ): Promise<void> {
    if (mediaIds === undefined) return;
    const attachments = manager
      ? manager.getRepository(ResourcePostAttachment)
      : this.attachments;
    await attachments.delete({ postId });
    if (!mediaIds.length) return;
    await attachments.save(
      mediaIds.map((mediaId) => attachments.create({ postId, mediaId })),
    );
  }

  async submit(id: number, authorId: number): Promise<ResourceView> {
    const post = await this.posts.findOne({ where: { id } });
    if (!post) throw new NotFoundException('内容不存在');
    if (post.authorId !== authorId) throw new ForbiddenException('只能提交自己发布的内容');
    if (post.status === 'published') return this.toView(post);
    post.status = 'pending';
    post.version += 1;
    await this.posts.save(post);
    return this.toView(post);
  }

  async withdraw(id: number, authorId: number): Promise<ResourceView> {
    const post = await this.posts.findOne({ where: { id } });
    if (!post) throw new NotFoundException('内容不存在');
    if (post.authorId !== authorId) throw new ForbiddenException('只能撤回自己发布的内容');
    post.status = 'withdrawn';
    post.version += 1;
    await this.posts.save(post);
    return this.toView(post);
  }

  async myPosts(authorId: number, page: number, pageSize: number): Promise<PageResult<ResourceView>> {
    const qb = this.posts
      .createQueryBuilder('post')
      .innerJoin(User, 'author', 'author.id = post.authorId')
      .leftJoinAndSelect('post.industry', 'industry')
      .leftJoinAndSelect('post.region', 'region')
      .where('post.authorId = :authorId', { authorId })
      .orderBy('post.id', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);
    const [entities, total] = await qb.getManyAndCount();
    const views = await this.toViews(entities);
    return paginate(views, total, page, pageSize);
  }

  /** 管理端列表：可按状态筛选。 */
  async adminList(params: {
    page: number;
    pageSize: number;
    status?: string;
    type?: string;
    keyword?: string;
  }): Promise<PageResult<ResourceView>> {
    const qb = this.posts
      .createQueryBuilder('post')
      .innerJoin(User, 'author', 'author.id = post.authorId')
      .leftJoinAndSelect('post.industry', 'industry')
      .leftJoinAndSelect('post.region', 'region')
      .orderBy('post.id', 'DESC');
    if (params.status) qb.andWhere('post.status = :status', { status: params.status });
    if (params.type) qb.andWhere('post.type = :type', { type: params.type });
    // 关键字：标题 / 正文 / 发布人（后台「资源审核」页的搜索框）
    // 详见 KNOWN-ISSUES #63
    if (params.keyword?.trim()) {
      const keyword = `%${params.keyword.trim()}%`;
      qb.andWhere(
        new Brackets((where) => {
          where
            .orWhere('post.title LIKE :keyword', { keyword })
            .orWhere('post.body LIKE :keyword', { keyword })
            .orWhere('author.nickname LIKE :keyword', { keyword });
        }),
      );
    }
    qb.skip((params.page - 1) * params.pageSize).take(params.pageSize);
    const [entities, total] = await qb.getManyAndCount();
    const views = await this.toViews(entities);
    return paginate(views, total, params.page, params.pageSize);
  }

  /**
   * 审核决策：条件更新 + 乐观锁。
   * 影响行数为 0 说明内容已被他人处理或版本已变化 → 返回 409。
   */
  async decide(
    id: number,
    adminId: number,
    dto: ResourceDecisionDto,
    manager?: EntityManager,
  ): Promise<ResourceView> {
    const post = await this.posts.findOne({ where: { id } });
    if (!post) throw new NotFoundException('内容不存在');

    const statusMap: Record<string, string> = {
      approve: 'published',
      reject: 'rejected',
      request_changes: 'rejected',
      offline: 'offline',
    };
    const targetStatus = statusMap[dto.action] ?? 'rejected';
    const expectedVersion = dto.version ?? post.version;

    const titles: Record<string, string> = {
      approve: '审核通过',
      reject: '审核未通过',
      request_changes: '需要修改后重新提交',
      offline: '内容已下架',
    };

    // 审核结论、审核记录与通知**同事务**（缺陷 #99）
    const run = async (tx: EntityManager) => {
      const posts = tx.getRepository(ResourcePost);
      const reviews = tx.getRepository(ResourcePostReview);

      const result = await tx
        .createQueryBuilder()
        .update(ResourcePost)
        .set({
          status: targetStatus as ResourcePost['status'],
          publishedAt: dto.action === 'approve' ? new Date() : null,
          version: () => 'version + 1',
        })
        .where('id = :id', { id })
        .andWhere('version = :version', { version: expectedVersion })
        .andWhere('status IN (:...statuses)', { statuses: ['pending', 'published', 'rejected'] })
        .execute();

      if (!result.affected) {
        throw new ConflictException('内容已被其他管理员处理或已变更，请刷新后重试');
      }

      await reviews.save(
        reviews.create({
          postId: id,
          adminId,
          action: dto.action,
          note: dto.note ?? null,
          snapshotVersion: expectedVersion,
        }),
      );

      await this.notifications.push(
        post.authorId,
        'resource_review',
        titles[dto.action] ?? '审核结果通知',
        dto.note ?? `你的发布「${post.title}」审核结果已更新。`,
        { postId: id, action: dto.action },
        { eventType: 'resource.reviewed', aggregateType: 'resource_post', aggregateId: String(id) },
        tx,
      );

      return posts.findOne({ where: { id } });
    };
    const updated = manager ? await run(manager) : await this.dataSource.transaction(run);
    return this.toView(updated ?? post);
  }

  /**
   * 该媒体资源是否确实挂在这条内容的附件里。
   *
   * 管理端取附件预览地址时用它鉴权（详见缺陷 #77 的说明）：
   * 按「是否挂在这个待审内容上」判断，而不是按资产归属 ——
   * 否则审核员永远打不开用户上传的私有附件，审核流程走不通。
   */
  async ownsAttachment(postId: number, mediaId: number): Promise<boolean> {
    const count = await this.attachments.count({ where: { postId, mediaId } });
    return count > 0;
  }

  private async toView(post: ResourcePost): Promise<ResourceView> {
    const [view] = await this.toViews([post]);
    return view;
  }

  /**
   * 批量装配视图（消除 N+1）。
   *
   * ⚠️ 此前每行 3~4 条 SQL（作者 / 附件 / 审核记录 / 管理员名），
   *    列表接口逐行调用 → 每页 20 条就是 **80+ 条 SQL**，开销随页大小线性增长。
   *    现在改成 4 次批量查询（`In(...)`），查询数与页大小无关。
   */
  private async toViews(posts: ResourcePost[]): Promise<ResourceView[]> {
    if (posts.length === 0) return [];
    const postIds = posts.map((item) => item.id);
    const authorIds = [...new Set(posts.map((item) => item.authorId))];
    const [authors, attachments, reviews] = await Promise.all([
      this.users.find({ where: { id: In(authorIds) } }),
      this.attachments.find({ where: { postId: In(postIds) }, relations: { media: true } }),
      this.reviews.find({ where: { postId: In(postIds) }, order: { id: 'ASC' } }),
    ]);
    // 契约 ResourceReviewDto.adminName 为必填：后台审核记录直接渲染审核人姓名，
    // 之前服务端没带出管理员名称，该列恒为空。详见 KNOWN-ISSUES #61。
    const adminNames = await this.adminNames(reviews.map((item) => item.adminId));
    const authorMap = new Map(authors.map((user) => [user.id, user]));
    const attachmentsBy = groupBy(attachments, (item) => item.postId);
    const reviewsBy = groupBy(reviews, (item) => item.postId);
    return posts.map((post) => {
      const author = authorMap.get(post.authorId);
      return {
        id: post.id,
        authorId: post.authorId,
        authorName: author?.nickname ?? '校友',
        type: post.type,
        title: post.title,
        body: post.body,
        industryCode: post.industryCode,
        industryName: post.industry?.name ?? null,
        regionCode: post.regionCode,
        regionName: post.region?.name ?? null,
        status: post.status,
        version: post.version,
        attachments: (attachmentsBy.get(post.id) ?? []).map((item) => ({
          id: item.id,
          mediaId: item.mediaId,
          fileName: item.media?.fileName ?? '',
          mimeType: item.media?.mimeType ?? '',
          size: item.media?.size ?? 0,
          uploadedAt: item.media?.createdAt ?? item.createdAt,
        })),
        reviews: (reviewsBy.get(post.id) ?? []).map((item) => ({
          id: item.id,
          adminId: item.adminId,
          adminName: adminNames.get(item.adminId) ?? '未知管理员',
          action: item.action,
          note: item.note,
          snapshotVersion: item.snapshotVersion,
          createdAt: item.createdAt,
        })),
        publishedAt: post.publishedAt,
        createdAt: post.createdAt,
        updatedAt: post.updatedAt,
      };
    });
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
