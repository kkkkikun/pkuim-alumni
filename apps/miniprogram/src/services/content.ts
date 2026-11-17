/** 内容服务：校友资讯与通知公告。 */

import { ApiPaths } from './paths';
import { get } from './request';
import type { ArticleDto, NoticeDto, PageResult } from '../types';

export interface ArticleListQuery {
  categoryId?: number;
  keyword?: string;
  page?: number;
  pageSize?: number;
}

/** 资讯列表 */
export function listArticles(query: ArticleListQuery = {}): Promise<PageResult<ArticleDto>> {
  return get<PageResult<ArticleDto>>(ApiPaths.articles, {
    categoryId: query.categoryId,
    keyword: query.keyword,
    page: query.page,
    pageSize: query.pageSize,
  });
}

/** 资讯详情 */
export function getArticle(id: number): Promise<ArticleDto> {
  return get<ArticleDto>(ApiPaths.articleItem(id));
}

export interface NoticeListQuery {
  page?: number;
  pageSize?: number;
}

/** 公告列表 */
export function listNotices(query: NoticeListQuery = {}): Promise<PageResult<NoticeDto>> {
  return get<PageResult<NoticeDto>>(ApiPaths.notices, { page: query.page, pageSize: query.pageSize });
}

/** 公告详情 */
export function getNotice(id: number): Promise<NoticeDto> {
  return get<NoticeDto>(ApiPaths.noticeItem(id));
}
