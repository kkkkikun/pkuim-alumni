/** 活动与报名服务。 */

import { ApiPaths } from './paths';
import { get, post } from './request';
import type { EventDto, EventRegistrationDto, PageResult } from '../types';

export interface EventListQuery {
  regionCode?: string;
  keyword?: string;
  page?: number;
  pageSize?: number;
}

/** 活动列表 */
export function listEvents(query: EventListQuery = {}): Promise<PageResult<EventDto>> {
  return get<PageResult<EventDto>>(ApiPaths.events, {
    regionCode: query.regionCode,
    keyword: query.keyword,
    page: query.page,
    pageSize: query.pageSize,
  });
}

/** 活动详情 */
export function getEvent(id: number): Promise<EventDto> {
  return get<EventDto>(ApiPaths.eventItem(id));
}

/** 活动报名 */
export function registerEvent(id: number, note?: string): Promise<EventRegistrationDto> {
  return post<EventRegistrationDto>(ApiPaths.eventRegister(id), { note: note || '' });
}

/** 我的活动报名记录 */
export function listMyEvents(params: { page?: number; pageSize?: number } = {}): Promise<PageResult<EventDto>> {
  return get<PageResult<EventDto>>(ApiPaths.meEvents, { page: params.page, pageSize: params.pageSize });
}
