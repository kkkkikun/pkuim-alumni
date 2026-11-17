/**
 * 文件上传服务。
 *
 * 流程：创建媒体资源 → 获取直传地址 → wx.uploadFile 直传对象存储 →
 * 得到 mediaId 用于提交认证材料。
 */

import { ApiPaths } from './paths';
import { get, post } from './request';
import type { CreateUploadBody, MediaAssetDto, UploadUrlResponse } from '../types';

/** 创建媒体资源（登记，返回直传地址） */
export function createUpload(body: CreateUploadBody): Promise<MediaAssetDto> {
  return post<MediaAssetDto>(ApiPaths.uploadRecords, body);
}

/** 获取直传地址（intent=upload） */
export function getUploadUrl(id: number): Promise<UploadUrlResponse> {
  return get<UploadUrlResponse>(ApiPaths.uploadUrl(id), { intent: 'upload' });
}

function uploadToUrl(url: string, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url,
      filePath,
      name: 'file',
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`文件上传失败（${res.statusCode}）`));
        }
      },
      fail: (error) => {
        reject(new Error(error.errMsg || '文件上传失败'));
      },
    });
  });
}

/**
 * 上传本地文件，返回媒体资源（其中 id 即 mediaId）。
 */
export async function uploadLocalFile(filePath: string, fileName: string, mimeType: string, size: number): Promise<MediaAssetDto> {
  const asset = await createUpload({ fileName, mimeType, size });
  // 登记接口已返回直传地址；缺失时回退到单独的取址接口
  const direct = (asset as { uploadUrl?: string }).uploadUrl;
  const targetUrl = direct ? direct : (await getUploadUrl(asset.id)).url;
  if (!targetUrl) {
    throw new Error('未获取到上传地址');
  }
  await uploadToUrl(targetUrl, filePath);
  return asset;
}
