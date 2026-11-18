/** 站内通知服务：列表、详情、已读状态。 */

import { ApiPaths } from './paths';
import { get, post } from './request';
import type { NotificationDto, NotificationUnreadCount, PageResult } from '../types/index';

/** 通知列表（分页） */
export function listNotifications(
  params: { page?: number; pageSize?: number } = {},
): Promise<PageResult<NotificationDto>> {
  return get<PageResult<NotificationDto>>(ApiPaths.meNotifications, {
    page: params.page,
    pageSize: params.pageSize,
  });
}

/** 通知详情 */
export function getNotification(id: number): Promise<NotificationDto> {
  return get<NotificationDto>(ApiPaths.notificationItem(id));
}

/** 标记单条已读 */
export function markNotificationRead(id: number): Promise<{ id: number; read: boolean }> {
  return post<{ id: number; read: boolean }>(ApiPaths.notificationRead(id));
}

/** 全部标记已读 */
export function markAllNotificationsRead(): Promise<{ updated: number }> {
  return post<{ updated: number }>(ApiPaths.notificationReadAll);
}

/** 未读通知数量 */
export function fetchUnreadCount(): Promise<NotificationUnreadCount> {
  return get<NotificationUnreadCount>(ApiPaths.notificationUnreadCount);
}
