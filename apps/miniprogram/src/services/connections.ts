/** 连接服务：联系申请、已建立联系、联系方式授权。 */

import { ApiPaths } from './paths';
import { get, post, put } from './request';
import type { ConnectionPairDto, ConnectionRequestDto, PageResult } from '../types';

/** 我发出的 / 收到的联系申请 */
export function listMyConnectionRequests(params: {
  page?: number;
  pageSize?: number;
  direction?: 'incoming' | 'outgoing';
} = {}): Promise<PageResult<ConnectionRequestDto>> {
  return get<PageResult<ConnectionRequestDto>>(ApiPaths.meConnectionRequests, {
    page: params.page,
    pageSize: params.pageSize,
    direction: params.direction,
  });
}

/** 连接申请详情 */
export function getConnectionRequest(id: number): Promise<ConnectionRequestDto> {
  return get<ConnectionRequestDto>(ApiPaths.connectionRequestItem(id));
}

/** 发起联系申请 */
export function createConnectionRequest(body: { targetUserId: number; message: string }): Promise<ConnectionRequestDto> {
  return post<ConnectionRequestDto>(ApiPaths.connectionRequests, body);
}

/** 接受联系申请 */
export function acceptConnectionRequest(id: number): Promise<ConnectionRequestDto> {
  return post<ConnectionRequestDto>(ApiPaths.connectionRequestAccept(id));
}

/** 拒绝联系申请 */
export function rejectConnectionRequest(id: number): Promise<ConnectionRequestDto> {
  return post<ConnectionRequestDto>(ApiPaths.connectionRequestReject(id));
}

/** 取消联系申请 */
export function cancelConnectionRequest(id: number): Promise<ConnectionRequestDto> {
  return post<ConnectionRequestDto>(ApiPaths.connectionRequestCancel(id));
}

/** 已建立的连接 */
export function listConnections(params: { page?: number; pageSize?: number } = {}): Promise<PageResult<ConnectionPairDto>> {
  return get<PageResult<ConnectionPairDto>>(ApiPaths.meConnections, {
    page: params.page,
    pageSize: params.pageSize,
  });
}

/** 连接详情 */
export function getConnection(id: number): Promise<ConnectionPairDto> {
  return get<ConnectionPairDto>(ApiPaths.connectionItem(id));
}

/** 授权 / 撤回我的联系方式共享 */
export function grantContact(id: number, allow: boolean): Promise<ConnectionPairDto> {
  return put<ConnectionPairDto>(ApiPaths.connectionContactGrant(id), { allow });
}
