import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, EntityManager, QueryFailedError, Repository } from 'typeorm';
import { paginate } from '../../common/dto/pagination.dto';
import type { PageResult } from '../../common/dto/pagination.dto';
import { Article, ArticleCategory, Notice } from '../../database/entities/content.entity';
import { SystemSetting } from '../../database/entities/system.entity';
import {
  CreateArticleBodyDto,
  CreateCategoryBodyDto,
  CreateNoticeBodyDto,
  UpdateArticleBodyDto,
  UpdateCategoryBodyDto,
  UpdateNoticeBodyDto,
  UpsertSettingBodyDto,
} from './dto/content.dto';

export interface ArticleView {
  id: number;
  categoryId: number | null;
  categoryName: string | null;
  title: string;
  summary: string | null;
  body: string;
  coverMediaId: number | null;
  status: string;
  publishedAt: Date | null;
  viewCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface NoticeView {
  id: number;
  title: string;
  body: string;
  status: string;
  publishedAt: Date | null;
  viewCount: number;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ContentService {
  constructor(
    @InjectRepository(Article) private readonly articles: Repository<Article>,
    @InjectRepository(ArticleCategory) private readonly categories: Repository<ArticleCategory>,
    @InjectRepository(Notice) private readonly notices: Repository<Notice>,
    @InjectRepository(SystemSetting) private readonly settings: Repository<SystemSetting>,
    private readonly dataSource: DataSource,
  ) {}

  async listArticles(params: {
    page: number;
    pageSize: number;
    categoryId?: number;
    status?: string;
    keyword?: string;
  }): Promise<PageResult<ArticleView>> {
    const qb = this.articles
      .createQueryBuilder('article')
      .leftJoinAndSelect('article.category', 'category')
      .orderBy('article.publishedAt', 'DESC')
      .andWhere('article.status = :status', { status: params.status ?? 'published' });
    if (params.categoryId) {
      qb.andWhere('article.categoryId = :categoryId', { categoryId: params.categoryId });
    }
    // 关键字：标题 / 摘要（后台「资讯管理」页的搜索框）
    // 详见 KNOWN-ISSUES #63
    if (params.keyword?.trim()) {
      const keyword = `%${params.keyword.trim()}%`;
      qb.andWhere(
        new Brackets((where) => {
          where
            .orWhere('article.title LIKE :keyword', { keyword })
            .orWhere('article.summary LIKE :keyword', { keyword });
        }),
      );
    }
    qb.skip((params.page - 1) * params.pageSize).take(params.pageSize);
    const [entities, total] = await qb.getManyAndCount();
    return paginate(entities.map((item) => this.toArticleView(item)), total, params.page, params.pageSize);
  }

  async articleDetail(id: number): Promise<ArticleView> {
    const article = await this.articles.findOne({
      where: { id },
      relations: { category: true },
    });
    if (!article || article.status !== 'published') throw new NotFoundException('内容不存在');
    await this.incrementViewCount('articles', id);
    article.viewCount += 1;
    return this.toArticleView(article);
  }

  async listCategories() {
    const rows = await this.categories.find({ order: { sortOrder: 'ASC' } });
    const counts = await this.publishedArticleCounts();
    return rows.map((category) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      sortOrder: category.sortOrder,
      // 契约 ArticleCategoryDto.articleCount：后台「分类管理」弹窗的「文章数」列
      // 直接渲染它，之前服务端不给这一列恒为空。详见 KNOWN-ISSUES #67。
      // 只统计**已发布**文章 —— 草稿数量属于内部信息，公开列表不应泄露。
      articleCount: counts.get(category.id) ?? 0,
    }));
  }

  /** 各分类下已发布文章的数量（一次 GROUP BY，避免 N+1） */
  private async publishedArticleCounts(): Promise<Map<number, number>> {
    const rows = await this.articles
      .createQueryBuilder('article')
      .select('article.categoryId', 'categoryId')
      .addSelect('COUNT(1)', 'cnt')
      .where('article.categoryId IS NOT NULL')
      .andWhere('article.status = :status', { status: 'published' })
      .groupBy('article.categoryId')
      .getRawMany<{ categoryId: number; cnt: string }>();
    return new Map(rows.map((row) => [Number(row.categoryId), Number(row.cnt)]));
  }

  async listNotices(params: {
    page: number;
    pageSize: number;
    status?: string;
    keyword?: string;
  }): Promise<PageResult<NoticeView>> {
    const qb = this.notices
      .createQueryBuilder('notice')
      .orderBy('notice.publishedAt', 'DESC')
      .andWhere('notice.status = :status', { status: params.status ?? 'published' });
    // 关键字：标题 / 正文（后台「公告管理」页的搜索框）
    // 详见 KNOWN-ISSUES #63
    if (params.keyword?.trim()) {
      const keyword = `%${params.keyword.trim()}%`;
      qb.andWhere(
        new Brackets((where) => {
          where
            .orWhere('notice.title LIKE :keyword', { keyword })
            .orWhere('notice.body LIKE :keyword', { keyword });
        }),
      );
    }
    qb.skip((params.page - 1) * params.pageSize).take(params.pageSize);
    const [entities, total] = await qb.getManyAndCount();
    return paginate(entities.map((item) => this.toNoticeView(item)), total, params.page, params.pageSize);
  }

  async noticeDetail(id: number): Promise<NoticeView> {
    const notice = await this.notices.findOne({ where: { id } });
    if (!notice || notice.status !== 'published') throw new NotFoundException('公告不存在');
    await this.incrementViewCount('notices', id);
    notice.viewCount += 1;
    return this.toNoticeView(notice);
  }

  /**
   * 浏览计数：**只动计数列**的原子更新（缺陷 #120）。
   *
   * 原实现是「读出整行 → view_count += 1 → 整行 save」，
   * 于是每次浏览都会把**读到的旧值整行写回** ——
   * 并发中的管理端修改（标题 / 正文 / 状态）会被这次浏览**静默覆盖**（丢失更新），
   * 而且 `updated_at` 也会被刷新（内容其实没人改过）。
   *
   * ⚠️ 显式写 `updated_at = updated_at`：
   *   该列在迁移里带 `ON UPDATE CURRENT_TIMESTAMP`，
   *   只要**别的**列变了它就会自动刷新；显式赋值可以让 MySQL 跳过自动更新，
   *   从而做到「浏览不产生任何副作用」。
   */
  private async incrementViewCount(table: 'articles' | 'notices', id: number): Promise<void> {
    await this.dataSource.query(
      `UPDATE ${table} SET view_count = view_count + 1, updated_at = updated_at WHERE id = ?`,
      [id],
    );
  }

  /** 首页聚合接口：一次请求返回首页所需的全部数据。 */
  async homeFeed() {
    const [articles, notices] = await Promise.all([
      this.listArticles({ page: 1, pageSize: 5 }),
      this.listNotices({ page: 1, pageSize: 5 }),
    ]);
    const latestNotice = await this.notices
      .createQueryBuilder('notice')
      .select('notice.title', 'title')
      .where('notice.status = :status', { status: 'published' })
      .orderBy('notice.publishedAt', 'DESC')
      .limit(1)
      .getRawOne<{ title: string } | undefined>();
    return {
      tabs: {
        news: articles.items,
        notices: notices.items,
      },
      latestNoticeTitle: latestNotice?.title ?? null,
      shortcuts: [
        { key: 'directory', label: '校友通讯录' },
        { key: 'connect', label: '校友连接' },
        { key: 'events', label: '校友活动' },
        { key: 'about', label: '校友会介绍' },
      ],
    };
  }

  /* ------------------------------ 管理端 ------------------------------ */

  /**
   * 管理端创建资讯。
   *
   * 请求体已由 `CreateArticleBodyDto` 校验（字段类型、长度、枚举都保证过），
   * 因此这里不再做 `String()` / `Number()` 强转（缺陷 #79）。
   *
   * `publishedAt` 只在**真正发布**时才写（缺陷 #80）：
   *   之前的写法是「只要不是显式 publishNow=false 就写当前时间」，
   *   而 publishNow 是**死参数**（契约里没有、客户端也从没发过），
   *   于是草稿也会带着一个发布时间 —— 草稿列表里的「发布时间」是假的。
   */
  async adminCreateArticle(
    payload: CreateArticleBodyDto,
    adminId: number,
    manager?: EntityManager,
  ): Promise<ArticleView> {
    const status = payload.status ?? 'draft';
    const articles = manager ? manager.getRepository(Article) : this.articles;
    const article = await articles.save(
      articles.create({
        categoryId: payload.categoryId ?? null,
        title: payload.title,
        summary: payload.summary ?? null,
        body: payload.body,
        coverMediaId: payload.coverMediaId ?? null,
        status,
        publishedAt: status === 'published' ? new Date() : null,
        createdBy: adminId,
      }),
    );
    return this.toArticleView(article);
  }

  async adminUpdateArticle(
    id: number,
    payload: UpdateArticleBodyDto,
    manager?: EntityManager,
  ): Promise<ArticleView> {
    const articles = manager ? manager.getRepository(Article) : this.articles;
    const article = await articles.findOne({ where: { id } });
    if (!article) throw new NotFoundException('内容不存在');
    if (payload.title !== undefined) article.title = payload.title;
    if (payload.summary !== undefined) article.summary = payload.summary ?? null;
    if (payload.body !== undefined) article.body = payload.body;
    if (payload.categoryId !== undefined) article.categoryId = payload.categoryId ?? null;
    if (payload.coverMediaId !== undefined) article.coverMediaId = payload.coverMediaId ?? null;
    if (payload.status !== undefined) {
      article.status = payload.status;
      // 回到草稿 → 清掉发布时间（缺陷 #80）
      if (article.status === 'published' && !article.publishedAt) {
        article.publishedAt = new Date();
      } else if (article.status !== 'published') {
        article.publishedAt = null;
      }
    }
    article.version += 1;
    const saved = await articles.save(article);
    return this.toArticleView(saved);
  }

  async adminDeleteArticle(id: number, manager?: EntityManager): Promise<{ deleted: boolean }> {
    const articles = manager ? manager.getRepository(Article) : this.articles;
    const result = await articles.delete({ id });
    if (!result.affected) throw new NotFoundException('内容不存在');
    return { deleted: true };
  }

  /** 管理端创建公告（publishedAt 只在真正发布时写，见缺陷 #80） */
  async adminCreateNotice(
    payload: CreateNoticeBodyDto,
    adminId: number,
    manager?: EntityManager,
  ): Promise<NoticeView> {
    const status = payload.status ?? 'draft';
    const notices = manager ? manager.getRepository(Notice) : this.notices;
    const notice = await notices.save(
      notices.create({
        title: payload.title,
        body: payload.body,
        status,
        publishedAt: status === 'published' ? new Date() : null,
        createdBy: adminId,
      }),
    );
    return this.toNoticeView(notice);
  }

  async adminUpdateNotice(
    id: number,
    payload: UpdateNoticeBodyDto,
    manager?: EntityManager,
  ): Promise<NoticeView> {
    const notices = manager ? manager.getRepository(Notice) : this.notices;
    const notice = await notices.findOne({ where: { id } });
    if (!notice) throw new NotFoundException('公告不存在');
    if (payload.title !== undefined) notice.title = payload.title;
    if (payload.body !== undefined) notice.body = payload.body;
    if (payload.status !== undefined) {
      notice.status = payload.status;
      if (notice.status === 'published' && !notice.publishedAt) {
        notice.publishedAt = new Date();
      } else if (notice.status !== 'published') {
        notice.publishedAt = null;
      }
    }
    notice.version += 1;
    const saved = await notices.save(notice);
    return this.toNoticeView(saved);
  }

  async adminDeleteNotice(id: number, manager?: EntityManager): Promise<{ deleted: boolean }> {
    const notices = manager ? manager.getRepository(Notice) : this.notices;
    const result = await notices.delete({ id });
    if (!result.affected) throw new NotFoundException('公告不存在');
    return { deleted: true };
  }

  /* ------------------------------ 分类与系统设置 ------------------------------ */

  async createCategory(payload: CreateCategoryBodyDto) {
    const category = await this.categories.save(
      this.categories.create({
        name: payload.name,
        slug: payload.slug,
        sortOrder: payload.sortOrder ?? 0,
      }),
    );
    return {
      id: category.id,
      name: category.name,
      slug: category.slug,
      sortOrder: category.sortOrder,
      articleCount: 0,
    };
  }

  async updateCategory(id: number, payload: UpdateCategoryBodyDto) {
    const category = await this.categories.findOne({ where: { id } });
    if (!category) throw new NotFoundException('分类不存在');
    if (payload.name !== undefined) category.name = payload.name;
    if (payload.slug !== undefined) category.slug = payload.slug;
    if (payload.sortOrder !== undefined) category.sortOrder = payload.sortOrder;
    await this.categories.save(category);
    const counts = await this.publishedArticleCounts();
    return {
      id: category.id,
      name: category.name,
      slug: category.slug,
      sortOrder: category.sortOrder,
      articleCount: counts.get(category.id) ?? 0,
    };
  }

  async deleteCategory(id: number): Promise<{ deleted: boolean }> {
    const result = await this.categories.delete({ id });
    if (!result.affected) throw new NotFoundException('分类不存在');
    return { deleted: true };
  }

  async upsertSetting(payload: UpsertSettingBodyDto) {
    const existing = await this.settings.findOne({ where: { key: payload.key } });
    if (existing) {
      existing.value = payload.value;
      if (payload.description !== undefined) existing.description = payload.description;
      await this.settings.save(existing);
      return existing;
    }
    try {
      const created = await this.settings.save(
        this.settings.create({
          key: payload.key,
          value: payload.value,
          description: payload.description ?? null,
        }),
      );
      return created;
    } catch (error) {
      // ⚠️ 并发下两个请求都读不到既有行 → 都会去 INSERT，
      //    后到的那一个撞主键 `key` 的唯一约束（缺陷 #137）。
      //    「先查后插」在单线程下没问题，**并发**下必须有兜底：
      //    捕获唯一键冲突后改成**更新**既有行，而不是甩 500 给用户。
      if (!this.isDuplicateKey(error)) throw error;
      const concurrent = await this.settings.findOne({ where: { key: payload.key } });
      if (!concurrent) throw error;
      concurrent.value = payload.value;
      if (payload.description !== undefined) concurrent.description = payload.description;
      await this.settings.save(concurrent);
      return concurrent;
    }
  }

  /** MySQL 唯一键冲突（ER_DUP_ENTRY / 1062）。 */
  private isDuplicateKey(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    const driverError = error.driverError as { code?: string; errno?: number } | undefined;
    return driverError?.code === 'ER_DUP_ENTRY' || driverError?.errno === 1062;
  }

  private toArticleView(article: Article): ArticleView {
    return {
      id: article.id,
      categoryId: article.categoryId,
      categoryName: article.category?.name ?? null,
      title: article.title,
      summary: article.summary,
      body: article.body,
      coverMediaId: article.coverMediaId,
      status: article.status,
      publishedAt: article.publishedAt,
      viewCount: article.viewCount,
      createdAt: article.createdAt,
      updatedAt: article.updatedAt,
    };
  }

  private toNoticeView(notice: Notice): NoticeView {
    return {
      id: notice.id,
      title: notice.title,
      body: notice.body,
      status: notice.status,
      publishedAt: notice.publishedAt,
      viewCount: notice.viewCount,
      createdAt: notice.createdAt,
      updatedAt: notice.updatedAt,
    };
  }
}
