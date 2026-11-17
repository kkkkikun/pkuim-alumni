/** 资源与需求服务。 */

import { ApiPaths } from './paths';
import { get, post } from './request';
import type { CreateResourceBody, PageResult, ResourcePostDto, ResourceType } from '../types';

export interface ResourceListQuery {
  type?: ResourceType | 'all';
  industryCode?: string;
  regionCode?: string;
  page?: number;
  pageSize?: number;
}

/** 资源与需求列表 */
export function listResources(query: ResourceListQuery = {}): Promise<PageResult<ResourcePostDto>> {
  return get<PageResult<ResourcePostDto>>(ApiPaths.resources, {
    type: query.type && query.type !== 'all' ? query.type : undefined,
    industryCode: query.industryCode,
    regionCode: query.regionCode,
    page: query.page,
    pageSize: query.pageSize,
  });
}

/** 资源 / 需求详情 */
export function getResource(id: number): Promise<ResourcePostDto> {
  return get<ResourcePostDto>(ApiPaths.resourceItem(id));
}

/** 发布资源或需求 */
export function createResource(body: CreateResourceBody): Promise<ResourcePostDto> {
  return post<ResourcePostDto>(ApiPaths.resources, body);
}

/** 提交审核 */
export function submitResource(id: number): Promise<ResourcePostDto> {
  return post<ResourcePostDto>(ApiPaths.resourceSubmit(id));
}

/** 撤回发布 */
export function withdrawResource(id: number): Promise<ResourcePostDto> {
  return post<ResourcePostDto>(ApiPaths.resourceWithdraw(id));
}

/** 我发布的资源与需求 */
export function listMyResources(params: { page?: number; pageSize?: number } = {}): Promise<PageResult<ResourcePostDto>> {
  return get<PageResult<ResourcePostDto>>(ApiPaths.meResources, {
    page: params.page,
    pageSize: params.pageSize,
  });
}
