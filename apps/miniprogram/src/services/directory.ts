/** 通讯录服务：校友列表与个人主页。 */

import { ApiPaths } from './paths';
import { get } from './request';
import type { DirectoryEntry, PageResult } from '../types/index';

export interface DirectoryListQuery {
  keyword?: string;
  regionCode?: string;
  industryCode?: string;
  graduationYear?: number;
  page?: number;
  pageSize?: number;
}

/** 校友列表 */
export function listDirectory(query: DirectoryListQuery = {}): Promise<PageResult<DirectoryEntry>> {
  return get<PageResult<DirectoryEntry>>(ApiPaths.directory, {
    keyword: query.keyword,
    regionCode: query.regionCode,
    industryCode: query.industryCode,
    graduationYear: query.graduationYear,
    page: query.page,
    pageSize: query.pageSize,
  });
}

/** 通讯录条目（公开投影） */
export function getDirectoryEntry(userId: number): Promise<DirectoryEntry> {
  return get<DirectoryEntry>(ApiPaths.directoryItem(userId));
}

/**
 * 校友个人主页资料。
 *
 * 说明：`GET /alumni/:id` 与 `GET /directory/:id` 返回的都是**公开名片投影**
 * （不含 realName / intro / 联系方式等私密字段），两者同构。
 */
export async function getAlumniProfile(userId: number): Promise<DirectoryEntry> {
  try {
    return await get<DirectoryEntry>(ApiPaths.alumniItem(userId));
  } catch (error) {
    return get<DirectoryEntry>(ApiPaths.directoryItem(userId));
  }
}
