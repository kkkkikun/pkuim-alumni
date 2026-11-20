import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, EntityManager, Repository } from 'typeorm';
import { paginate } from '../../common/dto/pagination.dto';
import type { PageResult } from '../../common/dto/pagination.dto';
import { TtlCacheService } from '../../common/services/ttl-cache.service';
import { toBodyExcerpt } from '../../common/utils/excerpt';
import { CacheKeys } from '../../common/constants';
import { isDuplicateKeyError } from '../../common/utils/duplicate-key';
import { ViewCounterService } from './view-counter.service';
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
    private readonly cache: TtlCacheService,
    private readonly viewCounter: ViewCounterService,
  ) {}

  /**
   * 资讯列表。
   *
   * ⚠️ `bodyExcerpt`：**公开**列表只返回正文**摘要**（前 200 字）——
   *    `body` 列是 MEDIUMTEXT，`pageSize=100` 时单次响应可达数十 MB。
   *    完整正文走 `GET /articles/:id`。
   *    管理端列表必须给**全文**（编辑弹窗直接回填列表行里的正文，
   *    截断会让管理员保存时静默截断正文 —— 那是数据损坏）。
   */
  async listArticles(
    params: {
      page: number;
      pageSize: number;
      categoryId?: number;
      status?: string;
      keyword?: string;
    },
    options: { bodyExcerpt?: boolean } = {},
  ): Promise<PageResult<ArticleView>> {
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
    return paginate(
      entities.map((item) => this.toArticleView(item, options.bodyExcerpt === true)),
      total,
      params.page,
      params.pageSize,
    );
  }

  async articleDetail(id: number): Promise<ArticleView> {
    const article = await this.articles.findOne({
      where: { id },
      relations: { category: true },
    });
    if (!article || article.status !== 'published') throw new NotFoundException('内容不存在');
    await this.incrementViewCount('articles', id, article);
    return this.toArticleView(article);
  }

  /**
   * 资讯分类（含各分类下已发布文章数）。
   *
   * ⚠️ 第三轮：走进程内 TTL 缓存（口径见 docs/SECURITY.md 第 2.1 节）。
   *    分类增删改、资讯发布 / 下架会**主动失效**这条缓存。
   */
  async listCategories() {
    const cached = this.cache.get<unknown[]>(CacheKeys.categories);
    if (cached) return cached;
    const rows = await this.categories.find({ order: { sortOrder: 'ASC' } });
    const counts = await this.publishedArticleCounts();
    const result = rows.map((category) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      sortOrder: category.sortOrder,
      // 契约 ArticleCategoryDto.articleCount：后台「分类管理」弹窗的「文章数」列
      // 直接渲染它，之前服务端不给这一列恒为空。详见 KNOWN-ISSUES #67。
      // 只统计**已发布**文章 —— 草稿数量属于内部信息，公开列表不应泄露。
      articleCount: counts.get(category.id) ?? 0,
    }));
    this.cache.set(CacheKeys.categories, result, this.cache.dictionaryTtlSeconds);
    return result;
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

  /**
   * 公告列表。
   *
   * ⚠️ `bodyExcerpt`：公开列表只返回正文**摘要**（同 `listArticles` 的理由：
   *    `body` 是 MEDIUMTEXT，列表响应可达数十 MB），完整正文走详情接口。
   */
  async listNotices(
    params: {
      page: number;
      pageSize: number;
      status?: string;
      keyword?: string;
    },
    options: { bodyExcerpt?: boolean } = {},
  ): Promise<PageResult<NoticeView>> {
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
    return paginate(
      entities.map((item) => this.toNoticeView(item, options.bodyExcerpt === true)),
      total,
      params.page,
      params.pageSize,
    );
  }

  async noticeDetail(id: number): Promise<NoticeView> {
    const notice = await this.notices.findOne({ where: { id } });
    if (!notice || notice.status !== 'published') throw new NotFoundException('公告不存在');
    await this.incrementViewCount('notices', id, notice);
    return this.toNoticeView(notice);
  }

  /**
   * 浏览计数：**Redis 计数 + 惰性刷回**（第三轮）。
   *
   * ## 为什么改
   *
   * 此前每次浏览都直接 `UPDATE articles SET view_count = view_count + 1` ——
   * 热门文章的所有浏览者**串行争抢同一行锁**，这一行就是热点。
   *
   * ## 现在的做法
   *
   * 浏览只在 Redis 里 `HINCRBY` 计数（无行锁）；
   * 累计到 20 次或到 60 秒周期时，才把增量**一次性**写回数据库
   * （仍然只动 `view_count` 一列）。
   *
   * ## 一致性（契约里已写明：即时一致 → 最终一致）
   *
   * - 详情接口返回的 `viewCount` = 「库里的基线值 + 尚未落库的增量」，
   *   所以**用户看到的数字当场就是对的**；
   * - 但**数据库行里的 `view_count` 可能滞后**（最多一个刷回周期）。
   *
   * ## Redis 不可用时
   *
   * **降级为直接写库**（与改动前完全一致）：计数不会丢，
   * 只是又回到了「每次浏览写一行」的旧模式。
   *
   * ⚠️ 显式写 `updated_at = updated_at`（降级路径）：
   *   该列带 `ON UPDATE CURRENT_TIMESTAMP`，只要**别的**列变了它就会自动刷新；
   *   显式赋值让 MySQL 跳过自动更新 —— 浏览不得产生任何副作用（缺陷 #120）。
   */
  private async incrementViewCount(
    table: 'articles' | 'notices',
    id: number,
    target: { viewCount: number; createdAt: Date },
  ): Promise<void> {
    // ⚠️ `record` 返回的是**用户应当看到的总数**（当场就是真值），
    //    Redis 不可用时它降级为直接写库并返回「基线 + 1」。
    target.viewCount = await this.viewCounter.record(
      table,
      id,
      target.viewCount,
      target.createdAt,
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

  /**
   * 新建资讯分类。
   *
   * ⚠️ `manager`：传入事务 manager 时，本次写入与**审计日志**同事务
   *    （缺陷 #134 同款做法：审计写失败时业务写必须一起回滚）。
   */
  async createCategory(payload: CreateCategoryBodyDto, manager?: EntityManager) {
    const categories = manager ? manager.getRepository(ArticleCategory) : this.categories;
    const category = await categories.save(
      categories.create({
        name: payload.name,
        slug: payload.slug,
        sortOrder: payload.sortOrder ?? 0,
      }),
    );
    // 分类变了 → 分类字典缓存失效（写操作主动失效，不等 TTL）
    this.cache.delete(CacheKeys.categories);
    return {
      id: category.id,
      name: category.name,
      slug: category.slug,
      sortOrder: category.sortOrder,
      articleCount: 0,
    };
  }

  /** 修改资讯分类（同上：支持事务 manager）。 */
  async updateCategory(id: number, payload: UpdateCategoryBodyDto, manager?: EntityManager) {
    const categories = manager ? manager.getRepository(ArticleCategory) : this.categories;
    const category = await categories.findOne({ where: { id } });
    if (!category) throw new NotFoundException('分类不存在');
    if (payload.name !== undefined) category.name = payload.name;
    if (payload.slug !== undefined) category.slug = payload.slug;
    if (payload.sortOrder !== undefined) category.sortOrder = payload.sortOrder;
    await categories.save(category);
    // 分类变了 → 分类字典缓存失效
    this.cache.delete(CacheKeys.categories);
    const counts = await this.publishedArticleCounts();
    return {
      id: category.id,
      name: category.name,
      slug: category.slug,
      sortOrder: category.sortOrder,
      articleCount: counts.get(category.id) ?? 0,
    };
  }

  /** 删除资讯分类（同上：支持事务 manager）。 */
  async deleteCategory(id: number, manager?: EntityManager): Promise<{ deleted: boolean }> {
    const categories = manager ? manager.getRepository(ArticleCategory) : this.categories;
    const result = await categories.delete({ id });
    if (!result.affected) throw new NotFoundException('分类不存在');
    // 分类变了 → 分类字典缓存失效
    this.cache.delete(CacheKeys.categories);
    return { deleted: true };
  }

  /**
   * 写入系统设置（upsert）。
   *
   * ⚠️ `manager`：传入事务 manager 时，本次写入与**审计日志**同事务。
   *
   * ⚠️ **并发兜底必须在「事务之外」重试**（缺陷 #137）：
   *    两个并发请求都读不到既有行 → 都去 INSERT → 后到的那一个撞主键唯一约束。
   *    这时正确的处置是**回滚整个事务、重来一遍**：
   *    重来时是**新的快照**，能看到另一个事务刚提交的那一行，于是走「更新」分支。
   *    ⚠️ **不能**在同一个事务里重读并补救 ——
   *    MySQL 的 REPEATABLE READ 下，事务里的一致性读只看到**事务开始时的快照**，
   *    另一个事务刚提交的那一行**看不见**；
   *    而用 `FOR UPDATE`（当前读）去补救又会与本事务自己持有的行锁**自死锁**。
   *    所以：**在事务内只做「读 → 写」，把唯一键冲突抛给调用方，由调用方重试事务。**
   */
  async upsertSetting(payload: UpsertSettingBodyDto, manager?: EntityManager) {
    const settings = manager ? manager.getRepository(SystemSetting) : this.settings;
    const existing = await settings.findOne({ where: { key: payload.key } });
    if (existing) {
      existing.value = payload.value;
      if (payload.description !== undefined) existing.description = payload.description;
      await settings.save(existing);
      this.invalidateSettingCaches();
      return existing;
    }
    try {
      const created = await settings.save(
        settings.create({
          key: payload.key,
          value: payload.value,
          description: payload.description ?? null,
        }),
      );
      this.invalidateSettingCaches();
      return created;
    } catch (error) {
      // ⚠️ 并发下两个请求都读不到既有行 → 都会去 INSERT，
      //    后到的那一个撞主键 `key` 的唯一约束（缺陷 #137）。
      //    「先查后插」在单线程下没问题，**并发**下必须有兜底。
      //    事务路径：把冲突抛给调用方 → 调用方**重试整个事务**（新快照 → 走更新分支）。
      //    非事务路径（autocommit）：此时没有快照问题，直接重读并更新即可。
      if (!isDuplicateKeyError(error)) throw error;
      if (manager) throw error;
      const concurrent = await settings.findOne({ where: { key: payload.key } });
      if (!concurrent) throw error;
      concurrent.value = payload.value;
      if (payload.description !== undefined) concurrent.description = payload.description;
      await settings.save(concurrent);
      this.invalidateSettingCaches();
      return concurrent;
    }
  }

  /** 设置项变了 → 公开设置缓存失效（写操作主动失效，不等 TTL）。 */
  private invalidateSettingCaches(): void {
    this.cache.delete(CacheKeys.publicSettings);
  }

  /**
   * 资讯视图。
   *
   * ⚠️ `excerpt=true` 时 `body` 只返回**摘要**（公开列表用，见 `listArticles`）。
   */
  private toArticleView(article: Article, excerpt = false): ArticleView {
    return {
      id: article.id,
      categoryId: article.categoryId,
      categoryName: article.category?.name ?? null,
      title: article.title,
      summary: article.summary,
      body: excerpt ? toBodyExcerpt(article.body) : article.body,
      coverMediaId: article.coverMediaId,
      status: article.status,
      publishedAt: article.publishedAt,
      viewCount: article.viewCount,
      createdAt: article.createdAt,
      updatedAt: article.updatedAt,
    };
  }

  /**
   * 公告视图。
   *
   * ⚠️ `excerpt=true` 时 `body` 只返回**摘要**（公开列表用，见 `listNotices`）。
   */
  private toNoticeView(notice: Notice, excerpt = false): NoticeView {
    return {
      id: notice.id,
      title: notice.title,
      body: excerpt ? toBodyExcerpt(notice.body) : notice.body,
      status: notice.status,
      publishedAt: notice.publishedAt,
      viewCount: notice.viewCount,
      createdAt: notice.createdAt,
      updatedAt: notice.updatedAt,
    };
  }
}
