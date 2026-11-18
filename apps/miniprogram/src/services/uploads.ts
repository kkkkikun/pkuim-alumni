/**
 * 文件上传服务。
 *
 * 流程：创建媒体资源 → 获取直传地址 → wx.uploadFile 直传对象存储 →
 * 得到 mediaId 用于提交认证材料。
 *
 * ⚠️ 演示模式（`DATA_MODE === 'demo'`）下**不做任何真实上传**：
 *   `wx.uploadFile` 是**绕过请求层**的直连调用（对象存储直传），
 *   如果让它跑，演示版在「选照片 → 提交认证申请」这一步必然失败
 *   （直传地址是 `demo://upload-not-supported` 这种假地址）。
 *   所以这里直接返回登记好的资源 id，**模拟上传成功** ——
 *   演示版要能把「上传认证材料」这条流程**完整走完**。
 */

import { DATA_MODE } from '../config/index';
import { ApiPaths } from './paths';
import { get, post } from './request';
import type { CreateUploadBody, MediaAssetDto, UploadUrlResponse } from '../types/index';

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

  // 演示模式：登记已经完成，直接**模拟上传成功**（不发任何网络请求）。
  if (DATA_MODE === 'demo') {
    return asset;
  }

  // 登记接口已返回直传地址；缺失时回退到单独的取址接口
  const direct = (asset as { uploadUrl?: string }).uploadUrl;
  const targetUrl = direct ? direct : (await getUploadUrl(asset.id)).url;
  if (!targetUrl) {
    throw new Error('未获取到上传地址');
  }
  await uploadToUrl(targetUrl, filePath);
  return asset;
}
